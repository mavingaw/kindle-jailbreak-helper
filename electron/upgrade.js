const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { net } = require('electron');
const ops = require('./device-ops');

// Guided upgrade from the older setup (Universal Hotfix + KUAL + MRPI) to the
// modern one (KPM, scriptlets via sh_integration, automatic update blocking).
//
// It runs the official kindlemodding.org jb.sh payload in RUN_MODE=1 — the
// mode jb.sh provides for devices that are already jailbroken. The payload is
// self-contained (no network access), so the Kindle stays in Airplane mode.
// It is started from KUAL, which already runs scripts as root on this setup.

const JB_URL = 'https://kindlemodding.org/jb.sh';
const EXT = 'kjh_upgrade';
const LOG = 'kjh-upgrade.log';
const P = (root, ...p) => path.join(root, ...p);
const exists = (p) => fs.existsSync(p);

function lf(s) {
  return s.replace(/\r\n/g, '\n');
}

const MENU_JSON = lf(`{
	"items": [
	{
		"name": "Kindle Jailbreak Helper",
		"priority": -999,
		"items": [
		{
			"name": "Upgrade to KPM + scriptlets",
			"priority": 1,
			"action": "bin/upgrade.sh",
			"exitmenu": true
		}
		]
	}
	]
}
`);

const CONFIG_XML = lf(`<?xml version="1.0" encoding="UTF-8"?>
<extension>
	<information>
		<name>Kindle Jailbreak Helper upgrade</name>
	</information>
	<menus>
		<menu type="json" dynamic="true">menu.json</menu>
	</menus>
</extension>
`);

// jb.sh prints its progress to the screen and stdout; keep a copy on USB storage
// so the app can show what happened.
const UPGRADE_SH = lf(`#!/bin/sh
cd /mnt/us/extensions/${EXT} || exit 1
echo "started $(date)" > /mnt/us/${LOG}
RUN_MODE=1 JB_HEADER="Upgraded with Kindle Jailbreak Helper" sh ./jb.sh >> /mnt/us/${LOG} 2>&1
echo "jb.sh exit code: $?" >> /mnt/us/${LOG}
`);

async function readText(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function check(device) {
  if (device?.mode !== 'mass-storage' || !device.root || !exists(P(device.root, 'documents'))) {
    return { applicable: false, reason: 'Connect the Kindle as a USB drive.' };
  }
  const root = device.root;
  const docs = await fsp.readdir(P(root, 'documents')).catch(() => []);
  const jailbrokenTxt = await readText(P(root, 'documents', 'JAILBROKEN.txt'));
  const log = await readText(P(root, LOG));
  const staged = exists(P(root, 'extensions', EXT, 'jb.sh'));
  const kual = docs.some((n) => /\.kual$/i.test(n)) || exists(P(root, 'extensions', 'KUAL.cfg'));
  const hotfix = (await readText(P(root, 'documents', 'Run Hotfix.run_hotfix')))?.trim() || null;
  const pendingUpdates = (await fsp.readdir(root).catch(() => [])).filter((n) => /^update.*\.(bin|partial)$/.test(n));

  if (jailbrokenTxt) {
    return {
      applicable: true,
      state: 'done',
      modernVersion: /jb\.sh (v[\d.]+)/.exec(jailbrokenTxt)?.[1] || null,
      viaHelper: /Kindle Jailbreak Helper/.test(jailbrokenTxt),
      staged,
      log: log ? log.trim().split('\n').slice(-15) : null,
      problems: log ? log.split('\n').filter((l) => /fail|error|not enough space/i.test(l)).slice(0, 5) : [],
    };
  }
  const blockers = [];
  if (!kual) blockers.push('KUAL was not found, so there is nothing on the Kindle to start the upgrade from.');
  if (pendingUpdates.length) blockers.push(`Delete the waiting update first: ${pendingUpdates.join(', ')}.`);
  return {
    applicable: true,
    state: log ? 'ran-without-result' : staged ? 'staged' : 'ready',
    hotfix,
    kual,
    staged,
    blockers,
    log: log ? log.trim().split('\n').slice(-15) : null,
  };
}

async function stage(device, log) {
  const c = await check(device);
  if (!c.applicable) throw new Error(c.reason);
  if (c.state === 'done') throw new Error('This Kindle already has the modern setup.');
  if (c.blockers?.length) throw new Error(c.blockers.join(' '));
  const root = device.root;

  log('Downloading the jailbreak payload (jb.sh) from kindlemodding.org…');
  const res = await net.fetch(JB_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const script = Buffer.from(await res.arrayBuffer());
  // The version line comes after the multi-megabyte packed payload, so search it all.
  const text = script.toString('latin1');
  const version = /JB_SH_VERSION="([^"]+)"/.exec(text)?.[1];
  // Sanity checks so a broken or unexpected download never reaches the Kindle.
  if (!text.startsWith('#!/bin/sh') || !version || script.length < 1_000_000 || !text.includes('RUN_MODE') || !text.includes('destroy_otas')) {
    throw new Error('The downloaded jb.sh does not look right. Nothing was copied. Try again later.');
  }
  log(`Got jb.sh ${version} (${(script.length / 1048576).toFixed(1)} MB).`);

  const dir = P(root, 'extensions', EXT);
  await fsp.mkdir(path.join(dir, 'bin'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'jb.sh'), script);
  await fsp.writeFile(path.join(dir, 'menu.json'), MENU_JSON);
  await fsp.writeFile(path.join(dir, 'config.xml'), CONFIG_XML);
  await fsp.writeFile(path.join(dir, 'bin', 'upgrade.sh'), UPGRADE_SH);
  await fsp.rm(P(root, LOG), { force: true });
  // Keep a copy on the PC too, for reference.
  const copy = ops.work('downloads', `jb-${version}.sh`);
  await fsp.mkdir(path.dirname(copy), { recursive: true });
  await fsp.writeFile(copy, script);
  log(`Upgrade is ready on the Kindle: KUAL → Kindle Jailbreak Helper → Upgrade to KPM + scriptlets.`);
  return { version };
}

// After a successful upgrade the KUAL entry is no longer needed.
async function cleanup(device, log) {
  if (device?.mode !== 'mass-storage') throw new Error('Connect the Kindle as a USB drive.');
  await fsp.rm(P(device.root, 'extensions', EXT), { recursive: true, force: true });
  log('Removed the upgrade entry from KUAL.');
}

module.exports = { check, stage, cleanup, MENU_JSON, UPGRADE_SH };
