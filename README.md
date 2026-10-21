# Kindle Jailbreak Helper

An unofficial Windows desktop companion to the [kindlemodding.org jailbreak guide](https://kindlemodding.org/jailbreaking/). Use it to jailbreak a Kindle step by step, check and repair an existing jailbreak, install KOReader, and customise it. Built with Electron and React.

> **Not affiliated with KindleModding, KOReader or Amazon.** Jailbreaking changes your device and is done at your own risk. Always read the official guide; the app links to it at every step. Jailbreaking has nothing to do with piracy.

## Download

Get the latest version from the [Releases page](https://github.com/mavingaw/kindle-jailbreak-helper/releases/latest):

- **`Kindle Jailbreak Helper Setup x.y.z.exe`**: an installer.
- **`Kindle Jailbreak Helper x.y.z.exe`**: a portable version that needs no installation.

The builds are not code-signed, so Windows SmartScreen may warn you the first time. Click **More info → Run anyway**.

## What it does

- **Helper tab**: a 7-step walkthrough.
  1. **Overview.** You confirm you've read the site's overview page.
  2. **Find the Kindle.** Detects the Kindle over USB, either as a drive (mass storage) or as an MTP device. Reads the serial number from USB and looks up the model in the site's `models.json`.
  3. **Recommend a jailbreak.** Uses the site's live `jailbreaks.json` and the same matching rules as `jailbreakFinder.js`. If the site can't be reached, it falls back to a cached copy, then to the copy bundled in `data/`.
  4. **Block updates.** Finds and deletes pending `update*.bin` files, and fills storage into `fill_disk/` down to about 60 MB free.
  5. **Install.** Downloads the release and copies it to the right place: WinterBreak, WinterBreak2, Nosebleed, SpiderCat. Patches `system/.assets` for AdBreak, keeping a backup. Starts `springbreak.exe` for SpringBreak. Véra and Sanctuary are done from the Kindle's browser, so they get instructions only.
  6. **On the Kindle.** A checklist of the steps you do on the device.
  7. **Cleanup.** Removes filler and update files, and links to What's Next.
- **Check my Kindle tab**: a read-only scan of an already-jailbroken Kindle. It recognises both the modern setup (KPM and scriptlets, `JAILBROKEN.txt`) and the older one (hotfix, KUAL, MRPI). It reports on the jailbreak, the hotfix, KUAL/MRPI, update blocking, KOReader and leftovers, and offers fixes: move a misplaced KOReader into place, delete stray copies, delete pending `update*.bin` files, delete `fill_disk`, and delete Mac `._` files. Fixes need the Kindle connected as a USB drive.
- **KOReader installer**: installs the same KPM package as `;kpm install koreader`, downloaded from the KindleModding repository. It copies `koreader/` and adds `extensions/koreader` if KUAL is present. On the modern setup it also adds a "KOReader" library item (`documents/KOReader.sh`) that starts KOReader directly. The build (`kindlehf` or `kindlepw2`) is read from the installed copy, or from the firmware version (5.16.3 and newer is `kindlehf`). Settings are kept on update.
- **Guided upgrade** (on the Check my Kindle tab, for the older hotfix + KUAL setup):
  - The app downloads the official `kindlemodding.org/jb.sh` and checks it before copying. It must be a shell script that mentions `RUN_MODE`, has a version line and is over 1 MB.
  - It installs a KUAL entry, `extensions/kjh_upgrade`, which runs `jb.sh` with `RUN_MODE=1`, the payload's mode for Kindles that are already jailbroken. The payload is offline, so the Kindle stays in Airplane mode. It installs KPM, sh_integration (scriptlets), the hotfix runner and update blocking, writes `documents/JAILBROKEN.txt`, and reboots.
  - Output is captured to `kjh-upgrade.log`. When the Kindle is plugged back in, the app checks the result and offers to remove the KUAL entry.
- **Customize tab** (USB-drive Kindles with KOReader):
  - **Home screen:** one-click install and switching between KOReader home-screen plugins: Project: Title, Simple UI and ZenOS. Only one is active at a time; the others are parked in `koreader/plugins-off`. Choosing Project: Title switches Cover Browser off in `settings.reader.lua` (a backup is saved first), and the app reads Project: Title's own list of compatible KOReader versions before installing. "Use standard" reverts.
  - **Sleep-screen images:** cropped and resized to the model's screen, saved in `screensavers/`.
  - **Fonts:** copied to `fonts/` (Kindle reader) and/or `koreader/fonts`.
  - **StarDict dictionaries:** individual files or a .zip, installed to `koreader/data/dict/<name>`.
  - Releases are resolved from GitHub's release pages, not the rate-limited API.
- **Guide tab**: the live site in an embedded view. Every page you open is cached, so it also works offline. "Save guide for offline" saves the whole jailbreaking section in advance.

## Run / build

```bash
npm install
npm start          # build UI + launch
npm run dist       # Windows installer + portable exe → release/
```

## Notes

- Mass-storage operations work on Windows, macOS and Linux. USB serial detection and MTP copying are Windows-only, using PowerShell and the Windows Shell.
- On MTP Kindles (11th gen and newer), the filler, the AdBreak patch and update-file deletion are manual. The app opens the device in File Explorer and links the MTP filler packs.
- App data (downloads, backups, guide cache) is stored in `%APPDATA%\kindle-jailbreak-helper`.
- Jailbreaks, KOReader and plugins are downloaded at run time from their official sources (kindlemodding.org, the KindleModding GitHub repositories, and each plugin's GitHub releases). None of them are bundled in this repository.

## Credits and licenses

- **App code:** MIT license, see [LICENSE](LICENSE).
- **Jailbreak data:** `data/models.json` and `data/jailbreaks.json` are copied unchanged from the [kindlemodding.org](https://kindlemodding.org) project and are licensed CC BY-NC 4.0. See [data/NOTICE.md](data/NOTICE.md).
- **Downloaded projects:** the jailbreaks, the Universal Hotfix and KPM are by the KindleModding contributors. KOReader is by the KOReader team. Project: Title, Simple UI and ZenOS are by their respective authors. All of them keep their own licenses.
