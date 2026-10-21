import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes, formatDuration } from './format.js';

const STEPS = ['Before you start', 'Connect Kindle', 'Find jailbreak', 'Block updates', 'Install', 'On the Kindle', 'After'];

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

function useAction() {
  const [state, setState] = useState({ busy: false, error: null });
  const run = async (fn) => {
    setState({ busy: true, error: null });
    try {
      const v = await fn();
      setState({ busy: false, error: null });
      return v;
    } catch (e) {
      setState({ busy: false, error: e.message });
      return undefined;
    }
  };
  return [state, run];
}

function ErrorLine({ error }) {
  return error ? <p className="error">{error}</p> : null;
}

function Checklist({ items, id }) {
  const [checked, setChecked] = useState(() => load(`check:${id}`, {}));
  if (!items?.length) return null;
  return (
    <ul className="checklist">
      {items.map((t, i) => (
        <li key={i}>
          <label>
            <input
              type="checkbox"
              checked={!!checked[i]}
              onChange={(e) => {
                const next = { ...checked, [i]: e.target.checked };
                setChecked(next);
                save(`check:${id}`, next);
              }}
            />
            <span>{t}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

// ---------- step 1 ----------

function StepIntro({ ack, setAck, openGuide, next }) {
  return (
    <>
      <h2>Before you start</h2>
      <p>
        This app walks you through the <b>kindlemodding.org</b> jailbreak guide: it finds your Kindle, picks a jailbreak with the
        site's own wizard rules, and handles the PC side (downloads, copying files, blocking updates). Steps on the Kindle are
        listed, and the full guide is always in the <b>Guide</b> tab.
      </p>
      <div className="callout">
        <ul>
          <li>Jailbreaking lets your Kindle run your own code. It has nothing to do with piracy and does not make store books free.</li>
          <li>There is no "best" jailbreak. Use the one the wizard picks for your model and firmware.</li>
          <li>Do <b>not</b> factory reset a jailbroken Kindle without help from someone experienced.</li>
          <li>Help: the KindleModding Discord, or r/kindlejailbreak.</li>
        </ul>
      </div>
      <p>The site asks you to read its overview page before using the wizard.</p>
      <div className="row">
        <button onClick={() => openGuide('/jailbreaking/')}>Read the overview</button>
        <label className="inline">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read the overview
        </label>
      </div>
      <div className="nav">
        <span />
        <button className="primary" disabled={!ack} onClick={next}>
          Next
        </button>
      </div>
    </>
  );
}

// ---------- step 2 ----------

function StepConnect({ device, refresh, serial, setSerial, model, setModel, next, back }) {
  const [lookup, setLookup] = useState(null);

  useEffect(() => {
    if (device?.serial && !serial) setSerial(device.serial);
  }, [device?.serial]);

  useEffect(() => {
    const s = serial.trim();
    if (!s) {
      setLookup(null);
      setModel(null);
      return;
    }
    let live = true;
    window.api.lookupSerial(s).then((r) => {
      if (!live) return;
      setLookup(r);
      setModel(r.error ? null : r);
    });
    return () => {
      live = false;
    };
  }, [serial]);

  const errorText = { 'too-short': 'Serial number too short', invalid: 'Serial number not valid', 'not-found': 'No Kindle model matches this serial' };

  return (
    <>
      <h2>Connect your Kindle</h2>
      <p>Plug the Kindle into this PC with a data USB cable. It should show up in File Explorer.</p>
      <div className="card">
        {!device?.connected && <p className="muted">No Kindle found yet. This checks again every few seconds.</p>}
        {device?.connected && (
          <dl>
            <dt>Connection</dt>
            <dd>
              {device.mode === 'mass-storage' && `USB drive (${device.root})`}
              {device.mode === 'mtp' && `MTP device "${device.mtp?.deviceName}"${device.mtp?.storageName ? ` / ${device.mtp.storageName}` : ''}`}
              {device.mode === 'usb-only' &&
                'Plugged in. Waiting for Windows to open its storage, which can take up to a minute. If the Kindle shows a USB prompt, tap it. If nothing happens, try another cable (some only charge).'}
            </dd>
            <dt>Free space</dt>
            <dd>{device.free != null ? `${formatBytes(device.free)} of ${formatBytes(device.size)}` : 'unknown'}</dd>
            <dt>Serial from USB</dt>
            <dd>{device.serial || 'not reported'}</dd>
          </dl>
        )}
        <div className="row">
          <button onClick={refresh}>Scan again</button>
          {device?.connected && <button onClick={() => window.api.openKindle()}>Open in File Explorer</button>}
        </div>
      </div>

      <h3>Serial number</h3>
      <p className="muted small">
        Filled in from USB when possible. Otherwise find it on the Kindle: menu (three dots) → Settings → Device options → Device info.
        The first 8 characters are enough.
      </p>
      <input className="wide" value={serial} placeholder="e.g. G000PP12…" onChange={(e) => setSerial(e.target.value.toUpperCase())} />
      {lookup?.error && <p className="error">{errorText[lookup.error]}</p>}
      {model && (
        <p className="ok">
          Found: <b>{model.name}</b> ({model.model})
        </p>
      )}
      <div className="nav">
        <button onClick={back}>Back</button>
        <button className="primary" disabled={!model} onClick={next}>
          Next
        </button>
      </div>
    </>
  );
}

// ---------- step 3 ----------

function StepFind({ model, answers, setAnswers, matches, setMatches, choice, setChoice, openGuide, next, back }) {
  const [state, run] = useAction();
  const fwOk = /^\d{1,2}(\.\d{1,2}){1,5}$/.test(answers.firmware) && parseInt(answers.firmware, 10) <= 5;
  const ready = fwOk && answers.registered !== '' && answers.ads !== '';

  const find = () =>
    run(async () => {
      const m = await window.api.match({
        model: model.model,
        firmware: answers.firmware,
        blacklisted: answers.registered === 'no',
        ads: answers.ads === 'yes',
      });
      setMatches(m);
      setChoice(m[0]?.name || null);
    });

  const set = (k) => (e) => {
    setAnswers({ ...answers, [k]: k === 'firmware' ? e.target.value.replace(/[^0-9.]/g, '') : e.target.value });
    setMatches(null);
  };

  return (
    <>
      <h2>Find your jailbreak</h2>
      <p className="muted">
        Model: <b>{model?.name}</b>. These are the same questions and rules as the site's wizard.
      </p>
      <label className="field">
        <span>Firmware version (Settings → Device options → Device info)</span>
        <input value={answers.firmware} placeholder="e.g. 5.17.1.0.3" onChange={set('firmware')} />
        {answers.firmware && !fwOk && <small className="error">Format looks wrong. Copy it exactly, e.g. 5.16.2.1.1</small>}
      </label>
      <label className="field">
        <span>Can your Kindle be registered to an Amazon account?</span>
        <select value={answers.registered} onChange={set('registered')}>
          <option value="">Choose…</option>
          <option value="yes">Yes, it can be registered</option>
          <option value="no">No, it cannot be registered (blacklisted)</option>
        </select>
      </label>
      <label className="field">
        <span>Does it show ads on the lockscreen?</span>
        <select value={answers.ads} onChange={set('ads')}>
          <option value="">Choose…</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
          <option value="unsure">I'm not sure</option>
        </select>
      </label>
      <button className="primary" disabled={!ready || state.busy} onClick={find}>
        {state.busy ? 'Checking…' : 'Find jailbreak'}
      </button>
      <ErrorLine error={state.error} />

      {matches && matches.length === 0 && (
        <div className="callout warn">
          <b>No jailbreak is available</b> for this model and firmware yet. Keep the Kindle offline (Airplane mode) and check back later.
        </div>
      )}
      {matches && matches.length > 0 && (
        <div className="results">
          <p>
            Recommended: <b>{matches[0].name}</b>
            {matches.length === 1 && ' (the only option for this firmware and model, so be careful)'}
          </p>
          {matches.map((m, i) => (
            <label key={m.name} className={`result ${choice === m.name ? 'selected' : ''}`}>
              <input type="radio" name="jb" checked={choice === m.name} onChange={() => setChoice(m.name)} />
              <span className="grow">
                <b>{m.name}</b> {i === 0 && <em className="tag">recommended</em>}
                <br />
                <small className="muted">
                  {{ copy: 'Helper copies the files for you', 'merge-assets': 'Helper patches system/.assets for you', 'run-exe': 'Helper downloads and starts the jailbreak tool', browser: 'Done from the Kindle web browser', guide: 'Follow the guide page' }[m.plan.kind]}
                </small>
              </span>
              <button className="link" onClick={(e) => (e.preventDefault(), openGuide(m.url))}>
                Guide page
              </button>
            </label>
          ))}
        </div>
      )}
      <div className="nav">
        <button onClick={back}>Back</button>
        <button className="primary" disabled={!choice} onClick={next}>
          Next
        </button>
      </div>
    </>
  );
}

// ---------- step 4 ----------

function useFillProgress() {
  const [p, setP] = useState(null);
  useEffect(() => {
    window.api.fillStatus().then((s) => s && setP(s)).catch(() => {});
    return window.api.onProgress((x) => x.task === 'fill' && setP(x));
  }, []);
  return [p, setP];
}

function fillPercent(fill) {
  if (!fill) return 0;
  const total = fill.written + Math.max(0, fill.free - fill.target);
  return total > 0 ? Math.min(100, (fill.written / total) * 100) : 100;
}

function FillStatusLine({ fill }) {
  if (!fill) return null;
  if (fill.error) return <span className="error">Fill failed: {fill.error}</span>;
  if (fill.done) return <span>{fill.cancelled ? 'Stopped' : 'Done'} · {formatBytes(fill.free)} free</span>;
  return (
    <span>
      {formatBytes(fill.free)} free · {fill.rate ? `${(fill.rate / 1048576).toFixed(1)} MB/s` : 'measuring speed…'} · about{' '}
      {formatDuration(fill.eta)} left
    </span>
  );
}

function UpdateFiles({ device, refreshKey }) {
  const [files, setFiles] = useState(null);
  const [state, run] = useAction();
  const reload = () => run(async () => setFiles(await window.api.listUpdates()));
  useEffect(() => {
    if (device?.connected) reload();
  }, [device?.connected, device?.mode, refreshKey]);
  return (
    <div className="card">
      <h3>1. Remove pending update files</h3>
      <p className="muted small">Any update*.bin in the Kindle's root would install a new firmware and can block the jailbreak.</p>
      {files == null && <p className="muted">Checking…</p>}
      {files?.length === 0 && <p className="ok">None found.</p>}
      {files?.length > 0 && (
        <>
          <p className="warn-text">Found: {files.join(', ')}</p>
          {device.mode === 'mass-storage' ? (
            <button
              disabled={state.busy}
              onClick={() => confirm(`Delete ${files.join(', ')} from the Kindle?`) && run(async () => (await window.api.removeUpdates(), setFiles(await window.api.listUpdates())))}
            >
              Delete these files
            </button>
          ) : (
            <button onClick={() => window.api.openKindle()}>Open the Kindle to delete them</button>
          )}
        </>
      )}
      <ErrorLine error={state.error} />
    </div>
  );
}

function SkipFillCard({ plan, skip, setSkip }) {
  return (
    <div className="card">
      <h3>Keep it in Airplane mode instead?</h3>
      <p>
        Filling is only there to stop a firmware update from downloading while the Kindle is online. An update can patch the hole
        the jailbreak uses, and then this jailbreak won't work on your Kindle.
      </p>
      <p>
        <b>This jailbreak needs the Kindle online at one point:</b> {plan.onlineAt}
      </p>
      <label className="inline skip">
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
        <span>
          Skip filling. I'll keep Airplane mode on until that exact step and turn it back on as soon as the jailbreak has run. I
          accept that an update could still download in that window.
        </span>
      </label>
      {skip && (
        <p className="small warn-text">
          Skipping. Before you go online, make sure no update file is waiting (above). After the jailbreak, the last step checks again
          for a downloaded update.
        </p>
      )}
    </div>
  );
}

function StepBlock({ device, plan, fill, setFill, skipFill, setSkipFill, openGuide, next, back }) {
  const [target, setTarget] = useState(60);
  const [state, run] = useAction();
  const [info, setInfo] = useState(null);
  const filling = fill && !fill.done;

  useEffect(() => {
    if (device?.mode === 'mass-storage') window.api.fillerInfo().then(setInfo).catch(() => {});
  }, [device?.mode, fill?.done]);

  const pct = fillPercent(fill);

  return (
    <>
      <h2>Block automatic updates</h2>
      <p>
        Keep the Kindle in <b>Airplane mode</b> until the jailbreak step says otherwise. Filling the storage stops a new firmware from
        downloading if it does go online.{' '}
        <button className="link" onClick={() => openGuide('/jailbreaking/prevent-auto-update/')}>
          Guide page
        </button>
      </p>
      {!device?.connected && <p className="error">Connect the Kindle first.</p>}
      <UpdateFiles device={device} />

      {plan?.usesFiller && !filling && <SkipFillCard plan={plan} skip={skipFill} setSkip={setSkipFill} />}

      <div className={skipFill && !filling ? 'card hidden' : 'card'}>
        <h3>2. Fill the storage</h3>
        {plan && !plan.usesFiller ? (
          <p className="warn-text">Skip this for SpringBreak. It needs free space and fills the Kindle by itself.</p>
        ) : device?.mode === 'mtp' ? (
          <>
            <p>
              This Kindle uses MTP, so the filler script cannot run on it. Download the filler pack that matches your storage size,
              extract it, and copy it to the Kindle's root.
            </p>
            <div className="row">
              <button onClick={() => window.api.openExternal('https://github.com/Crosunt223/Kindle-Filler-Disk/tree/main/MTP')}>
                Get MTP filler files
              </button>
              <button onClick={() => window.api.openKindle()}>Open the Kindle</button>
            </div>
          </>
        ) : device?.mode === 'mass-storage' ? (
          <>
            <p className="muted small">
              Writes files into <code>fill_disk</code> on the Kindle until only the chosen amount is free. The guide's target is
              50–90 MB. Free now: <b>{formatBytes(device.free)}</b>
              {info?.exists && ` · fill_disk already holds ${formatBytes(info.bytes)} (a new fill continues from there)`}
            </p>
            {!filling && device.free > 2 * 1024 ** 3 && (
              <p className="small warn-text">
                This is slow: Kindles write at only about 4 MB/s over USB, so {formatBytes(device.free)} takes roughly{' '}
                {formatDuration(device.free / (4.2 * 1048576))}. You can carry on with the next steps while it runs. Keep the Kindle
                plugged in and in Airplane mode.
              </p>
            )}
            <div className="row">
              <label className="inline">
                Leave free:
                <input type="number" min={30} max={200} value={target} onChange={(e) => setTarget(Number(e.target.value) || 60)} /> MB
              </label>
              {!filling ? (
                <button className="primary" disabled={state.busy} onClick={() => run(() => (setFill(null), window.api.startFill(target)))}>
                  Fill storage
                </button>
              ) : (
                <button onClick={() => window.api.cancelFill()}>Stop</button>
              )}
            </div>
            {fill && (
              <div className="progress">
                <div style={{ width: `${pct}%` }} />
                <span>
                  <FillStatusLine fill={fill} />
                </span>
              </div>
            )}
            {fill?.done && !fill.cancelled && (
              <p className="ok small">On the Kindle, check Settings → Device options → Device info. Free space should be 50–90 MB or less.</p>
            )}
          </>
        ) : (
          <p className="muted">Connect the Kindle to fill it.</p>
        )}
        <ErrorLine error={state.error} />
      </div>
      <div className="nav">
        <button onClick={back}>Back</button>
        <button className="primary" onClick={next}>
          {filling ? 'Next (fill keeps running)' : 'Next'}
        </button>
      </div>
    </>
  );
}

// ---------- step 5 ----------

function StepInstall({ device, jb, openGuide, next, back }) {
  const plan = jb.plan;
  const [dl, setDl] = useState(null);
  const [prep, setPrep] = useState(null);
  const [done, setDone] = useState(null);
  const [state, run] = useAction();

  useEffect(() => window.api.onProgress((p) => p.task === 'download' && setDl(p)), []);

  if (plan.kind === 'browser' || plan.kind === 'guide') {
    return (
      <>
        <h2>Install {jb.name}</h2>
        <p>
          {plan.kind === 'browser'
            ? `${jb.name} runs entirely from the Kindle's web browser. Nothing needs to be copied from this PC.`
            : 'This jailbreak is not automated here. Follow its guide page.'}
        </p>
        <button onClick={() => openGuide(jb.url)}>Open the {jb.name} guide</button>
        <div className="nav">
          <button onClick={back}>Back</button>
          <button className="primary" onClick={next}>
            Next
          </button>
        </div>
      </>
    );
  }

  const needsDrive = plan.kind === 'merge-assets' && device?.mode !== 'mass-storage';
  const actionLabel = { copy: 'Copy to Kindle', 'merge-assets': 'Patch .assets on Kindle', 'run-exe': `Start ${plan.exe}` }[plan.kind];

  return (
    <>
      <h2>Install {jb.name}</h2>
      {plan.before && (
        <>
          <h3>First, on the Kindle</h3>
          <Checklist items={plan.before} id={`${jb.name}-before`} />
        </>
      )}
      <div className="card">
        <h3>1. Download</h3>
        <p className="muted small">{plan.download.url}</p>
        <div className="row">
          <button disabled={state.busy} onClick={() => run(async () => setPrep(await window.api.prepare(jb.name)))}>
            {prep ? 'Download again' : 'Download'}
          </button>
          {prep && <button onClick={() => window.api.openPrepared(jb.name)}>Show files</button>}
        </div>
        {dl && state.busy && !prep && <p className="muted small">{dl.total ? `${Math.round((dl.got / dl.total) * 100)}%` : formatBytes(dl.got)}</p>}
        {prep && <p className="ok small">Ready: {prep.contents.join(', ')}</p>}
      </div>
      <div className="card">
        <h3>2. {plan.kind === 'run-exe' ? 'Run' : 'Put it on the Kindle'}</h3>
        {plan.expect && <p className="muted small">Result: {plan.expect}</p>}
        {device?.mode === 'mtp' && plan.kind === 'copy' && (
          <p className="warn-text small">MTP copy uses Windows' own copy engine and has not been tested on every model. Check the files in File Explorer afterwards.</p>
        )}
        {needsDrive && (
          <p className="error">
            Patching .assets automatically needs the Kindle as a USB drive. On MTP Kindles, follow the AdBreak guide page by hand.
          </p>
        )}
        <div className="row">
          <button
            className="primary"
            disabled={!prep || state.busy || needsDrive || (plan.kind !== 'run-exe' && !device?.connected)}
            onClick={() => run(async () => setDone(await window.api.install(jb.name)))}
          >
            {state.busy && prep ? 'Working…' : actionLabel}
          </button>
          {device?.connected && <button onClick={() => window.api.openKindle()}>Open the Kindle</button>}
        </div>
        {done && <p className="ok">{plan.kind === 'run-exe' ? 'Started. Continue in the SpringBreak window.' : 'Done.'}</p>}
        {done?.backup && <p className="muted small">Original .assets backed up to {done.backup}</p>}
      </div>
      <ErrorLine error={state.error} />
      <div className="nav">
        <button onClick={back}>Back</button>
        <button className="primary" onClick={next}>
          Next
        </button>
      </div>
    </>
  );
}

// ---------- step 6 & 7 ----------

function StepKindle({ jb, skipFill, openGuide, next, back }) {
  return (
    <>
      <h2>On the Kindle</h2>
      <p>Do these on the Kindle. If anything looks different, follow the guide page.</p>
      {skipFill && jb.plan.usesFiller && (
        <div className="callout warn">
          <b>You skipped filling.</b> Stay in Airplane mode until you reach this point: {jb.plan.onlineAt} Turn Airplane mode back
          on as soon as the jailbreak text appears. Don't leave the Kindle online or let it sleep while connected.
        </div>
      )}
      <Checklist items={jb.plan.onKindle} id={`${jb.name}-kindle`} />
      <button onClick={() => openGuide(jb.url)}>Open the {jb.name} guide</button>
      <div className="nav">
        <button onClick={back}>Back</button>
        <button className="primary" onClick={next}>
          It worked
        </button>
      </div>
    </>
  );
}

function StepAfter({ device, openGuide, openCheck, back }) {
  const [state, run] = useAction();
  const [info, setInfo] = useState(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (device?.mode === 'mass-storage') window.api.fillerInfo().then(setInfo).catch(() => {});
  }, [device?.mode, key]);
  return (
    <>
      <h2>After jailbreaking</h2>
      <p>Updates are blocked by the jailbreak now, so you can get your space back.</p>
      <UpdateFiles device={device} refreshKey={key} />
      <div className="card">
        <h3>2. Remove filler files</h3>
        <p className="muted small">Only after removing any update .bin files above.</p>
        {info?.exists ? (
          <button
            disabled={state.busy}
            onClick={() => confirm(`Delete fill_disk (${formatBytes(info.bytes)}) from the Kindle?`) && run(async () => (await window.api.removeFiller(), setKey((k) => k + 1)))}
          >
            Delete fill_disk ({formatBytes(info.bytes)})
          </button>
        ) : (
          <p className="muted">{device?.mode === 'mtp' ? 'On MTP Kindles, delete the filler files in File Explorer.' : 'No fill_disk folder found.'}</p>
        )}
        <ErrorLine error={state.error} />
      </div>
      <div className="card">
        <h3>3. What's next</h3>
        <p>
          Read the What's Next section: scriptlets, the KPM package manager, and KOReader. On the Kindle you can install KOReader
          with <code>;kpm install koreader</code> in the search bar, or install it from this PC.
        </p>
        <div className="row">
          <button className="primary" onClick={openCheck}>
            Check my Kindle / install KOReader
          </button>
          <button onClick={() => openGuide('/jailbreaking/whats-next/index.html')}>What's Next</button>
          <button onClick={() => openGuide('/jailbreaking/whats-next/getting-koreader/')}>Getting KOReader</button>
        </div>
      </div>
      <div className="nav">
        <button onClick={back}>Back</button>
        <span />
      </div>
    </>
  );
}

// ---------- shell ----------

export function Helper({ device, refresh, openGuide, openCheck, logs, dataInfo }) {
  const [step, setStep] = useState(() => load('step', 0));
  const [ack, setAckState] = useState(() => load('ack', false));
  const [serial, setSerial] = useState(() => load('serial', ''));
  const [model, setModel] = useState(null);
  const [answers, setAnswers] = useState(() => load('answers', { firmware: '', registered: '', ads: '' }));
  const [matches, setMatches] = useState(null);
  const [choice, setChoice] = useState(() => load('choice', null));
  const [fill, setFill] = useFillProgress();
  const [skipFill, setSkipFillState] = useState(() => load('skipFill', false));
  const setSkipFill = (v) => {
    setSkipFillState(v);
    save('skipFill', v);
  };
  const logRef = useRef(null);

  useEffect(() => save('step', step), [step]);
  useEffect(() => save('serial', serial), [serial]);
  useEffect(() => save('answers', answers), [answers]);
  useEffect(() => save('choice', choice), [choice]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // Re-run the match after a restart so later steps have the plan.
  useEffect(() => {
    if (!matches && model && answers.firmware && answers.registered && answers.ads) {
      window.api
        .match({ model: model.model, firmware: answers.firmware, blacklisted: answers.registered === 'no', ads: answers.ads === 'yes' })
        .then(setMatches)
        .catch(() => {});
    }
  }, [model]);

  const setAck = (v) => {
    setAckState(v);
    save('ack', v);
  };
  const jb = useMemo(() => matches?.find((m) => m.name === choice) || null, [matches, choice]);
  const maxStep = !ack ? 0 : !model ? 1 : !jb ? 2 : STEPS.length - 1;
  const current = Math.min(step, maxStep);
  const go = (n) => setStep(Math.max(0, Math.min(n, maxStep)));
  const nav = { next: () => go(current + 1), back: () => go(current - 1) };

  return (
    <div className="helper">
      <aside>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s} className={`${i === current ? 'current' : ''} ${i > maxStep ? 'locked' : ''} ${i < current ? 'done' : ''}`}>
              <button disabled={i > maxStep} onClick={() => go(i)}>
                <span className="num">{i + 1}</span>
                {s}
              </button>
            </li>
          ))}
        </ol>
        {jb && (
          <div className="summary small">
            <div>
              <b>{model?.name}</b>
            </div>
            <div>Firmware {answers.firmware}</div>
            <div>
              Jailbreak: <b>{jb.name}</b>
            </div>
          </div>
        )}
        {fill && !fill.done && (
          <button className="summary small fill-mini" onClick={() => go(3)}>
            <b>Filling storage</b>
            <div className="progress">
              <div style={{ width: `${fillPercent(fill)}%` }} />
            </div>
            <FillStatusLine fill={fill} />
          </button>
        )}
        {dataInfo && (
          <p className="muted tiny">
            Wizard data: {dataInfo.sources.jailbreaks}
            {dataInfo.sources.jailbreaks !== 'live' && ' (offline copy, may be out of date)'}
          </p>
        )}
      </aside>
      <div className="content">
        <div className="step-body">
          {current === 0 && <StepIntro ack={ack} setAck={setAck} openGuide={openGuide} next={nav.next} />}
          {current === 1 && (
            <StepConnect device={device} refresh={refresh} serial={serial} setSerial={setSerial} model={model} setModel={setModel} {...nav} />
          )}
          {current === 2 && (
            <StepFind
              model={model}
              answers={answers}
              setAnswers={setAnswers}
              matches={matches}
              setMatches={setMatches}
              choice={choice}
              setChoice={setChoice}
              openGuide={openGuide}
              {...nav}
            />
          )}
          {current === 3 && <StepBlock device={device} plan={jb?.plan} fill={fill} setFill={setFill} skipFill={skipFill} setSkipFill={setSkipFill} openGuide={openGuide} {...nav} />}
          {current === 4 && jb && <StepInstall device={device} jb={jb} openGuide={openGuide} {...nav} />}
          {current === 5 && jb && <StepKindle jb={jb} skipFill={skipFill} openGuide={openGuide} {...nav} />}
          {current === 6 && <StepAfter device={device} openGuide={openGuide} openCheck={openCheck} back={nav.back} />}
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
    </div>
  );
}
