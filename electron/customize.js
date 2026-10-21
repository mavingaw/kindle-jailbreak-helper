const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { net, nativeImage } = require('electron');
const AdmZip = require('adm-zip');
const ops = require('./device-ops');
const { installedPackageVersion } = require('./koreader');

// Customise a jailbroken Kindle over USB: KOReader home-screen plugins, fonts,
// sleep-screen images and dictionaries. Everything here is plain file copying
// into folders KOReader / the Kindle read, so it is safe and reversible.

// Home-screen plugins for KOReader. Only one may be active at a time.
const HOME_UIS = [
  {
    id: 'projecttitle',
    name: 'Project: Title',
    repo: 'joshuacant/ProjectTitle',
    folder: 'projecttitle.koplugin',
    asset: /^ProjectTitle-.*\.zip$/,
    blurb: 'Bookshelf-style library with large covers, progress bars and a clean title bar. The one from the Dammit Jeff video.',
    coverBrowserOff: true,
  },
  {
    id: 'simpleui',
    name: 'Simple UI',
    repo: 'doctorhetfield-cmd/simpleui.koplugin',
    folder: 'simpleui.koplugin',
    asset: /^simpleui\.koplugin\.zip$/,
    blurb: 'A home screen with a bottom tab bar, recent books and a wallpaper. Starts on the home screen by default.',
  },
  {
    id: 'zenos',
    name: 'ZenOS',
    repo: 'xZenLabs/zen-os',
    folder: 'zenos.koplugin',
    asset: /^zenos\.koplugin\.zip$/,
    blurb: 'A minimal, distraction-free interface for KOReader. Needs KOReader 2026.03 or newer.',
    minKOReader: 202603000000,
  },
];
// Plugins switched off by this app are parked here; KOReader only loads plugins/.
const PARKED = 'plugins-off';

// Screen sizes for sleep-screen images, by model nickname (portrait).
const SCREENS = {
  KT4: [600, 800], KT5: [600, 800], PW: [758, 1024], PW2: [758, 1024], KV: [1072, 1448], PW3: [1072, 1448],
  PW4: [1072, 1448], KOA: [1072, 1448], KOA2: [1264, 1680], KOA3: [1264, 1680], KT6: [1072, 1448],
  PW5: [1236, 1648], KS: [1236, 1648], PW6: [1264, 1680], KS2: [1236, 1648], CS: [1264, 1680],
};
const DEFAULT_SCREEN = [1072, 1448];

const P = (root, ...p) => path.join(root, ...p);
const exists = (p) => fs.existsSync(p);

function requireDrive(device) {
  if (device?.mode !== 'mass-storage' || !device.root || !exists(P(device.root, 'documents'))) {
    throw new Error('Connect the Kindle as a USB drive first. Close KOReader on the Kindle before plugging it in.');
  }
}
function requireKOReader(root) {
  if (!exists(P(root, 'koreader', 'koreader.sh'))) throw new Error('KOReader is not installed. Install it on the Check my Kindle tab first.');
}

// KOReader's own normalisation (frontend/version.lua): v2026.07.1 → 202607010000.
function normalizedKOReaderVersion(root) {
  try {
    const rev = fs.readFileSync(P(root, 'koreader', 'git-rev'), 'utf8').trim();
    const m = /^v?(\d{4})\.(\d{2})(?:\.(\d+))?(?:-(\d+))?/.exec(rev);
    if (!m) return null;
    return Number(m[1]) * 1e8 + Number(m[2]) * 1e6 + Number(m[3] || 0) * 1e4 + Number(m[4] || 0);
  } catch {
    return null;
  }
}

function pluginVersion(dir) {
  try {
    return /version\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(dir, '_meta.lua'), 'utf8'))?.[1] || null;
  } catch {
    return null;
  }
}

// ---------- KOReader settings (settings.reader.lua) ----------

// Minimal, targeted edit of the top-level plugins_disabled table. KOReader
// writes this file itself with 4-space indents and sorted ["key"] entries.
function setPluginDisabled(text, plugin, disabled) {
  const value = disabled ? 'true' : 'false';
  const block = /\n    \["plugins_disabled"\] = \{\n([\s\S]*?)\n    \},/;
  const m = block.exec(text);
  if (m) {
    const lines = m[1].split('\n').filter((l) => !l.includes(`["${plugin}"]`));
    lines.push(`        ["${plugin}"] = ${value},`);
    return text.replace(block, `\n    ["plugins_disabled"] = {\n${lines.filter(Boolean).join('\n')}\n    },`);
  }
  if (/\["plugins_disabled"\]\s*=\s*\{\s*\}/.test(text)) {
    return text.replace(/\["plugins_disabled"\]\s*=\s*\{\s*\}/, `["plugins_disabled"] = {\n        ["${plugin}"] = ${value},\n    }`);
  }
  if (!/^return \{$/m.test(text)) throw new Error('KOReader settings file has an unexpected format.');
  return text.replace(/^return \{$/m, `return {\n    ["plugins_disabled"] = {\n        ["${plugin}"] = ${value},\n    },`);
}

async function editKOReaderSettings(root, edit, log) {
  const file = P(root, 'koreader', 'settings.reader.lua');
  if (!exists(file)) {
    // KOReader has never run; create the minimal file it would accept.
    await fsp.writeFile(file, edit('-- ./settings.reader.lua\nreturn {\n}\n'));
    return;
  }
  const before = await fsp.readFile(file, 'utf8');
  const backup = ops.work('backups', `settings.reader-${new Date().toISOString().replace(/[:.]/g, '-')}.lua`);
  await fsp.mkdir(path.dirname(backup), { recursive: true });
  await fsp.writeFile(backup, before);
  const after = edit(before);
  if (after !== before) {
    await fsp.writeFile(file, after);
    log?.(`Updated KOReader settings (backup: ${backup}).`);
  }
}

function coverBrowserDisabled(root) {
  try {
    const t = fs.readFileSync(P(root, 'koreader', 'settings.reader.lua'), 'utf8');
    const block = /\n    \["plugins_disabled"\] = \{\n([\s\S]*?)\n    \},/.exec(t)?.[1] || '';
    return /\["coverbrowser"\] = true/.test(block);
  } catch {
    return false;
  }
}

// ---------- GitHub releases without the rate-limited API ----------

async function latestRelease(repo, assetPattern) {
  // /releases/latest redirects to /releases/tag/<tag>. Electron's net.fetch
  // can't stop at a redirect, so use Node's fetch to read the Location header.
  const r = await fetch(`https://github.com/${repo}/releases/latest`, { method: 'HEAD', redirect: 'manual' });
  const tag = decodeURIComponent(/\/releases\/tag\/([^?#]+)/.exec(r.headers.get('location') || '')?.[1] || '');
  if (!tag) throw new Error(`Could not find the latest release of ${repo}.`);
  const html = await (await net.fetch(`https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`)).text();
  const links = [...html.matchAll(/href="([^"]+\/releases\/download\/[^"]+)"/g)].map((m) => m[1]);
  const url = links.find((l) => assetPattern.test(decodeURIComponent(l.split('/').pop())));
  if (!url) throw new Error(`No matching download in ${repo} ${tag}.`);
  return { tag, url: `https://github.com${url}`, file: decodeURIComponent(url.split('/').pop()) };
}

// ---------- status ----------

async function status(device) {
  if (device?.mode !== 'mass-storage' || !device.root || !exists(P(device.root, 'documents'))) {
    return { ready: false, reason: device?.mode === 'mtp' ? 'Customising needs a Kindle that shows up as a USB drive.' : 'Connect the Kindle first.' };
  }
  const root = device.root;
  const koreader = exists(P(root, 'koreader', 'koreader.sh'));
  const kv = koreader ? normalizedKOReaderVersion(root) : null;
  const uis = HOME_UIS.map((u) => {
    const active = P(root, 'koreader', 'plugins', u.folder);
    const parked = P(root, 'koreader', PARKED, u.folder);
    return {
      id: u.id,
      name: u.name,
      blurb: u.blurb,
      active: exists(active),
      parked: exists(parked),
      version: pluginVersion(exists(active) ? active : parked),
      tooOld: u.minKOReader && kv ? kv < u.minKOReader : false,
    };
  });
  const fonts = (await ls(P(root, 'fonts'))).filter((n) => /\.(ttf|otf)$/i.test(n));
  const koFonts = koreader ? (await ls(P(root, 'koreader', 'fonts'))).filter((n) => /\.(ttf|otf)$/i.test(n) && !n.startsWith('._')) : [];
  const sleep = (await ls(P(root, 'screensavers'))).filter((n) => /\.(png|jpe?g)$/i.test(n));
  const dicts = koreader ? (await ls(P(root, 'koreader', 'data', 'dict'))).filter((n) => !n.startsWith('.')) : [];
  return {
    ready: true,
    koreader,
    koreaderVersion: koreader ? installedPackageVersion(root) || fs.readFileSync(P(root, 'koreader', 'git-rev'), 'utf8').trim() : null,
    uis,
    coverBrowserOff: koreader && coverBrowserDisabled(root),
    fonts,
    koFonts: koFonts.length,
    sleep,
    screen: SCREENS[device.modelInfo?.model] || DEFAULT_SCREEN,
    dicts,
  };
}

async function ls(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

// ---------- home screen ----------

async function parkOthers(root, keepId, log) {
  for (const u of HOME_UIS) {
    if (u.id === keepId) continue;
    const src = P(root, 'koreader', 'plugins', u.folder);
    if (!exists(src)) continue;
    const dst = P(root, 'koreader', PARKED, u.folder);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rm(dst, { recursive: true, force: true });
    await fsp.rename(src, dst);
    log(`Switched off ${u.name} (kept in koreader/${PARKED}).`);
  }
}

async function installHomeUI(device, id, log) {
  requireDrive(device);
  const root = device.root;
  requireKOReader(root);
  const ui = HOME_UIS.find((u) => u.id === id);
  if (!ui) throw new Error(`Unknown home screen: ${id}`);
  const kv = normalizedKOReaderVersion(root);
  if (ui.minKOReader && kv && kv < ui.minKOReader) throw new Error(`${ui.name} needs a newer KOReader. Update KOReader on the Check my Kindle tab first.`);

  log(`Finding the latest ${ui.name} release…`);
  const rel = await latestRelease(ui.repo, ui.asset);
  log(`Downloading ${ui.name} ${rel.tag}…`);
  const zipFile = await ops.download(rel.url, rel.file);
  const stage = ops.work('extracted', `ui-${id}`);
  await fsp.rm(stage, { recursive: true, force: true });
  new AdmZip(zipFile).extractAllTo(stage, true);
  const src = path.join(stage, ui.folder);
  if (!exists(path.join(src, '_meta.lua'))) throw new Error(`${rel.file} does not contain ${ui.folder}.`);

  // Project: Title refuses to load on KOReader versions it hasn't been tested
  // with; read its own list so we can say so before copying anything.
  if (id === 'projecttitle' && kv) {
    const main = await fsp.readFile(path.join(src, 'main.lua'), 'utf8');
    const safe = [...(/safe_versions\s*=\s*\{([^}]*)\}/.exec(main)?.[1] || '').matchAll(/\d{12}/g)].map((m) => Number(m[0]));
    if (safe.length && !safe.includes(kv)) {
      const fmt = (n) => `${Math.floor(n / 1e8)}.${String(Math.floor(n / 1e6) % 100).padStart(2, '0')}${Math.floor(n / 1e4) % 100 ? '.' + (Math.floor(n / 1e4) % 100) : ''}`;
      throw new Error(`${ui.name} ${rel.tag} only works with KOReader ${safe.map(fmt).join(', ')}. Your Kindle has ${fmt(kv)}. Update KOReader on the Check my Kindle tab first.`);
    }
  }

  await parkOthers(root, id, log);
  const dst = P(root, 'koreader', 'plugins', ui.folder);
  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.rm(P(root, 'koreader', PARKED, ui.folder), { recursive: true, force: true });
  log(`Copying ${ui.folder} to the Kindle…`);
  await fsp.cp(src, dst, { recursive: true });

  await editKOReaderSettings(root, (t) => setPluginDisabled(t, 'coverbrowser', !!ui.coverBrowserOff), log);
  log(`${ui.name} ${rel.tag} installed. Eject the Kindle and start KOReader.`);
  return { name: ui.name, version: rel.tag };
}

// Back to KOReader's normal file browser.
async function resetHomeUI(device, log) {
  requireDrive(device);
  requireKOReader(device.root);
  await parkOthers(device.root, null, log);
  await editKOReaderSettings(device.root, (t) => setPluginDisabled(t, 'coverbrowser', false), log);
  log('Back to the standard KOReader library (Cover Browser on).');
}

// ---------- fonts ----------

async function installFonts(device, files, targets, log) {
  requireDrive(device);
  const root = device.root;
  const dirs = [];
  if (targets.includes('kindle')) dirs.push(P(root, 'fonts'));
  if (targets.includes('koreader')) {
    requireKOReader(root);
    dirs.push(P(root, 'koreader', 'fonts'));
  }
  let n = 0;
  for (const f of files.filter((f) => /\.(ttf|otf)$/i.test(f))) {
    for (const d of dirs) {
      await fsp.mkdir(d, { recursive: true });
      await fsp.copyFile(f, path.join(d, path.basename(f)));
    }
    n++;
  }
  log(`Copied ${n} font file(s) to ${dirs.map((d) => path.relative(root, d)).join(' and ')}.`);
  return n;
}

async function removeFont(device, name) {
  requireDrive(device);
  if (path.basename(name) !== name) throw new Error('Bad font name.');
  await fsp.rm(P(device.root, 'fonts', name), { force: true });
  await fsp.rm(P(device.root, 'koreader', 'fonts', name), { force: true });
}

// ---------- sleep screen images ----------

// Crop to fill the screen, resize to its exact pixels, save as PNG.
async function addSleepImages(device, files, log) {
  requireDrive(device);
  const [w, h] = SCREENS[device.modelInfo?.model] || DEFAULT_SCREEN;
  const dir = P(device.root, 'screensavers');
  await fsp.mkdir(dir, { recursive: true });
  let n = 0;
  for (const f of files) {
    const img = nativeImage.createFromPath(f);
    if (img.isEmpty()) {
      log(`Skipped ${path.basename(f)} (not an image Windows can read).`);
      continue;
    }
    const { width, height } = img.getSize();
    const scale = Math.max(w / width, h / height);
    const cw = Math.round(w / scale);
    const ch = Math.round(h / scale);
    const cropped = img.crop({ x: Math.round((width - cw) / 2), y: Math.round((height - ch) / 2), width: cw, height: ch });
    const out = cropped.resize({ width: w, height: h, quality: 'best' });
    const name = path.basename(f).replace(/\.[^.]+$/, '') + '.png';
    await fsp.writeFile(path.join(dir, name), out.toPNG());
    n++;
  }
  log(`Added ${n} image(s) to screensavers/ at ${w}×${h}.`);
  return n;
}

async function removeSleepImage(device, name) {
  requireDrive(device);
  if (path.basename(name) !== name) throw new Error('Bad file name.');
  await fsp.rm(P(device.root, 'screensavers', name), { force: true });
}

// ---------- dictionaries (StarDict, for KOReader) ----------

const STARDICT = /\.(ifo|idx|dict|dz|syn|idx\.gz|dict\.dz)$/i;

async function installDictionaries(device, files, log) {
  requireDrive(device);
  requireKOReader(device.root);
  // Gather files, unpacking zips, then group by their .ifo name.
  const stage = ops.work('extracted', 'dicts');
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });
  const all = [];
  for (const f of files) {
    if (/\.zip$/i.test(f)) {
      const sub = path.join(stage, path.basename(f, '.zip'));
      new AdmZip(f).extractAllTo(sub, true);
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.join(d, e.name))));
      walk(sub);
    } else all.push(f);
  }
  const ifos = all.filter((f) => /\.ifo$/i.test(f));
  if (!ifos.length) throw new Error('No StarDict dictionary found. Pick the .ifo, .idx and .dict(.dz) files, or a .zip containing them.');
  const names = [];
  for (const ifo of ifos) {
    const base = path.basename(ifo, path.extname(ifo));
    const parts = all.filter((f) => path.dirname(f) === path.dirname(ifo) && path.basename(f).startsWith(base) && STARDICT.test(f));
    const dst = P(device.root, 'koreader', 'data', 'dict', base);
    await fsp.mkdir(dst, { recursive: true });
    for (const p of parts) await fsp.copyFile(p, path.join(dst, path.basename(p)));
    names.push(base);
    log(`Added dictionary "${base}" (${parts.length} files).`);
  }
  return names;
}

async function removeDictionary(device, name) {
  requireDrive(device);
  if (path.basename(name) !== name) throw new Error('Bad dictionary name.');
  await fsp.rm(P(device.root, 'koreader', 'data', 'dict', name), { recursive: true, force: true });
}

module.exports = {
  HOME_UIS,
  status,
  installHomeUI,
  resetHomeUI,
  installFonts,
  removeFont,
  addSleepImages,
  removeSleepImage,
  installDictionaries,
  removeDictionary,
  latestRelease,
  // exported for tests
  setPluginDisabled,
  normalizedKOReaderVersion,
};
