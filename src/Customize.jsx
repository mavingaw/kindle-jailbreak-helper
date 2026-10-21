import { useEffect, useRef, useState } from 'react';

function useBusy() {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = async (key, fn, after) => {
    setBusy(key);
    setError(null);
    try {
      const v = await fn();
      await after?.();
      return v;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

function FileList({ items, onRemove, empty }) {
  if (!items?.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="filelist">
      {items.map((n) => (
        <li key={n}>
          <span>{n}</span>
          {onRemove && (
            <button className="link" onClick={() => onRemove(n)}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Customize({ active, logs, liveDevice }) {
  const [st, setSt] = useState(null);
  const [fontTargets, setFontTargets] = useState({ kindle: true, koreader: true });
  const { busy, error, run } = useBusy();
  const logRef = useRef(null);

  const refresh = async () => {
    try {
      setSt(await window.api.customStatus());
    } catch {}
  };
  const liveKey = `${liveDevice?.connected}|${liveDevice?.mode}|${liveDevice?.root}`;
  useEffect(() => {
    if (active) refresh();
  }, [active, liveKey]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const confirmRemove = (what, fn) => confirm(`Remove ${what} from the Kindle?`) && run('remove', fn, refresh);
  const ready = st?.ready;
  const ko = st?.koreader;
  const activeUI = st?.uis?.find((u) => u.active);

  return (
    <div className="health">
      <div className="step-body">
        <h2>Customize</h2>
        <p className="muted">
          Change how your jailbroken Kindle looks. Everything here copies files over USB and can be undone. Close KOReader on the
          Kindle before plugging it in, so it doesn't overwrite changes when it closes.
        </p>
        {!ready && <div className="callout warn">{st?.reason || 'Looking for the Kindle…'}</div>}
        {error && <div className="callout warn">{error}</div>}

        {ready && (
          <>
            <div className="card">
              <h3>KOReader home screen</h3>
              <div className="callout small">
                These change what you see <b>inside KOReader</b>. The Kindle's own home screen stays the same. To see them, open
                KOReader: tap the <b>KOReader</b> book in your library (modern setup), or open <b>KUAL → KOReader → Start KOReader</b>.
                Changes show up the next time KOReader starts.
              </div>
              <p className="small muted">Only one can be on at a time. Choosing one switches the others off without deleting them.</p>
              {!ko && <p className="warn-text">Install KOReader first (Check my Kindle tab).</p>}
              {ko && <p className="small">KOReader on the Kindle: {st.koreaderVersion}</p>}
              <div className="ui-grid">
                {st.uis.map((u) => (
                  <div key={u.id} className={`ui-option ${u.active ? 'selected' : ''}`}>
                    <div className="row space">
                      <b>{u.name}</b>
                      {u.active && <span className="tag">on{u.version ? ` · ${u.version}` : ''}</span>}
                      {!u.active && u.parked && <span className="tag neutral">installed, off</span>}
                    </div>
                    <p className="small muted">{u.blurb}</p>
                    {u.tooOld && <p className="small warn-text">Needs a newer KOReader.</p>}
                    <button
                      className={u.active ? '' : 'primary'}
                      disabled={!ko || !!busy || u.tooOld}
                      onClick={() => run(u.id, () => window.api.setHomeUI(u.id), refresh)}
                    >
                      {busy === u.id ? 'Installing…' : u.active ? 'Update' : u.parked ? 'Switch on (and update)' : 'Install and use'}
                    </button>
                  </div>
                ))}
                <div className={`ui-option ${!activeUI ? 'selected' : ''}`}>
                  <div className="row space">
                    <b>Standard KOReader</b>
                    {!activeUI && <span className="tag">on</span>}
                  </div>
                  <p className="small muted">KOReader's own file browser with Cover Browser.</p>
                  <button disabled={!ko || !!busy || !activeUI} onClick={() => run('reset', () => window.api.resetHomeUI(), refresh)}>
                    {busy === 'reset' ? 'Switching…' : 'Use standard'}
                  </button>
                </div>
              </div>
              {activeUI && (
                <p className="small">
                  Next time KOReader starts it shows <b>{activeUI.name}</b>. If you don't see it, in KOReader open the menu → Tools (wrench) →
                  More tools → Plugin management and make sure <b>{activeUI.name}</b> is ticked
                  {activeUI.id === 'projecttitle' ? ' and Cover Browser is not' : ''}, then restart KOReader.
                </p>
              )}
            </div>

            <div className="card">
              <h3>Sleep screen images</h3>
              <p className="small muted">
                Pictures are cropped and resized to your screen ({st.screen[0]}×{st.screen[1]}) and saved in <code>screensavers</code>. In
                KOReader: menu → Settings (gear) → Screen → Sleep screen → Wallpaper → choose "random image from folder" and pick
                <code>screensavers</code>. They show while KOReader is open. The Kindle's own lockscreen (with ads on ad-supported
                models) is not changed.
              </p>
              <FileList items={st.sleep} empty="No images yet." onRemove={(n) => confirmRemove(n, () => window.api.removeSleepImage(n))} />
              <button disabled={!!busy} onClick={() => run('sleep', () => window.api.addSleepImages(), refresh)}>
                {busy === 'sleep' ? 'Adding…' : 'Add images…'}
              </button>
            </div>

            <div className="card">
              <h3>Fonts</h3>
              <p className="small muted">
                Add .ttf or .otf fonts. The Kindle's own reader lists fonts from <code>fonts</code> (restart the Kindle to see them);
                KOReader uses <code>koreader/fonts</code>.
              </p>
              <div className="row">
                <label className="inline">
                  <input type="checkbox" checked={fontTargets.kindle} onChange={(e) => setFontTargets({ ...fontTargets, kindle: e.target.checked })} />
                  Kindle reader
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={fontTargets.koreader && ko}
                    disabled={!ko}
                    onChange={(e) => setFontTargets({ ...fontTargets, koreader: e.target.checked })}
                  />
                  KOReader
                </label>
              </div>
              <FileList items={st.fonts} empty="No custom fonts in the Kindle's fonts folder." onRemove={(n) => confirmRemove(n, () => window.api.removeFont(n))} />
              <button
                disabled={!!busy || !(fontTargets.kindle || (fontTargets.koreader && ko))}
                onClick={() =>
                  run('fonts', () => window.api.addFonts(Object.keys(fontTargets).filter((k) => fontTargets[k] && (k !== 'koreader' || ko))), refresh)
                }
              >
                {busy === 'fonts' ? 'Copying…' : 'Add fonts…'}
              </button>
            </div>

            <div className="card">
              <h3>Dictionaries (KOReader)</h3>
              <p className="small muted">
                Add StarDict dictionaries: pick the .ifo, .idx and .dict/.dict.dz files, or a .zip that contains them. They go in
                <code>koreader/data/dict</code>. In KOReader, long-press a word to look it up.
              </p>
              {!ko && <p className="warn-text small">Needs KOReader.</p>}
              <FileList items={st.dicts} empty="No KOReader dictionaries yet." onRemove={(n) => confirmRemove(n, () => window.api.removeDictionary(n))} />
              <button disabled={!!busy || !ko} onClick={() => run('dict', () => window.api.addDictionaries(), refresh)}>
                {busy === 'dict' ? 'Adding…' : 'Add dictionary…'}
              </button>
            </div>
          </>
        )}
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
