import { useEffect, useRef, useState } from 'react';
import { formatBytes } from './format.js';

const ICON = { ok: '✓', warn: '!', problem: '✕', missing: '–', info: 'i' };
const SETUP = {
  modern: 'Modern jailbreak (KPM, scriptlets)',
  older: 'Older jailbreak (hotfix, KUAL, MRPI)',
  none: 'No jailbreak found',
};

function savedFirmware() {
  try {
    return JSON.parse(localStorage.getItem('answers') || '{}').firmware || '';
  } catch {
    return '';
  }
}

// "v2025.10" / "v2026.07.1" / "2026.7.2" → comparable numbers.
function versionParts(v) {
  return String(v || '')
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0);
}
function isNewer(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function KOReaderInstaller({ device, current, onDone }) {
  const [pkgs, setPkgs] = useState(null);
  const [pkgError, setPkgError] = useState(null);
  const [platform, setPlatform] = useState(current?.platform || '');
  const [firmware, setFirmware] = useState(savedFirmware);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    window.api.koreaderPackages().then(setPkgs).catch((e) => setPkgError(e.message));
  }, []);
  // The build already on the Kindle is the surest answer; otherwise go by firmware.
  useEffect(() => {
    if (current?.platform) setPlatform(current.platform);
  }, [current?.platform]);
  useEffect(() => {
    if (!current?.platform && /^\d+(\.\d+)+$/.test(firmware)) window.api.koreaderPlatform(firmware).then((p) => p && setPlatform(p));
  }, [firmware, current?.platform]);

  const install = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await window.api.installKOReader(platform));
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pkg = pkgs?.[platform];
  const installed = current?.installed;
  const updateAvailable = installed && pkg && isNewer(pkg.version, current.version);
  const upToDate = installed && pkg && !updateAvailable;
  return (
    <div className="card">
      <h3>{installed ? 'Update KOReader' : 'Install KOReader'}</h3>
      <p className="muted small">
        Installs the same package as <code>;kpm install koreader</code>: the <code>koreader</code> folder, plus a KUAL entry if KUAL
        is installed, or a "KOReader" item in your library on modern jailbreaks. Your KOReader settings, history and plugins are kept.
      </p>
      {installed && (
        <p>
          On the Kindle: <b>KOReader {current.version || '(unknown version)'}</b>
          {current.platform && <span className="muted"> ({current.platform} build)</span>}
          {pkg && (updateAvailable ? <> · <b className="warn-text">update available: {pkg.version}</b></> : <span className="ok"> · up to date</span>)}
        </p>
      )}
      <div className="row">
        {!current?.platform && (
          <label className="inline">
            Firmware
            <input value={firmware} placeholder="e.g. 5.18.1" onChange={(e) => setFirmware(e.target.value.replace(/[^0-9.]/g, ''))} style={{ width: 130 }} />
          </label>
        )}
        <label className="inline">
          Build
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">Choose…</option>
            <option value="kindlehf">kindlehf (firmware 5.16.3 and newer)</option>
            <option value="kindlepw2">kindlepw2 (older firmware)</option>
          </select>
        </label>
      </div>
      {pkgError && <p className="error small">{pkgError}</p>}
      {current?.platform && <span className="muted small">Build detected from the copy on your Kindle.</span>}
      {!pkgs && !pkgError && <p className="small muted">Checking for the latest version…</p>}
      {pkgs && platform && !installed && (pkg ? <p className="small muted">Latest: KOReader {pkg.version}</p> : <p className="error small">No package for {platform}.</p>)}
      <div className="row">
        <button className={upToDate ? '' : 'primary'} disabled={!pkg || busy || !device?.connected} onClick={install}>
          {busy ? 'Installing… (see the log below)' : !installed ? 'Install KOReader' : updateAvailable ? `Update to ${pkg.version}` : 'Reinstall KOReader'}
        </button>
      </div>
      {!device?.connected && <p className="muted small">Connect the Kindle to install.</p>}
      {error && <p className="error">{error}</p>}
      {done && (
        <p className="ok">
          KOReader {done.version} installed. Safely eject the Kindle, then start it from {done.where || 'your launcher'}.
        </p>
      )}
    </div>
  );
}

function UpgradeCard({ setup, scanned, onChange }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const refresh = () => window.api.upgradeCheck().then(setSt).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, [scanned]);
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
      onChange();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  if (!st?.applicable) return null;

  if (st.state === 'done') {
    if (!st.viaHelper && !st.staged && setup === 'modern') return null; // jailbroken the modern way to begin with
    return (
      <div className="card upgrade done">
        <h3>Modern setup: installed {st.modernVersion ? `(jb.sh ${st.modernVersion})` : ''}</h3>
        <p>
          Your Kindle now has KPM and scriptlets. Updates are blocked by the jailbreak, and KUAL still works. Things to try on the
          Kindle:
        </p>
        <ul>
          <li>
            Type <code>;kpm update</code> in the home-screen search bar and press Enter (needs Wi-Fi). Turn Airplane mode back on
            afterwards if you like.
          </li>
          <li>
            Any <code>.sh</code> scriptlet you put in <code>documents</code> now shows up as a book and runs when tapped.
          </li>
          <li>Use the KOReader card below to add a "KOReader" item to your library.</li>
        </ul>
        {st.problems?.length > 0 && (
          <div className="callout warn small">
            The upgrade log mentions possible problems:
            <ul>
              {st.problems.map((p, i) => (
                <li key={i}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {st.staged && (
          <button disabled={!!busy} onClick={() => act('cleanup', () => window.api.upgradeCleanup())}>
            {busy === 'cleanup' ? 'Removing…' : 'Remove the upgrade entry from KUAL'}
          </button>
        )}
      </div>
    );
  }

  if (setup !== 'older') return null;
  const ready = !st.blockers?.length;
  return (
    <div className="card upgrade">
      <h3>Upgrade to the modern setup (KPM + scriptlets)</h3>
      <p className="small">
        Your Kindle uses the older setup{st.hotfix ? ` (Universal Hotfix ${st.hotfix})` : ''} with KUAL. The upgrade runs the official
        kindlemodding.org jailbreak script (<code>jb.sh</code>) in its mode for Kindles that are already jailbroken. It adds KPM, scriptlets
        and automatic update blocking, and refreshes the hotfix. KUAL, KOReader and your books are not touched. The script works offline,
        so the Kindle stays in Airplane mode the whole time.
      </p>
      {st.blockers?.map((b, i) => (
        <p key={i} className="error small">
          {b}
        </p>
      ))}
      <ol className="steps-list">
        <li className={st.staged ? 'done' : ''}>
          <b>Put the upgrade on the Kindle.</b>{' '}
          {st.staged ? (
            <span className="ok">Done.</span>
          ) : (
            <button className="primary" disabled={!ready || !!busy} onClick={() => act('stage', () => window.api.upgradeStage())}>
              {busy === 'stage' ? 'Copying…' : 'Prepare upgrade'}
            </button>
          )}
        </li>
        <li>
          <b>On the Kindle:</b> make sure it's charged (over 50%) and <b>Airplane mode is on</b>. Safely eject it from Windows and unplug.
        </li>
        <li>
          Open <b>KUAL</b> from your library → <b>Kindle Jailbreak Helper</b> → <b>Upgrade to KPM + scriptlets</b>. Text scrolls for
          about a minute, then the Kindle restarts by itself. Don't press anything or unplug it meanwhile.
        </li>
        <li>
          <b>Plug it back in</b> and come back to this tab. The app checks the result automatically.
        </li>
      </ol>
      {st.state === 'ran-without-result' && (
        <div className="callout warn small">
          The upgrade started but didn't finish. Last lines it printed:
          <pre>{st.log?.join('\n')}</pre>
          Ask for help on the KindleModding Discord with this log (it's saved as <code>kjh-upgrade.log</code> on the Kindle).
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// Universal Hotfix install/update, for the older setup only. On the modern
// setup the hotfix comes with the jailbreak and the standalone one would
// remove KPM, so the card is not shown there.
function HotfixCard({ setup, scanned, onChange }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const refresh = () => window.api.hotfixStatus().then(setSt).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, [scanned]);
  if (setup !== 'older' || !st?.applicable || st.modern) return null;
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
      onChange();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const outdated = st.installed && st.latest && st.installed !== st.latest;
  const title = !st.installed ? 'Install the hotfix' : outdated ? `Update the hotfix (${st.installed} → ${st.latest})` : 'Hotfix';
  if (st.installed && !outdated && !st.staged) return null;
  return (
    <div className="card upgrade">
      <h3>{title}</h3>
      <p className="small">
        The Universal Hotfix keeps the jailbreak working after Kindle updates.{' '}
        {outdated && 'If you plan to do the modern upgrade above, skip this: the upgrade includes it. Use this to stay on the KUAL setup.'}
      </p>
      <ol className="steps-list">
        <li className={st.staged ? 'done' : ''}>
          <b>Put the hotfix on the Kindle.</b>{' '}
          {st.staged ? (
            <>
              <span className="ok">Done.</span>{' '}
              <button className="link" disabled={!!busy} onClick={() => act('unstage', () => window.api.hotfixUnstage())}>
                Remove it again
              </button>
            </>
          ) : (
            <button className="primary" disabled={!!busy} onClick={() => act('stage', () => window.api.hotfixStage())}>
              {busy === 'stage' ? 'Downloading…' : `Copy hotfix ${st.latest || ''}`}
            </button>
          )}
        </li>
        <li>
          On the Kindle, turn on <b>Airplane mode</b>, then safely eject and unplug it.
        </li>
        <li>
          Open <b>KUAL → Rename OTA binaries → Restore</b>. The Kindle restarts. (Updates can't install while they are blocked,
          and that includes the hotfix.)
        </li>
        <li>
          Open <b>Settings → ⋮ (top right) → Update Your Kindle</b> and confirm. Text scrolls and the Kindle restarts.
        </li>
        <li>
          Open the <b>Run Hotfix</b> book from your library.
        </li>
        <li>
          Block updates again: <b>KUAL → Rename OTA binaries → Rename</b>. Then plug the Kindle back in; the scan shows the new
          version.
        </li>
      </ol>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function Health({ active, logs, liveDevice }) {
  const [result, setResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState(null);
  const [error, setError] = useState(null);
  const logRef = useRef(null);

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      setResult(await window.api.scanKindle());
    } catch (e) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (active && !result && !scanning) scan();
  }, [active]);
  // Rescan by itself when the Kindle is plugged in, unplugged, or its storage finally mounts.
  const liveKey = `${liveDevice?.connected}|${liveDevice?.mode}|${liveDevice?.root}`;
  const lastKey = useRef(liveKey);
  useEffect(() => {
    if (lastKey.current === liveKey) return;
    lastKey.current = liveKey;
    if (active && !scanning && !fixing) scan();
  }, [liveKey, active]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const fix = async (f) => {
    if (f.confirm && !confirm(`${f.label}?\n\nThis changes files on the Kindle.`)) return;
    setFixing(f.id);
    setError(null);
    try {
      await window.api.fixKindle(f.id);
      await scan();
    } catch (e) {
      setError(e.message);
    } finally {
      setFixing(null);
    }
  };

  const device = result?.device;
  return (
    <div className="health">
      <div className="step-body">
        <h2>Check my Kindle</h2>
        <p className="muted">
          Looks at the files on the Kindle to see what an earlier jailbreak installed and whether anything is in the wrong place.
          Scanning only reads; nothing changes until you press a fix button.
        </p>
        <div className="row">
          <button className="primary" disabled={scanning || !!fixing} onClick={scan}>
            {scanning ? 'Scanning…' : result ? 'Scan again' : 'Scan'}
          </button>
          {device?.connected && (
            <span className="muted small">
              {device.modelInfo?.name || 'Kindle'} · {device.root || device.mode} · {formatBytes(device.free)} free
            </span>
          )}
          {result?.supported && <span className="tag neutral">{SETUP[result.setup]}</span>}
        </div>
        {error && <p className="error">{error}</p>}
        {result && !result.supported && <div className="callout warn">{result.reason}</div>}

        {result?.supported &&
          result.checks.map((c) => (
            <div key={c.id} className={`check ${c.status}`}>
              <span className="check-icon">{ICON[c.status]}</span>
              <div className="grow">
                <h3>{c.title}</h3>
                <p>{c.summary}</p>
                {c.details?.length > 0 && (
                  <ul className="small muted">
                    {c.details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                )}
                {(c.fixes?.length > 0 || c.link) && (
                  <div className="row">
                    {c.fixes?.map((f) => (
                      <button key={f.id} disabled={!!fixing || scanning} onClick={() => fix(f)}>
                        {fixing === f.id ? 'Working…' : f.label}
                      </button>
                    ))}
                    {c.link && <button onClick={() => window.api.openExternal(c.link)}>Get it</button>}
                  </div>
                )}
              </div>
            </div>
          ))}

        {result?.supported && <UpgradeCard setup={result.setup} scanned={result} onChange={scan} />}
        {result?.supported && <HotfixCard setup={result.setup} scanned={result} onChange={scan} />}

        {(result?.supported || result?.device?.mode === 'mtp') && <KOReaderInstaller device={device} current={result?.koreader} onDone={scan} />}
      </div>
      <div className="log" ref={logRef}>
        {logs.length === 0 ? (
          <span className="muted">Activity log</span>
        ) : (
          logs.map((l, i) => (
            <div key={i}>
              <span className="muted">{new Date(l.time).toLocaleTimeString()}</span> {l.msg}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
