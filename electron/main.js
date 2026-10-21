const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, shell, powerSaveBlocker, dialog } = require('electron');
const { detectKindle, findModel } = require('./kindle');
const { SITE, loadData, matchJailbreaks, isValidFirmware, planFor } = require('./jailbreaks');
const ops = require('./device-ops');
const guide = require('./guide');
const health = require('./health');
const koreader = require('./koreader');
const customize = require('./customize');
const upgrade = require('./upgrade');
const hotfix = require('./hotfix');

let win;
let data = { models: [], jailbreaks: [], sources: {} };
let device = { connected: false };
// Folder each jailbreak was downloaded/extracted to, by jailbreak name.
const prepared = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const log = (msg) => send('log', { time: Date.now(), msg });

async function ensureData() {
  if (data.models.length) return data;
  const [models, jailbreaks] = await Promise.all([loadData('models.json'), loadData('jailbreaks.json')]);
  data = { models: models.data, jailbreaks: jailbreaks.data, sources: { models: models.source, jailbreaks: jailbreaks.source } };
  return data;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Kindle Jailbreak Helper',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('close', (e) => {
    if (!fillState || fillState.done) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep filling', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'The Kindle is still being filled.',
      detail: 'If you quit, the files written so far stay on the Kindle and the next fill continues from there.',
    });
    if (choice === 0) e.preventDefault();
    else ops.cancelFill();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.on('web-contents-created', (_e, contents) => {
  // Lock down the guide <webview>: no node, no preload, only our partition.
  contents.on('will-attach-webview', (_ev, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    params.partition = guide.PARTITION;
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (new URL(url).hostname === guide.HOST) contents.loadURL(url);
      else if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  }
});

// ---------- IPC ----------

const handle = (channel, fn) =>
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      log(`Error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

handle('data:load', async () => {
  const d = await ensureData();
  return { sources: d.sources, site: SITE, jailbreakCount: d.jailbreaks.length };
});

handle('kindle:detect', async () => {
  await ensureData();
  device = await detectKindle();
  if (device.serial) device.modelInfo = findModel(device.serial, data.models);
  return device;
});

handle('kindle:lookup-serial', async (serial) => {
  await ensureData();
  return findModel(serial, data.models);
});

handle('kindle:open', () => ops.openKindleFolder(device));

handle('wizard:match', async (answers) => {
  await ensureData();
  if (!isValidFirmware(answers.firmware)) throw new Error('Firmware should look like 5.17.1 or 5.16.2.1.1');
  return matchJailbreaks(data.jailbreaks, answers).map((jb) => ({ ...jb, plan: planFor(jb.name) }));
});

handle('jb:prepare', async (name) => {
  const plan = planFor(name);
  if (!plan.download) throw new Error(`${name} has nothing to download on the PC.`);
  log(`Downloading ${plan.download.url}`);
  let lastPct = -1;
  const file = await ops.download(plan.download.url, plan.download.file, ({ got, total }) => {
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      send('progress', { task: 'download', got, total });
    }
  });
  let dir;
  if (plan.download.raw) {
    dir = ops.work('extracted', name);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(file, path.join(dir, plan.download.file));
  } else {
    log('Extracting…');
    dir = await ops.extract(file);
  }
  prepared.set(name, dir);
  const contents = await fsp.readdir(dir);
  log(`Ready: ${contents.join(', ')}`);
  return { dir, contents };
});

handle('jb:install', async (name) => {
  const plan = planFor(name);
  const dir = prepared.get(name);
  if (!dir) throw new Error('Download the files first.');
  if (plan.kind === 'copy') {
    await ops.copyToKindle(device, dir, plan.dest, log);
  } else if (plan.kind === 'merge-assets') {
    return ops.adbreakPatch(device, dir, log);
  } else if (plan.kind === 'run-exe') {
    // The SpringBreak zip holds a single "springbreak" folder.
    const inner = path.join(dir, 'springbreak');
    ops.launchExe(fs.existsSync(inner) ? inner : dir, plan.exe);
    log(`Started ${plan.exe} in a new window.`);
  } else {
    throw new Error(`${name} is installed from the Kindle itself.`);
  }
  return true;
});

handle('jb:open-folder', (name) => shell.openPath(prepared.get(name) || ops.work('extracted')));

handle('updates:list', () => ops.listUpdateFiles(device));
handle('updates:remove', async () => {
  const removed = await ops.removeUpdateFiles(device);
  log(removed.length ? `Removed ${removed.join(', ')}` : 'No update files found.');
  return removed;
});

handle('filler:info', () => ops.fillerInfo(device));
// Latest fill progress, so the UI can pick it up again after switching steps.
let fillState = null;
handle('filler:status', () => fillState);
handle('filler:start', async (targetMB) => {
  if (fillState && !fillState.done) throw new Error('A fill is already running.');
  // A fill can take hours; stop Windows sleeping and cutting the USB write off.
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  log(`Filling storage until ${targetMB} MB is free…`);
  try {
    const result = await ops.fillStorage(device, targetMB, (p) => {
      fillState = { task: 'fill', ...p };
      send('progress', fillState);
    });
    log(result.cancelled ? 'Fill stopped. Start it again to continue where it left off.' : 'Fill finished.');
    return result;
  } catch (err) {
    fillState = { ...(fillState || {}), task: 'fill', done: true, error: err.message };
    send('progress', fillState);
    throw err;
  } finally {
    powerSaveBlocker.stop(blocker);
  }
});
handle('filler:cancel', () => ops.cancelFill());
handle('filler:remove', async () => {
  await ops.removeFiller(device);
  log('Removed fill_disk.');
});

handle('health:scan', async () => {
  device = await detectKindle();
  if (device.serial) device.modelInfo = findModel(device.serial, (await ensureData()).models);
  let latestHotfix = null;
  try {
    latestHotfix = (await hotfix.latest()).tag;
  } catch {} // offline: just skip the "newer hotfix" hint
  return { device, ...(await health.scan(device, { latestHotfix })) };
});
handle('hotfix:status', () => hotfix.status(device));
handle('hotfix:stage', () => hotfix.stage(device, log));
handle('hotfix:unstage', () => hotfix.unstage(device, log));
handle('health:fix', async (id) => {
  await health.applyFix(device, id, log);
  return true;
});
handle('upgrade:check', () => upgrade.check(device));
handle('upgrade:stage', () => upgrade.stage(device, log));
handle('upgrade:cleanup', () => upgrade.cleanup(device, log));
handle('koreader:packages', () => koreader.listPackages());
handle('koreader:platform', (firmware) => koreader.platformFor(firmware));
handle('koreader:install', (platform) => koreader.install(device, platform, log));

handle('custom:status', async () => {
  device = await detectKindle();
  if (device.serial) device.modelInfo = findModel(device.serial, (await ensureData()).models);
  return { device, ...(await customize.status(device)) };
});
handle('custom:home-ui', (id) => customize.installHomeUI(device, id, log));
handle('custom:home-ui-reset', () => customize.resetHomeUI(device, log));

const pick = async (title, filters, multi = true) => {
  const r = await dialog.showOpenDialog(win, { title, filters, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'] });
  return r.canceled ? [] : r.filePaths;
};
handle('custom:add-fonts', async (targets) => {
  const files = await pick('Choose font files', [{ name: 'Fonts', extensions: ['ttf', 'otf'] }]);
  return files.length ? customize.installFonts(device, files, targets, log) : 0;
});
handle('custom:remove-font', (name) => customize.removeFont(device, name));
handle('custom:add-sleep', async () => {
  const files = await pick('Choose images', [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]);
  return files.length ? customize.addSleepImages(device, files, log) : 0;
});
handle('custom:remove-sleep', (name) => customize.removeSleepImage(device, name));
handle('custom:add-dict', async () => {
  const files = await pick('Choose StarDict files or a .zip', [{ name: 'StarDict', extensions: ['zip', 'ifo', 'idx', 'dict', 'dz', 'syn', 'gz'] }]);
  return files.length ? customize.installDictionaries(device, files, log) : [];
});
handle('custom:remove-dict', (name) => customize.removeDictionary(device, name));

handle('guide:save-offline', () => guide.saveOffline((p) => send('progress', { task: 'offline', ...p })));
handle('guide:stats', () => guide.cacheStats());
handle('guide:clear', () => guide.clearCache());

handle('open-external', (url) => {
  if (!/^https?:\/\//.test(url)) throw new Error('Only web links can be opened.');
  return shell.openExternal(url);
});

app.whenReady().then(() => {
  guide.setupGuideSession();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
