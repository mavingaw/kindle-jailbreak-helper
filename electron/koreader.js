const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { net } = require('electron');
const tar = require('tar');
const ops = require('./device-ops');
const { compareVersions } = require('./jailbreaks');

// KOReader packaged for KPM by the KindleModding repo (what ";kpm install
// koreader" downloads). Installing from the PC copies the same files to the
// same places as the package's own install.sh:
//   koreader/            → /mnt/us/koreader
//   scriptlets/KOReader.sh → /mnt/us/documents/KOReader.sh
//   extensions/koreader  → /mnt/us/extensions/koreader (only if extensions/ exists, for KUAL)
const REPO = 'KindleModding/repo';
const INDEX = `https://raw.githubusercontent.com/${REPO}/HEAD/manifest.v2.json`;
// Package files are stored with Git LFS, so download through the media host.
const MEDIA = `https://media.githubusercontent.com/media/${REPO}/HEAD/`;

const MARKER = '.kpkg-version.json';

// Package version this app last installed, or null.
function installedPackageVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'koreader', MARKER), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// kindlehf: firmware 5.16.3 and newer (hard-float). kindlepw2: older firmware.
function platformFor(firmware) {
  if (!firmware) return null;
  return compareVersions(firmware, '5.16.3') >= 0 ? 'kindlehf' : 'kindlepw2';
}

// Which build is already on the Kindle, read from the ARM float-ABI flag in
// koreader/luajit's ELF header (EF_ARM_ABI_FLOAT_HARD = 0x400 → kindlehf,
// EF_ARM_ABI_FLOAT_SOFT = 0x200 → kindlepw2). Null if unknown.
function installedPlatform(root) {
  try {
    const fd = fs.openSync(path.join(root, 'koreader', 'luajit'), 'r');
    const b = Buffer.alloc(40);
    fs.readSync(fd, b, 0, 40, 0);
    fs.closeSync(fd);
    if (b.toString('latin1', 1, 4) !== 'ELF' || b.readUInt16LE(18) !== 40) return null;
    const flags = b.readUInt32LE(36);
    if (flags & 0x400) return 'kindlehf';
    if (flags & 0x200) return 'kindlepw2';
  } catch {}
  return null;
}

// The package's scriptlet runs "kpm launch koreader", which only works when KPM
// itself installed KOReader. Installed from the PC, KPM has no record of it,
// so start KOReader directly — what the package's own launch.sh does.
const DIRECT_LAUNCH = 'cd /mnt/us && UNPACK_DIR=/mnt/us sh ./koreader/koreader.sh --asap';
const MINIMAL_SCRIPTLET = `#!/bin/sh\n# Name: KOReader\n# Author: KOReader team\n# DontUseFBInk\n\n${DIRECT_LAUNCH}\n`;

function directScriptlet(packageScriptlet) {
  const text = (packageScriptlet || '').replace(/\r\n/g, '\n');
  if (!/^\/var\/local\/kmc\/bin\/kpm launch koreader.*$/m.test(text)) return MINIMAL_SCRIPTLET;
  return text.replace(/^\/var\/local\/kmc\/bin\/kpm launch koreader.*$/m, DIRECT_LAUNCH);
}

// Scriptlets (.sh files shown as books) only run on the modern jailbreak
// stack; on the older KUAL setup they would show up as broken items.
function supportsScriptlets(root) {
  return fs.existsSync(path.join(root, 'documents', 'JAILBROKEN.txt')) || fs.existsSync(path.join(root, 'jb.sh.log'));
}

// Read the repo's own index (what KPM installs from), newest artifact per platform.
async function listPackages() {
  const res = await net.fetch(INDEX, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not read the KOReader package list (HTTP ${res.status}).`);
  const pkg = ((await res.json()).packages || {}).koreader;
  if (!pkg?.artifacts) throw new Error('The package list has no KOReader entry.');
  const latest = {};
  for (const a of pkg.artifacts) {
    const version = a.version.join('.');
    for (const platform of a.supported_platforms || []) {
      if (!latest[platform] || compareVersions(version, latest[platform].version) > 0) latest[platform] = { version, platform, path: a.url };
    }
  }
  return latest;
}

async function install(device, platform, log) {
  if (!device?.connected || !['mass-storage', 'mtp'].includes(device.mode)) {
    throw new Error('Connect the Kindle first.');
  }
  const pkgs = await listPackages();
  const pkg = pkgs[platform];
  if (!pkg) throw new Error(`No KOReader package for ${platform}. Available: ${Object.keys(pkgs).join(', ') || 'none'}`);

  log(`Downloading KOReader ${pkg.version} (${platform})…`);
  let last = -1;
  const file = await ops.download(MEDIA + pkg.path, path.basename(pkg.path), ({ got, total }) => {
    const pct = total ? Math.floor((got / total) * 10) : -1;
    if (pct !== last) {
      last = pct;
      if (pct >= 0) log(`  ${pct * 10}%`);
    }
  });
  const head = (await fsp.readFile(file)).subarray(0, 64).toString();
  if (head.startsWith('version https://git-lfs')) throw new Error('Got a Git LFS pointer instead of the package. Try again later.');

  const dir = ops.work('extracted', 'koreader-pkg');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  log('Extracting…');
  await tar.x({ file, cwd: dir });
  for (const need of ['koreader/koreader.sh', 'scriptlets/KOReader.sh']) {
    if (!fs.existsSync(path.join(dir, need))) throw new Error(`Package is missing ${need}.`);
  }

  // Lay the files out exactly as they go on the Kindle, then copy in one pass.
  const stage = ops.work('extracted', 'koreader-stage');
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });
  await fsp.rename(path.join(dir, 'koreader'), path.join(stage, 'koreader'));
  // Over MTP the device can't be inspected cheaply; MTP Kindles are new
  // enough to be on the modern stack, so add the scriptlet there.
  const scriptlet = device.mode === 'mtp' || supportsScriptlets(device.root);
  if (scriptlet) {
    await fsp.mkdir(path.join(stage, 'documents'), { recursive: true });
    const pkgScriptlet = await fsp.readFile(path.join(dir, 'scriptlets', 'KOReader.sh'), 'utf8');
    await fsp.writeFile(path.join(stage, 'documents', 'KOReader.sh'), directScriptlet(pkgScriptlet));
  }
  const hasExtensions = device.mode === 'mass-storage' ? fs.existsSync(path.join(device.root, 'extensions')) : false;
  if (hasExtensions && fs.existsSync(path.join(dir, 'extensions', 'koreader'))) {
    await fsp.mkdir(path.join(stage, 'extensions'), { recursive: true });
    await fsp.rename(path.join(dir, 'extensions', 'koreader'), path.join(stage, 'extensions', 'koreader'));
  }

  log('Copying to the Kindle. KOReader has about 2,000 files, so this takes a few minutes over USB…');
  if (device.mode === 'mass-storage') {
    for (const part of await fsp.readdir(stage)) {
      log(`  ${part}/`);
      // Merge like the package's "cp -rf": existing KOReader settings are kept.
      await fsp.cp(path.join(stage, part), path.join(device.root, part), { recursive: true, force: true });
    }
  } else {
    await ops.copyToKindle(device, stage, '', log);
  }
  // The package version (e.g. 2026.7.2) can differ from KOReader's own git-rev
  // (v2026.07.1), so remember what was installed for the update check.
  const marker = JSON.stringify({ package: 'koreader', version: pkg.version, platform, installed: new Date().toISOString() });
  if (device.mode === 'mass-storage') await fsp.writeFile(path.join(device.root, 'koreader', MARKER), marker);
  const where = [scriptlet && '"KOReader" in your library', hasExtensions && 'KUAL'].filter(Boolean).join(' or ');
  log(`KOReader ${pkg.version} installed. On the Kindle, start it from ${where || 'your launcher'}.`);
  return { version: pkg.version, platform, kual: hasExtensions, scriptlet, where };
}

module.exports = { listPackages, install, platformFor, installedPlatform, installedPackageVersion, directScriptlet, supportsScriptlets };
