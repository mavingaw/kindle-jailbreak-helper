const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const ops = require('./device-ops');
const { latestRelease } = require('./customize');

// Universal Hotfix (github.com/KindleModding/Hotfix) for the older setup.
//
// Only offered on the older (hotfix + KUAL) setup. Its installer wipes and
// rebuilds /var/local/kmc, which on the modern setup is where jb.sh put KPM
// and sh_integration — so installing it after the modern upgrade would remove
// them. The modern jailbreak ships its own hotfix pieces instead.

const REPO = 'KindleModding/Hotfix';
const FILE = 'Update_hotfix_universal.bin';
const P = (root, ...p) => path.join(root, ...p);

let cachedLatest = null;
async function latest() {
  if (cachedLatest && Date.now() - cachedLatest.at < 3600_000) return cachedLatest.value;
  const rel = await latestRelease(REPO, new RegExp(`^${FILE.replace('.', '\\.')}$`));
  cachedLatest = { at: Date.now(), value: rel };
  return rel;
}

function installedVersion(root) {
  try {
    const t = fs.readFileSync(P(root, 'documents', 'Run Hotfix.run_hotfix'), 'utf8').trim();
    return /^\d+(\.\d+)+$/.test(t) ? t : t ? 'unknown' : null;
  } catch {
    return null;
  }
}

function isModern(root) {
  return fs.existsSync(P(root, 'documents', 'JAILBROKEN.txt')) || fs.existsSync(P(root, 'jb.sh.log'));
}

async function stage(device, log) {
  if (device?.mode !== 'mass-storage' || !device.root) throw new Error('Connect the Kindle as a USB drive.');
  const root = device.root;
  if (isModern(root)) {
    throw new Error('This Kindle has the modern setup, which already includes the hotfix. Installing the standalone hotfix would remove KPM and scriptlets.');
  }
  const others = (await fsp.readdir(root)).filter((n) => /\.bin$|\.partial$/i.test(n) && !n.startsWith('._') && n !== FILE);
  if (others.length) throw new Error(`Remove these from the Kindle first: ${others.join(', ')}.`);

  const rel = await latest();
  log(`Downloading Universal Hotfix ${rel.tag}…`);
  const file = await ops.download(rel.url, `hotfix-${rel.tag}.bin`);
  const buf = await fsp.readFile(file);
  // Kindle update packages start with the "SP01" signature header.
  if (buf.subarray(0, 4).toString('latin1') !== 'SP01' || buf.length < 500_000) {
    throw new Error('The downloaded hotfix does not look like a Kindle update package. Nothing was copied.');
  }
  await fsp.copyFile(file, P(root, FILE));
  log(`Copied ${FILE} (${rel.tag}) to the Kindle.`);
  return { version: rel.tag };
}

async function unstage(device, log) {
  if (device?.mode !== 'mass-storage') throw new Error('Connect the Kindle as a USB drive.');
  await fsp.rm(P(device.root, FILE), { force: true });
  log(`Removed ${FILE} from the Kindle.`);
}

async function status(device) {
  if (device?.mode !== 'mass-storage' || !device.root) return { applicable: false };
  const root = device.root;
  let latestTag = null;
  try {
    latestTag = (await latest()).tag;
  } catch {}
  return {
    applicable: true,
    modern: isModern(root),
    installed: installedVersion(root),
    latest: latestTag,
    staged: fs.existsSync(P(root, FILE)),
  };
}

module.exports = { stage, unstage, status, latest, installedVersion, FILE };
