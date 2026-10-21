const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
};

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  loadData: () => call('data:load'),
  detect: () => call('kindle:detect'),
  lookupSerial: (serial) => call('kindle:lookup-serial', serial),
  openKindle: () => call('kindle:open'),
  match: (answers) => call('wizard:match', answers),
  prepare: (name) => call('jb:prepare', name),
  install: (name) => call('jb:install', name),
  openPrepared: (name) => call('jb:open-folder', name),
  listUpdates: () => call('updates:list'),
  removeUpdates: () => call('updates:remove'),
  fillerInfo: () => call('filler:info'),
  startFill: (targetMB) => call('filler:start', targetMB),
  fillStatus: () => call('filler:status'),
  cancelFill: () => call('filler:cancel'),
  removeFiller: () => call('filler:remove'),
  scanKindle: () => call('health:scan'),
  fixKindle: (id) => call('health:fix', id),
  hotfixStatus: () => call('hotfix:status'),
  hotfixStage: () => call('hotfix:stage'),
  hotfixUnstage: () => call('hotfix:unstage'),
  upgradeCheck: () => call('upgrade:check'),
  upgradeStage: () => call('upgrade:stage'),
  upgradeCleanup: () => call('upgrade:cleanup'),
  koreaderPackages: () => call('koreader:packages'),
  koreaderPlatform: (firmware) => call('koreader:platform', firmware),
  installKOReader: (platform) => call('koreader:install', platform),
  customStatus: () => call('custom:status'),
  setHomeUI: (id) => call('custom:home-ui', id),
  resetHomeUI: () => call('custom:home-ui-reset'),
  addFonts: (targets) => call('custom:add-fonts', targets),
  removeFont: (name) => call('custom:remove-font', name),
  addSleepImages: () => call('custom:add-sleep'),
  removeSleepImage: (name) => call('custom:remove-sleep', name),
  addDictionaries: () => call('custom:add-dict'),
  removeDictionary: (name) => call('custom:remove-dict', name),
  saveOffline: () => call('guide:save-offline'),
  guideStats: () => call('guide:stats'),
  clearGuide: () => call('guide:clear'),
  openExternal: (url) => call('open-external', url),
  onLog: on('log'),
  onProgress: on('progress'),
});
