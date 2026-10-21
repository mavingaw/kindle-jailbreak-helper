const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { installedPlatform, installedPackageVersion, directScriptlet } = require('./koreader');
const { compareVersions } = require('./jailbreaks');

// "Check my Kindle": read-only scan of a mass-storage Kindle for what a
// previous jailbreak left behind, plus fixes for the common mistakes.
//
// Two setups exist in the wild:
//  - modern ("hdnext", jb.sh v2+): writes documents/JAILBROKEN.txt and
//    jb.sh.log, installs KPM, blocks OTA itself. KOReader comes from KPM.
//  - older: per-jailbreak log (e.g. adbreak.log) asking for the hotfix, then
//    KUAL + MRPI + renameotabin, KOReader extracted by hand.

const UPDATE_FILE = /^update.*\.(bin|partial)$/; // same rule as device-ops
const JB_LOG = /\.log$/i;

const exists = (p) => fs.existsSync(p);
const readText = async (p, max = 20000) => {
  try {
    return (await fsp.readFile(p, 'utf8')).slice(0, max);
  } catch {
    return null;
  }
};
async function ls(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = async (d) => {
    for (const e of await ls(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        files++;
        try {
          bytes += (await fsp.stat(p)).size;
        } catch {}
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

// Every folder (up to a few levels deep) that looks like a KOReader install,
// i.e. a "koreader" folder with koreader.sh in it, other than the real one.
async function findKOReaderCopies(root) {
  const found = [];
  const skip = new Set(['system', 'audible', 'fill_disk', '.Spotlight-V100', '.fseventsd', 'System Volume Information']);
  const walk = async (dir, depth) => {
    if (depth > 4) return;
    for (const e of await ls(dir)) {
      if (!e.isDirectory() || e.name.startsWith('._') || (depth === 0 && skip.has(e.name))) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'koreader' && exists(path.join(p, 'koreader.sh'))) {
        if (path.resolve(p) !== path.resolve(root, 'koreader')) found.push(p);
        continue;
      }
      if (/\.sdr$/i.test(e.name)) continue; // book sidecar folders
      await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

// The KUAL launcher entry KOReader ships ("extensions/koreader/menu.json")
// copied anywhere other than extensions/koreader.
async function findStrayKOReaderExtensions(root) {
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 4) return;
    for (const e of await ls(dir)) {
      if (!e.isDirectory() || e.name.startsWith('._')) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'koreader' && exists(path.join(p, 'menu.json')) && !exists(path.join(p, 'koreader.sh'))) {
        if (path.resolve(p) !== path.resolve(root, 'extensions', 'koreader')) found.push(p);
        continue;
      }
      if (depth === 0 && ['system', 'audible', 'fill_disk', 'koreader'].includes(e.name)) continue;
      await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

// True if a folder holds nothing except KOReader pieces (koreader/,
// extensions/koreader/, Mac "._" files): the wrapper left by an extracted zip.
async function onlyKOReaderInside(dir) {
  for (const e of await ls(dir)) {
    if (e.name.startsWith('._') || e.name === 'koreader') continue;
    if (e.name === 'extensions' && e.isDirectory()) {
      if (!(await onlyKOReaderInside(path.join(dir, e.name)))) return false;
      continue;
    }
    return false;
  }
  return true;
}

// What to delete for a misplaced copy: the zip's wrapper folder (e.g.
// extensions/koreader-kindlehf-v2025.10) when it holds nothing else,
// otherwise only the copy itself.
async function deletionTarget(root, copy) {
  let target = copy;
  const keep = ['', 'documents', 'mrpackages', 'extensions'].map((p) => path.resolve(root, p));
  for (;;) {
    const parent = path.dirname(target);
    if (keep.includes(path.resolve(parent)) || !(await onlyKOReaderInside(parent))) return target;
    target = parent;
  }
}

async function countDotUnderscore(root) {
  let n = 0;
  const walk = async (dir, depth) => {
    if (depth > 3) return;
    for (const e of await ls(dir)) {
      if (e.name.startsWith('._')) n++;
      else if (e.isDirectory() && depth < 3 && !['system', 'fill_disk', 'koreader'].includes(e.name)) await walk(path.join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return n;
}

async function scan(device, opts = {}) {
  if (device?.mode !== 'mass-storage' || !device.root) {
    return {
      supported: false,
      reason:
        device?.mode === 'mtp'
          ? 'This Kindle connects over MTP. The scan needs a Kindle that shows up as a USB drive.'
          : device?.mode === 'usb-only'
            ? 'The Kindle is plugged in, but Windows hasn\'t opened its storage yet. That can take up to a minute. Scan again shortly.'
            : 'Connect the Kindle with a USB cable, then scan.',
    };
  }
  const root = device.root;
  if (!exists(path.join(root, 'documents'))) return { supported: false, reason: `No Kindle storage at ${root}. Plug the Kindle in and scan again.` };
  const P = (...p) => path.join(root, ...p);
  const checks = [];
  const rootEntries = await ls(root);
  const rootFiles = rootEntries.filter((e) => e.isFile()).map((e) => e.name);
  const docs = (await ls(P('documents'))).map((e) => e.name);

  // --- jailbreak ---
  const jailbrokenTxt = await readText(P('documents', 'JAILBROKEN.txt'));
  const jbShLog = await readText(P('jb.sh.log'), 200000);
  const logs = [];
  for (const f of rootFiles.filter((n) => JB_LOG.test(n) && !n.startsWith('._') && n !== 'jb.sh.log')) {
    const t = await readText(P(f));
    if (t && /jailbreak/i.test(t)) logs.push({ file: f, text: t });
  }
  const finishedLog = logs.find((l) => /Finished installing jailbreak/i.test(l.text));
  const wantsHotfix = logs.some((l) => /install hotfix/i.test(l.text));
  const modern = !!jailbrokenTxt || !!jbShLog;
  const setup = modern ? 'modern' : finishedLog || exists(P('extensions', 'MRInstaller')) ? 'older' : 'none';
  const jbSummary = [];
  if (jailbrokenTxt) jbSummary.push(`documents/JAILBROKEN.txt: ${jailbrokenTxt.split('\n').filter(Boolean).slice(0, 2).join(' ')}`);
  if (jbShLog) {
    const lines = jbShLog.trim().split('\n');
    jbSummary.push(`jb.sh.log ends with: "${lines.slice(-1)[0]}"`);
  }
  for (const l of logs) jbSummary.push(`${l.file}: ${/Finished installing jailbreak/i.test(l.text) ? 'finished installing the jailbreak' : 'jailbreak log present, no "finished" line'}`);
  if (exists(P('system', '.assets', 'jb.sh'))) jbSummary.push('AdBreak files are in system/.assets');

  checks.push({
    id: 'jailbreak',
    title: 'Jailbreak',
    status: jailbrokenTxt || finishedLog ? 'ok' : jbSummary.length ? 'warn' : 'missing',
    summary:
      jailbrokenTxt || finishedLog
        ? `A jailbreak finished installing (${modern ? 'modern setup with KPM' : 'older setup with hotfix + KUAL'}).`
        : jbSummary.length
          ? 'A jailbreak was attempted, but there is no sign it finished.'
          : 'No sign of a jailbreak. Use the Helper tab to jailbreak this Kindle.',
    details: [
      ...jbSummary,
      'Files show what was installed, not whether it still works. A firmware update can undo it. On the Kindle, check that your launcher (KUAL or scriptlets) still opens.',
    ],
  });

  // --- hotfix ---
  const runHotfix = docs.find((n) => n.endsWith('.run_hotfix'));
  const pendingHotfix = rootFiles.find((n) => /^Update_hotfix.*\.bin$/i.test(n));
  const hotfixVersion = runHotfix ? (await readText(P('documents', runHotfix)))?.trim() || null : null;
  const latestHotfix = opts.latestHotfix || null;
  if (modern) {
    // jb.sh removes the "Run Hotfix" book and registers its own hotfix; the
    // standalone hotfix installer would wipe /var/local/kmc (KPM, scriptlets).
    checks.push({
      id: 'hotfix',
      title: 'Hotfix',
      status: pendingHotfix ? 'problem' : 'ok',
      summary: pendingHotfix
        ? `${pendingHotfix} is on the Kindle. Don't install it: on the modern setup it would remove KPM and scriptlets. Delete it.`
        : 'Included in the modern jailbreak. Don\'t install the separate Universal Hotfix on this setup: it would remove KPM and scriptlets.',
      details: [],
      fixes: pendingHotfix ? [{ id: 'remove-hotfix-bin', label: `Delete ${pendingHotfix}`, confirm: true }] : [],
    });
  } else if (setup !== 'none') {
    let status = 'ok';
    let summary = `Installed${hotfixVersion ? ` (version ${hotfixVersion})` : ''}. "Run Hotfix" is in your library.`;
    if (pendingHotfix) {
      status = 'warn';
      summary = `${pendingHotfix} is waiting to be installed. Follow the hotfix steps below (Restore in KUAL, then Settings → ⋮ → Update Your Kindle).`;
    } else if (!runHotfix) {
      status = 'problem';
      summary = 'Not installed. Without it the jailbreak can stop working after a Kindle update. Install it below.';
    } else if (latestHotfix && hotfixVersion && compareVersions(latestHotfix, hotfixVersion) > 0) {
      status = 'warn';
      summary = `Version ${hotfixVersion} is installed; ${latestHotfix} is available. You can update it below, or do the modern upgrade, which includes it.`;
    }
    checks.push({
      id: 'hotfix',
      title: 'Hotfix',
      status,
      summary,
      details: ['After a Kindle firmware update, open "Run Hotfix" from the library to re-apply the jailbreak.'],
    });
  }

  // --- launcher / package manager ---
  if (setup === 'older' || exists(P('extensions'))) {
    const kual = docs.some((n) => /\.kual$/i.test(n)) || exists(P('extensions', 'KUAL.cfg'));
    const mrpi = exists(P('extensions', 'MRInstaller'));
    const pendingMr = (await ls(P('mrpackages'))).filter((e) => e.isFile() && /\.bin$/i.test(e.name) && !e.name.startsWith('._')).map((e) => e.name);
    checks.push({
      id: 'kual',
      title: 'KUAL and MR package installer',
      status: kual && mrpi ? (pendingMr.length ? 'warn' : 'ok') : 'warn',
      summary: [
        kual ? 'KUAL is installed.' : 'KUAL not found.',
        mrpi ? 'The MR package installer (MRPI) is installed.' : 'The MR package installer (MRPI) was not found.',
        pendingMr.length ? `Packages waiting to install: ${pendingMr.join(', ')}. In KUAL, open Helper → Install MR packages.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      details: [
        'This is the older way to launch apps. The current guide uses scriptlets and KPM instead, and calls KUAL obsolete. Keep using KUAL as long as it opens on your Kindle.',
      ],
    });
  }
  if (modern) {
    checks.push({
      id: 'kpm',
      title: 'Package manager (KPM)',
      status: 'ok',
      summary: 'Installed by the jailbreak. Type ";kpm update" in the home-screen search bar to refresh it.',
      details: [],
    });
  }

  // --- updates ---
  const pendingUpdates = rootFiles.filter((n) => UPDATE_FILE.test(n));
  const renameota = exists(P('extensions', 'renameotabin'));
  checks.push({
    id: 'updates',
    title: 'Automatic updates blocked',
    status: pendingUpdates.length ? 'problem' : setup === 'none' ? 'warn' : 'ok',
    summary: pendingUpdates.length
      ? `A firmware update is waiting to install: ${pendingUpdates.join(', ')}. It can remove the jailbreak.`
      : modern
        ? 'No update waiting. The jailbreak blocks updates automatically.'
        : renameota
          ? 'No update waiting. "renameotabin" is installed. Make sure you have run it once in KUAL (Rename OTA Binaries → Rename).'
          : setup === 'none'
            ? 'No update waiting. Keep the Kindle in Airplane mode until it is jailbroken.'
            : 'No update waiting, but no update blocker was found.',
    details: [],
    fixes: pendingUpdates.length ? [{ id: 'remove-updates', label: `Delete ${pendingUpdates.join(', ')}`, confirm: true }] : [],
  });

  // --- KOReader ---
  const installed = exists(P('koreader', 'koreader.sh'));
  const version = installed ? installedPackageVersion(root) || (await readText(P('koreader', 'git-rev')))?.trim() : null;
  const scriptlet = docs.find((n) => /^koreader.*\.sh$/i.test(n));
  const kualEntry = exists(P('extensions', 'koreader', 'menu.json'));
  const copies = await findKOReaderCopies(root);
  const strayExt = await findStrayKOReaderExtensions(root);
  const strays = [];
  for (const c of [...copies, ...strayExt]) {
    const t = await deletionTarget(root, c);
    if (!strays.some((s) => path.resolve(s) === path.resolve(t))) strays.push(t);
  }
  let strayBytes = 0;
  for (const s of strays) strayBytes += (await dirSize(s)).bytes;
  const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

  const koFixes = [];
  const koDetails = [];
  let koStatus;
  let koSummary;
  // A library item that goes through KPM only works if KPM installed KOReader.
  const scriptletText = scriptlet ? await readText(P('documents', scriptlet)) : null;
  const kpmKnowsKOReader = exists(P('kmc', 'kpm', 'packages', 'koreader'));
  const brokenScriptlet = !!scriptletText && /kpm launch koreader/.test(scriptletText) && !kpmKnowsKOReader;
  // version.log gets one line per KOReader start: "date, time, git-rev, model".
  const launches = ((await readText(P('koreader', 'version.log'))) || '').trim().split('\n').filter(Boolean);
  const lastLaunchRev = launches.length ? launches[launches.length - 1].split(',')[2]?.trim() : null;
  const currentRev = installed ? (await readText(P('koreader', 'git-rev')))?.trim() : null;
  if (installed && currentRev && lastLaunchRev !== currentRev) {
    koDetails.push(
      launches.length
        ? `KOReader hasn't been opened since it was updated (last run: ${lastLaunchRev}). Open it once to see the new version and home screen.`
        : "KOReader hasn't been opened yet."
    );
  }
  if (modern && installed && (!scriptlet || brokenScriptlet)) {
    koFixes.push({ id: 'koreader-scriptlet', label: brokenScriptlet ? 'Repair the KOReader item in your library' : 'Add KOReader to your library' });
    if (brokenScriptlet) koDetails.push(`${scriptlet} starts KOReader through KPM, but KPM didn't install it, so tapping it fails.`);
  }
  if (!installed && copies.length) {
    koStatus = 'problem';
    koSummary = `KOReader was copied to the wrong place (${copies.map(rel).join(', ')}), so it can't start. It belongs in "koreader" at the root.`;
    koFixes.push({ id: 'koreader-move', label: 'Move KOReader into place and remove the other copies', confirm: true });
  } else if (installed && !scriptlet && !kualEntry) {
    koStatus = 'warn';
    koSummary = `KOReader ${version || ''} is installed, but nothing launches it (no KOReader.sh in documents, no KUAL entry).`;
  } else if (installed) {
    koStatus = strays.length ? 'warn' : 'ok';
    koSummary = `KOReader ${version || ''} is installed. Start it from ${[scriptlet && `the "${scriptlet.replace(/\.sh$/i, '')}" scriptlet in your library`, kualEntry && 'KUAL'].filter(Boolean).join(' or ')}.`;
  } else {
    koStatus = 'missing';
    koSummary = 'Not installed. Install it below.';
  }
  if (strays.length && (installed || !copies.length)) {
    koFixes.push({ id: 'koreader-clean', label: `Delete misplaced copies (${(strayBytes / 1048576).toFixed(0)} MB)`, confirm: true });
  }
  checks.push({
    id: 'koreader',
    title: 'KOReader',
    status: koStatus,
    summary: koSummary,
    details: [...koDetails, ...(strays.length ? [`Misplaced copies: ${strays.map(rel).join(', ')}`] : [])],
    fixes: koFixes,
    canInstall: true,
  });

  // --- leftovers ---
  const filler = exists(P('fill_disk')) ? await dirSize(P('fill_disk')) : null;
  const dotFiles = await countDotUnderscore(root);
  const leftovers = [];
  const leftoverFixes = [];
  if (filler) {
    const size = filler.bytes >= 1073741824 ? `${(filler.bytes / 1073741824).toFixed(1)} GB` : `${Math.round(filler.bytes / 1048576)} MB`;
    leftovers.push(`fill_disk holds ${size} of filler. Once the jailbreak works and updates are blocked, it can go.`);
    if (setup !== 'none' && !pendingUpdates.length) leftoverFixes.push({ id: 'remove-filler', label: 'Delete fill_disk', confirm: true });
  }
  if (dotFiles) {
    leftovers.push(`${dotFiles} "._" file${dotFiles === 1 ? '' : 's'}: junk a Mac creates when copying. Harmless, but they can show up as broken items.`);
    leftoverFixes.push({ id: 'remove-dotunderscore', label: 'Delete "._" files', confirm: true });
  }
  if (leftovers.length) {
    checks.push({
      id: 'leftovers',
      title: 'Leftovers',
      status: 'info',
      summary: leftovers.join(' '),
      details: filler && setup === 'none' ? ['Keep fill_disk until the Kindle is jailbroken.'] : [],
      fixes: leftoverFixes,
    });
  }

  return {
    supported: true,
    setup,
    checks,
    free: device.free,
    koreader: {
      installed,
      // Prefer the package version recorded at install time; KOReader's git-rev can lag it.
      version: (installed && installedPackageVersion(root)) || version,
      platform: installed ? installedPlatform(root) : null,
    },
  };
}

// ---------- fixes ----------

async function removeDotUnderscore(root) {
  let n = 0;
  const walk = async (dir, depth) => {
    if (depth > 3) return;
    for (const e of await ls(dir)) {
      const p = path.join(dir, e.name);
      // Only AppleDouble files (tiny "._name" files), never folders.
      if (e.name.startsWith('._') && e.isFile()) {
        const st = await fsp.stat(p);
        if (st.size <= 64 * 1024) {
          await fsp.rm(p, { force: true });
          n++;
        }
      } else if (e.isDirectory() && depth < 3 && !['system', 'fill_disk', 'koreader'].includes(e.name)) await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return n;
}

async function applyFix(device, id, log) {
  if (device?.mode !== 'mass-storage') throw new Error('Fixes need the Kindle connected as a USB drive.');
  const root = device.root;
  const P = (...p) => path.join(root, ...p);

  if (id === 'remove-updates') {
    const files = (await ls(root)).filter((e) => e.isFile() && UPDATE_FILE.test(e.name)).map((e) => e.name);
    for (const f of files) await fsp.rm(P(f), { force: true });
    log(`Deleted ${files.join(', ') || 'nothing'}.`);
    return;
  }

  if (id === 'remove-filler') {
    await fsp.rm(P('fill_disk'), { recursive: true, force: true });
    log('Deleted fill_disk.');
    return;
  }

  if (id === 'koreader-scriptlet') {
    if (!exists(P('koreader', 'koreader.sh'))) throw new Error('KOReader is not installed.');
    const existing = (await ls(P('documents'))).find((e) => /^koreader.*\.sh$/i.test(e.name))?.name;
    const old = existing ? await readText(P('documents', existing)) : null;
    if (existing && existing !== 'KOReader.sh') await fsp.rm(P('documents', existing), { force: true });
    await fsp.writeFile(P('documents', 'KOReader.sh'), directScriptlet(old));
    log('Added "KOReader" to the library. Tap it on the Kindle to start KOReader.');
    return;
  }

  if (id === 'remove-hotfix-bin') {
    const files = (await ls(root)).filter((e) => e.isFile() && /^Update_hotfix.*\.bin$/i.test(e.name)).map((e) => e.name);
    for (const f of files) await fsp.rm(P(f), { force: true });
    log(`Deleted ${files.join(', ') || 'nothing'}.`);
    return;
  }

  if (id === 'remove-dotunderscore') {
    log(`Deleted ${await removeDotUnderscore(root)} "._" files.`);
    return;
  }

  if (id === 'koreader-move' || id === 'koreader-clean') {
    const copies = await findKOReaderCopies(root);
    if (id === 'koreader-move') {
      if (exists(P('koreader', 'koreader.sh'))) throw new Error('KOReader is already in place. Scan again.');
      // Prefer a copy that has its KUAL entry next to it (a complete extracted zip).
      const best =
        copies.find((c) => exists(path.join(path.dirname(c), 'extensions', 'koreader', 'menu.json'))) || copies[0];
      if (!best) throw new Error('No KOReader copy found. Scan again.');
      log(`Moving ${path.relative(root, best)} → koreader`);
      await fsp.rename(best, P('koreader'));
      const ext = path.join(path.dirname(best), 'extensions', 'koreader');
      if (exists(ext) && exists(P('extensions')) && !exists(P('extensions', 'koreader'))) {
        log(`Moving ${path.relative(root, ext)} → extensions/koreader`);
        await fsp.rename(ext, P('extensions', 'koreader'));
      }
      if (!exists(P('koreader', 'koreader.sh'))) throw new Error('Move did not complete. Check the Kindle in File Explorer.');
    }
    // Remove what is left: other copies, stray KUAL entries, and empty wrapper folders.
    const rest = [...(await findKOReaderCopies(root)), ...(await findStrayKOReaderExtensions(root))];
    const protectedDirs = [root, P('extensions'), P('documents'), P('mrpackages'), P('koreader'), P('extensions', 'koreader')];
    const targets = [];
    for (const c of rest) {
      const t = await deletionTarget(root, c);
      if (protectedDirs.some((x) => path.resolve(x) === path.resolve(t))) continue;
      if (!targets.some((s) => path.resolve(s) === path.resolve(t))) targets.push(t);
    }
    for (const t of targets) {
      log(`Deleting ${path.relative(root, t)}`);
      await fsp.rm(t, { recursive: true, force: true });
      await fsp.rm(path.join(path.dirname(t), '._' + path.basename(t)), { force: true });
    }
    // An emptied zip wrapper (e.g. extensions/koreader-kindlehf-x) may remain.
    for (const e of await ls(P('extensions'))) {
      const p = P('extensions', e.name);
      if (e.isDirectory() && /^koreader-/.test(e.name)) {
        const left = await dirSize(p);
        if (left.files === 0) await fsp.rm(p, { recursive: true, force: true });
      }
    }
    log('KOReader cleanup done.');
    return;
  }
  throw new Error(`Unknown fix: ${id}`);
}

module.exports = { scan, applyFix };
