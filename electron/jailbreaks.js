const fs = require('node:fs');
const path = require('node:path');
const { app, net } = require('electron');

const SITE = 'https://kindlemodding.org';
const BUNDLED = path.join(__dirname, '..', 'data');

// Fetch the wizard's live data so recommendations track the site; fall back to
// the last good copy (userData), then to the copy shipped with the app.
async function loadData(name) {
  const cacheFile = path.join(app.getPath('userData'), name);
  try {
    const res = await net.fetch(`${SITE}/${name}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    fs.writeFileSync(cacheFile, JSON.stringify(json));
    return { data: json, source: 'live' };
  } catch {
    for (const [file, source] of [[cacheFile, 'cached'], [path.join(BUNDLED, name), 'bundled']]) {
      try {
        return { data: JSON.parse(fs.readFileSync(file, 'utf8')), source };
      } catch {}
    }
    throw new Error(`Could not load ${name}`);
  }
}

function compareVersions(v1, v2) {
  const a = v1.split('.').map(Number);
  const b = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function isValidFirmware(value) {
  return /^\d{1,2}(\.\d{1,2}){1,5}$/.test(value) && parseInt(value.split('.')[0], 10) <= 5;
}

// Same rules as fillResults() in the site's jailbreakFinder.js; the first match
// is the recommended one.
function matchJailbreaks(jailbreaks, { model, firmware, blacklisted, ads }) {
  return jailbreaks.filter((jb) => {
    if (!jb.models.includes(model)) return false;
    if (jb.registration && blacklisted) return false;
    if (jb.ads && !ads) return false;
    return jb.firmwares.some((rule) => {
      if (!rule.models.includes('all') && !rule.models.includes(model)) return false;
      if (rule.outliers.denied.includes(firmware)) return false;
      if (rule.outliers.accepted.includes(firmware)) return true;
      return compareVersions(firmware, rule.min) >= 0 && compareVersions(firmware, rule.max) <= 0;
    });
  });
}

const GH = 'https://github.com/KindleModding';

// What this app can do on the PC side for each jailbreak. Steps on the Kindle
// itself are summarised; the official guide page is always one click away.
// kind: 'copy'    – download, extract, copy into the Kindle
//       'merge-assets' – AdBreak's system/.assets replacement
//       'run-exe' – download and launch the jailbreak's own PC tool
//       'browser' – nothing to copy; done from the Kindle's web browser
//       'guide'   – follow the guide page
const PLANS = {
  WinterBreak2: {
    kind: 'copy',
    download: { url: `${GH}/Winterbreak2/releases/latest/download/wb2.zip`, file: 'wb2.zip' },
    dest: '',
    usesFiller: true,
    expect: 'A "winterbreak2" folder in the Kindle\'s root.',
    onKindle: [
      'Safely eject the Kindle and connect it to Wi-Fi.',
      'Open the Experimental Browser (Menu → Experimental Browser, or Settings → Device Options → Advanced).',
      'Go to https://penguins184.xyz/wb2 and press the Jailbreak button.',
      'Wait for the process to finish.',
    ],
  },
  WinterBreak: {
    kind: 'copy',
    download: { url: `${GH}/WinterBreak/releases/latest/download/WinterBreak.tar.gz`, file: 'WinterBreak.tar.gz' },
    dest: '',
    usesFiller: true,
    before: ['Turn on Airplane mode on the Kindle.', 'Restart the Kindle, then plug it back in.'],
    expect: 'Includes the hidden ".active_content_sandbox" folder.',
    onKindle: [
      'Safely eject the Kindle.',
      'Tap the store (cart) icon on the home screen. When asked, tap Yes to turn off Airplane mode.',
      'When Mesquito loads, tap the WinterBreak icon.',
      'Wait about 30 seconds. Text appears and the GUI restarts. If no text appears, start over.',
    ],
  },
  SpiderCat: {
    kind: 'copy',
    download: { url: `${SITE}/spidercat/spidercat.azw3`, file: 'spidercat.azw3', raw: true },
    dest: 'documents',
    usesFiller: true,
    expect: 'spidercat.azw3 in the Kindle\'s "documents" folder.',
    onKindle: [
      'Safely eject the Kindle.',
      'Open the SpiderCat book from your library.',
      'Wait. The page may stay blank for a while, then text scrolls down.',
      'When it says "Restarting Kindle", the Kindle reboots jailbroken.',
    ],
  },
  Nosebleed: {
    kind: 'copy',
    download: { url: `${SITE}/jailbreaking/Nosebleed/nosebleed.zip`, file: 'nosebleed.zip' },
    dest: '',
    usesFiller: true,
    expect: 'Two files in the Kindle\'s root.',
    onKindle: [
      'Safely eject the Kindle.',
      'Open the Kindle web browser (top-right menu) and go to https://kindlemodding.org/nosb',
      'Tap the "L" on the forehead in the picture. Application errors are expected.',
    ],
  },
  AdBreak: {
    kind: 'merge-assets',
    download: { url: `${GH}/AdBreak/releases/latest/download/adbreak.zip`, file: 'adbreak.zip' },
    usesFiller: true,
    before: [
      'Leave the Kindle online until the lockscreen shows ads (press the power button to check).',
      'Turn on Airplane mode.',
      'In the top-right menu, open "View all ads" so several special offers are listed.',
      'Plug the Kindle in.',
    ],
    expect: 'system/.assets on the Kindle is replaced by a patched copy containing jb.sh, with every details.html swapped for AdBreak.',
    onKindle: [
      'Safely eject the Kindle.',
      'Tap an ad and go through the popups. After you tap Close on "Bang!", the jailbreak runs.',
      'Application error popups can be ignored.',
    ],
  },
  SpringBreak: {
    kind: 'run-exe',
    download: { url: `${GH}/SpringBreak/releases/latest/download/springbreak.zip`, file: 'springbreak.zip' },
    exe: 'springbreak.exe',
    usesFiller: false,
    before: [
      'Do NOT use filler files for SpringBreak. It needs free space and fills the Kindle by itself.',
      'Turn on Airplane mode, restart the Kindle, then plug it in.',
    ],
    onKindle: [
      'In the SpringBreak window, type the number of your Kindle and press Enter, then wait.',
      'Unplug the Kindle and tap the store icon. Allow Wi-Fi when asked.',
      'SpringBreak loads and text appears.',
    ],
  },
  'Véra': {
    kind: 'browser',
    usesFiller: true,
    onKindle: [
      'Note your exact firmware version (Settings → Device options → Device info).',
      'Open the Kindle web browser and go to https://kindlemodding.org/vera',
      'Pick your device and firmware, then download both books (Font Calibration and Véra).',
      'Follow the guide page to set the font in Font Calibration, then open the Véra book.',
    ],
  },
  Sanctuary: {
    kind: 'browser',
    usesFiller: true,
    onKindle: [
      'Open the Kindle web browser and go to http://sanctuary.skyvincent.com/scroll (http, not https).',
      'Check the scroll bar against the guide page, then go to http://sanctuary.skyvincent.com/',
      'Wait for the ID (up to 20 minutes), type it in, and press Connect.',
      'After "Downloads Done", close the browser and open Settings → Help → Getting Started.',
    ],
  },
};

// When the Kindle has to be online. None of the current jailbreaks work fully
// in Airplane mode: they all fetch their payload (kindlemodding.org/jb.sh) at
// run time, so this is the window the storage filler protects.
const ONLINE_AT = {
  WinterBreak2: 'Wi-Fi must be on while the Experimental Browser loads the WinterBreak2 page and runs it.',
  WinterBreak: 'Airplane mode is turned off when you open the Kindle Store, and stays off while the jailbreak runs.',
  SpiderCat: 'Wi-Fi must be on when you open the SpiderCat book. It downloads its payload from kindlemodding.org.',
  Nosebleed: 'Wi-Fi must be on for the browser step. The payload is downloaded from kindlemodding.org.',
  AdBreak: 'The Kindle must be online to download ads, and again when the payload downloads after "Bang!".',
  SpringBreak: 'Wi-Fi must be on when the Kindle Store loads SpringBreak. Turn it off again once it has loaded.',
  'Véra': 'Wi-Fi must be on to download the two books from the Kindle web browser.',
  Sanctuary: 'Wi-Fi must be on for the whole browser part (port scan and download, up to 20 minutes).',
};

function planFor(name) {
  const plan = PLANS[name] || { kind: 'guide', usesFiller: true, onKindle: ['Follow the guide page for this jailbreak.'] };
  return { ...plan, onlineAt: ONLINE_AT[name] || 'Check the guide page for when the Kindle must be online.' };
}

module.exports = { SITE, loadData, matchJailbreaks, isValidFirmware, planFor, compareVersions };
