const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runPowerShellJson } = require('./powershell');

// Lab126 (Amazon's Kindle hardware division) USB vendor id.
const KINDLE_VID = '1949';

const DETECT_PS = `
$usb = @(Get-CimInstance Win32_PnPEntity -Filter "DeviceID LIKE 'USB\\\\VID_${KINDLE_VID}%'" | Select-Object Name, DeviceID, PNPClass, Status)
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" | Select-Object DeviceID, VolumeName, FreeSpace, Size)
$mtp = @()
try {
  $shell = New-Object -ComObject Shell.Application
  foreach ($it in $shell.Namespace(17).Items()) {
    if ($it.Path -match 'vid_${KINDLE_VID}') {
      $storages = @()
      foreach ($s in $it.GetFolder.Items()) {
        $storages += [pscustomobject]@{
          Name = $s.Name
          Free = $s.ExtendedProperty('System.FreeSpace')
          Size = $s.ExtendedProperty('System.Capacity')
        }
      }
      $mtp += [pscustomobject]@{ Name = $it.Name; Path = $it.Path; Storages = $storages }
    }
  }
} catch {}
[pscustomobject]@{ usb = $usb; disks = $disks; mtp = $mtp } | ConvertTo-Json -Depth 6 -Compress
`;

function looksLikeKindleRoot(root) {
  try {
    return fs.existsSync(path.join(root, 'documents')) && fs.existsSync(path.join(root, 'system'));
  } catch {
    return false;
  }
}

// The Kindle reports its own serial number as the USB serial, which Windows
// puts at the end of the device instance id. Ids containing "&" are made up by
// Windows for interfaces without a serial.
function serialFromDeviceIds(usb) {
  for (const dev of usb) {
    const tail = String(dev.DeviceID || '').split('\\').pop();
    if (tail && !tail.includes('&') && /^[0-9A-Z]{12,20}$/i.test(tail)) return tail.toUpperCase();
  }
  return null;
}

function arr(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

async function detectWindows() {
  const raw = (await runPowerShellJson(DETECT_PS, { timeout: 30000 })) || {};
  const usb = arr(raw.usb);
  const disks = arr(raw.disks);
  const mtp = arr(raw.mtp);

  const massStorage = disks
    .map((d) => ({ root: `${d.DeviceID}\\`, label: d.VolumeName, free: Number(d.FreeSpace), size: Number(d.Size) }))
    .filter((d) => d.label === 'Kindle' || looksLikeKindleRoot(d.root));

  const result = {
    connected: usb.length > 0 || massStorage.length > 0 || mtp.length > 0,
    serial: serialFromDeviceIds(usb),
    usbName: usb[0]?.Name || null,
    mode: null,
    root: null,
    mtp: null,
    free: null,
    size: null,
  };

  if (massStorage.length) {
    const d = massStorage[0];
    Object.assign(result, { mode: 'mass-storage', root: d.root, free: d.free, size: d.size });
  } else if (mtp.length) {
    const dev = mtp[0];
    const storage = arr(dev.Storages)[0];
    Object.assign(result, {
      mode: 'mtp',
      mtp: { deviceName: dev.Name, storageName: storage?.Name || null },
      free: storage?.Free != null ? Number(storage.Free) : null,
      size: storage?.Size != null ? Number(storage.Size) : null,
    });
  } else if (usb.length) {
    // Plugged in but not exposing storage: usually the Kindle is showing the
    // "USB drive mode" prompt, is charging-only, or the cable is power-only.
    result.mode = 'usb-only';
  }
  return result;
}

function detectPosix() {
  const candidates = [];
  if (process.platform === 'darwin') candidates.push('/Volumes/Kindle');
  else {
    const user = os.userInfo().username;
    candidates.push(`/media/${user}/Kindle`, `/run/media/${user}/Kindle`, '/mnt/Kindle');
  }
  const root = candidates.find(looksLikeKindleRoot);
  if (!root) return { connected: false, serial: null, mode: null };
  let free = null;
  let size = null;
  try {
    const st = fs.statfsSync(root);
    free = st.bavail * st.bsize;
    size = st.blocks * st.bsize;
  } catch {}
  return { connected: true, serial: null, mode: 'mass-storage', root: root + path.sep, free, size };
}

async function detectKindle() {
  if (process.platform === 'win32') return detectWindows();
  return detectPosix();
}

// Same parsing the kindlemodding.org wizard uses (jailbreakFinder.js).
function getSerialInfo(serial) {
  if (serial.length === 2 || serial.length === 3) return { serial_version: serial.length === 2 ? 0 : 1, device_code: serial };
  if (serial[0] === 'G') {
    if (serial.length < 6) return { error: 'too-short' };
    return { serial_version: 1, device_code: serial.substring(3, 6) };
  }
  if (/^[0-9A-F]/.test(serial)) {
    if (serial.length < 4) return { error: 'too-short' };
    return { serial_version: 0, device_code: serial.substring(2, 4) };
  }
  return { error: 'invalid' };
}

function findModel(serialInput, models) {
  const serial = String(serialInput || '').toUpperCase().replace(/\s/g, '');
  const info = getSerialInfo(serial);
  if (info.error) return { error: info.error };
  for (const kindle of models) {
    if (kindle.serial_version < info.serial_version) continue;
    if (Object.prototype.hasOwnProperty.call(kindle.device_codes, info.device_code)) {
      return {
        model: kindle.generation_nickname,
        name: kindle.amazon_name,
        lastFirmware: kindle.last_firmware,
        releaseYear: kindle.release_year,
      };
    }
  }
  return { error: 'not-found' };
}

module.exports = { detectKindle, findModel };
