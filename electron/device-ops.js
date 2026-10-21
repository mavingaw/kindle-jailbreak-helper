const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, net, shell } = require('electron');
const AdmZip = require('adm-zip');
const tar = require('tar');
const { runPowerShell, runPowerShellJson, psq } = require('./powershell');

const work = (...p) => path.join(app.getPath('userData'), ...p);

// Root-folder update files the guide says to remove (update*.bin, update.partial.bin,
// update.bin.tmp.partial). Only the root is checked, as on the site. Case-sensitive
// on purpose: the jailbreak's own "Update_hotfix_*.bin" must not be deleted.
const UPDATE_FILE = /^update.*\.(bin|partial)$/;
const FILLER_DIR = 'fill_disk';

// ---------- downloads & extraction ----------

async function download(url, fileName, onProgress) {
  const dir = work('downloads');
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest + '.part');
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await new Promise((r) => out.once('drain', r));
    onProgress?.({ got, total });
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  await fsp.rename(dest + '.part', dest);
  return dest;
}

async function extract(archive) {
  const base = path.basename(archive).replace(/\.(zip|tar\.gz|tgz)$/i, '');
  const dest = work('extracted', base);
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  if (/\.zip$/i.test(archive)) new AdmZip(archive).extractAllTo(dest, true);
  else if (/\.(tar\.gz|tgz)$/i.test(archive)) await tar.x({ file: archive, cwd: dest });
  else throw new Error(`Unknown archive type: ${archive}`);
  return dest;
}

// ---------- MTP (Windows shell) helpers ----------

const MTP_PRELUDE = `
$shell = New-Object -ComObject Shell.Application
$dev = $shell.Namespace(17).Items() | Where-Object { $_.Path -match 'vid_1949' } | Select-Object -First 1
if (-not $dev) { throw 'Kindle (MTP) not found' }
$storage = $dev.GetFolder.Items() | Select-Object -First 1
$root = $storage.GetFolder
function Get-Sub($folder, $parts) {
  foreach ($p in $parts) {
    if (-not $p) { continue }
    $item = $folder.Items() | Where-Object { $_.Name -eq $p } | Select-Object -First 1
    if (-not $item) { throw "Folder '$p' not found on the Kindle" }
    $folder = $item.GetFolder
  }
  return $folder
}
function Count-Mtp($item) {
  if (-not $item.IsFolder) { return 1 }
  $n = 0
  foreach ($c in $item.GetFolder.Items()) { $n += Count-Mtp $c }
  return $n
}
`;

async function mtpListRoot() {
  const list = await runPowerShellJson(`${MTP_PRELUDE}
@($root.Items() | ForEach-Object { [pscustomobject]@{ Name = $_.Name; IsFolder = $_.IsFolder } }) | ConvertTo-Json -Compress`);
  return list ? (Array.isArray(list) ? list : [list]) : [];
}

function countLocal(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return 1;
  return fs.readdirSync(p).reduce((n, c) => n + countLocal(path.join(p, c)), 0);
}

// CopyHere is asynchronous and dies with the PowerShell process, so wait until
// every file has shown up on the device.
async function mtpCopy(sources, destSub) {
  const parts = destSub ? destSub.split(/[\\/]/) : [];
  const items = sources.map((s) => `@{ Path = ${psq(s)}; Name = ${psq(path.basename(s))}; Count = ${countLocal(s)} }`);
  await runPowerShell(
    `${MTP_PRELUDE}
$target = Get-Sub $root @(${parts.map(psq).join(',')})
foreach ($s in @(${items.join(',')})) {
  $target.CopyHere($s.Path, 16 + 4 + 1024)
  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $it = $target.Items() | Where-Object { $_.Name -eq $s.Name } | Select-Object -First 1
    if ($it -and (Count-Mtp $it) -ge $s.Count) { break }
  }
  if ((Get-Date) -ge $deadline) { throw "Timed out copying $($s.Name)" }
}
Start-Sleep -Seconds 2
'ok'`,
    { timeout: 15 * 60 * 1000 }
  );
}

// ---------- device operations ----------

function requireMassStorage(device, what) {
  if (device?.mode !== 'mass-storage' || !device.root) {
    throw new Error(`${what} needs the Kindle to show up as a USB drive. On MTP Kindles, do this step by hand in File Explorer.`);
  }
}

async function copyToKindle(device, sourceDir, destSub, onLog) {
  const entries = (await fsp.readdir(sourceDir)).map((n) => path.join(sourceDir, n));
  if (device.mode === 'mass-storage') {
    const destDir = path.join(device.root, destSub || '');
    await fsp.mkdir(destDir, { recursive: true });
    for (const src of entries) {
      onLog?.(`Copying ${path.basename(src)} → ${path.join(destDir, path.basename(src))}`);
      await fsp.cp(src, path.join(destDir, path.basename(src)), { recursive: true, force: true });
    }
  } else if (device.mode === 'mtp') {
    onLog?.(`Copying ${entries.map((e) => path.basename(e)).join(', ')} over MTP (Windows may show a copy dialog)…`);
    await mtpCopy(entries, destSub);
  } else {
    throw new Error('No Kindle storage found. Plug the Kindle in and make sure it shows up in File Explorer.');
  }
  onLog?.('Copy finished.');
}

async function listUpdateFiles(device) {
  if (device.mode === 'mass-storage') {
    return (await fsp.readdir(device.root)).filter((n) => UPDATE_FILE.test(n));
  }
  if (device.mode === 'mtp') {
    return (await mtpListRoot()).filter((i) => !i.IsFolder && UPDATE_FILE.test(i.Name)).map((i) => i.Name);
  }
  return [];
}

async function removeUpdateFiles(device) {
  requireMassStorage(device, 'Removing update files');
  const files = await listUpdateFiles(device);
  for (const f of files) await fsp.rm(path.join(device.root, f), { force: true });
  return files;
}

function freeBytes(root) {
  const st = fs.statfsSync(root);
  return st.bavail * st.bsize;
}

let fillCancel = false;

// Fill the drive with zero files until about targetMB is left, so an OTA update
// cannot download. Files go into fill_disk/ (same name as the site's filler
// script) and stay under 1 GB each for FAT32.
async function fillStorage(device, targetMB, onProgress) {
  requireMassStorage(device, 'Filling storage');
  fillCancel = false;
  const dir = path.join(device.root, FILLER_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const target = targetMB * 1024 * 1024;
  const block = Buffer.alloc(4 * 1024 * 1024);
  const startFree = freeBytes(device.root);
  // Continue after the highest existing number so earlier files are never overwritten.
  let index =
    (await fsp.readdir(dir)).reduce((max, n) => Math.max(max, Number(/^fill_(\d+)\.bin$/.exec(n)?.[1] ?? -1)), -1) + 1;

  // Kindles write slowly over USB (a PW4 manages ~4 MB/s, and Windows' FAT32
  // driver zero-fills even preallocated files), so report speed and time left.
  const started = Date.now();
  let totalWritten = 0;
  const samples = [{ t: started, w: 0 }];
  const report = (free, extra) => {
    const now = Date.now();
    samples.push({ t: now, w: totalWritten });
    while (samples.length > 2 && now - samples[0].t > 30000) samples.shift();
    const dt = (now - samples[0].t) / 1000;
    const rate = dt > 0 ? (totalWritten - samples[0].w) / dt : 0;
    const left = Math.max(0, free - target);
    onProgress?.({ free, startFree, target, written: totalWritten, rate, eta: rate > 0 ? left / rate : null, elapsed: (now - started) / 1000, ...extra });
  };

  while (!fillCancel) {
    const free = freeBytes(device.root);
    report(free);
    const want = Math.min(1024 * 1024 * 1024, free - target);
    if (want < 1024 * 1024) break;
    const file = path.join(dir, `fill_${String(index++).padStart(4, '0')}.bin`);
    const fh = await fsp.open(file, 'w');
    try {
      let written = 0;
      let lastReport = Date.now();
      while (written < want && !fillCancel) {
        const n = Math.min(block.length, want - written);
        await fh.write(block, 0, n);
        written += n;
        totalWritten += n;
        if (Date.now() - lastReport > 1500) {
          lastReport = Date.now();
          report(free - written);
        }
      }
    } catch (e) {
      if (e.code !== 'ENOSPC') throw e;
    } finally {
      await fh.close();
    }
  }
  const free = freeBytes(device.root);
  report(free, { done: true, cancelled: fillCancel });
  return { free, cancelled: fillCancel };
}

function cancelFill() {
  fillCancel = true;
}

async function fillerInfo(device) {
  if (device?.mode !== 'mass-storage') return { exists: false };
  const dir = path.join(device.root, FILLER_DIR);
  if (!fs.existsSync(dir)) return { exists: false };
  const files = await fsp.readdir(dir);
  let bytes = 0;
  for (const f of files) bytes += (await fsp.stat(path.join(dir, f))).size;
  return { exists: true, files: files.length, bytes };
}

async function removeFiller(device) {
  requireMassStorage(device, 'Removing filler files');
  await fsp.rm(path.join(device.root, FILLER_DIR), { recursive: true, force: true });
}

// AdBreak: copy system/.assets off the Kindle, add AdBreak's files, overwrite
// every details.html with adbreak.html (what replace.bat does), then replace
// the Kindle's .assets with the patched copy. A backup of the original is kept.
async function adbreakPatch(device, adbreakDir, onLog) {
  requireMassStorage(device, 'Patching .assets');
  const src = path.join(device.root, 'system', '.assets');
  if (!fs.existsSync(src)) {
    throw new Error('system/.assets was not found on the Kindle. Make sure ads have downloaded and you opened "View all ads".');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = work('backups', `assets-${stamp}`);
  const patched = work('extracted', 'assets-patched');

  onLog?.(`Backing up the Kindle's .assets → ${backup}`);
  await fsp.cp(src, backup, { recursive: true });
  await fsp.rm(patched, { recursive: true, force: true });
  await fsp.cp(src, patched, { recursive: true });

  for (const f of await fsp.readdir(adbreakDir)) {
    if (f.toLowerCase() === 'replace.bat') continue;
    await fsp.cp(path.join(adbreakDir, f), path.join(patched, f), { recursive: true, force: true });
  }

  const html = await fsp.readFile(path.join(adbreakDir, 'adbreak.html'));
  let replaced = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name === 'details.html') {
        await fsp.writeFile(p, html);
        replaced++;
      }
    }
  };
  await walk(patched);
  onLog?.(`Replaced ${replaced} details.html file(s).`);
  if (replaced === 0) {
    throw new Error('No details.html found in .assets. Ads have probably not downloaded yet. Nothing on the Kindle was changed.');
  }

  onLog?.('Replacing .assets on the Kindle…');
  await fsp.rm(src, { recursive: true, force: true });
  await fsp.cp(patched, src, { recursive: true });
  onLog?.('Done. jb.sh is now in system/.assets.');
  return { replaced, backup };
}

function launchExe(dir, exe) {
  const full = path.join(dir, exe);
  if (!fs.existsSync(full)) throw new Error(`${exe} not found in ${dir}`);
  spawn('cmd.exe', ['/c', 'start', '""', '/D', dir, exe], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false }).unref();
}

async function openKindleFolder(device) {
  if (device?.mode === 'mass-storage') return shell.openPath(device.root);
  // "This PC", where MTP devices are listed.
  spawn('explorer.exe', ['shell:MyComputerFolder'], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = {
  download,
  extract,
  copyToKindle,
  listUpdateFiles,
  removeUpdateFiles,
  fillStorage,
  cancelFill,
  fillerInfo,
  removeFiller,
  adbreakPatch,
  launchExe,
  openKindleFolder,
  work,
};
