import { useEffect, useRef, useState } from 'react';

const HOME = 'https://kindlemodding.org/jailbreaking/';

export function GuideView({ url }) {
  const view = useRef(null);
  // src is only the first page; later pages go through loadURL so React
  // re-renders do not reload the webview.
  const [initialUrl] = useState(url);
  const [current, setCurrent] = useState(url);
  const [offline, setOffline] = useState(null);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    const wv = view.current;
    if (!wv) return;
    const onNav = (e) => setCurrent(e.url);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    return () => {
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNav);
    };
  }, []);

  // Navigate when the helper asks for a specific page.
  useEffect(() => {
    const wv = view.current;
    if (wv && wv.getURL && url) {
      try {
        if (wv.getURL() !== url) wv.loadURL(url);
      } catch {
        /* webview not ready yet; src handles the first load */
      }
    }
  }, [url]);

  useEffect(() => {
    window.api.guideStats().then(setStats).catch(() => {});
    return window.api.onProgress((p) => {
      if (p.task !== 'offline') return;
      setOffline(p);
      if (p.done) window.api.guideStats().then(setStats);
    });
  }, []);

  const saving = offline && !offline.done;
  const call = (fn) => () => {
    try {
      fn(view.current);
    } catch {}
  };

  return (
    <div className="guide">
      <div className="toolbar">
        <button onClick={call((w) => w.goBack())} title="Back">←</button>
        <button onClick={call((w) => w.goForward())} title="Forward">→</button>
        <button onClick={call((w) => w.reload())} title="Reload">⟳</button>
        <button onClick={call((w) => w.loadURL(HOME))}>Guide home</button>
        <button onClick={call((w) => w.loadURL('https://kindlemodding.org/jailbreak-wizard.html'))}>Site wizard</button>
        <span className="url" title={current}>{current}</span>
        <span className="muted small">{stats ? `${stats.pages} saved` : ''}</span>
        <button disabled={saving} onClick={() => window.api.saveOffline().catch(() => {})}>
          {saving ? `Saving… ${offline.saved}` : 'Save guide for offline'}
        </button>
        <button className="link" onClick={() => window.api.openExternal(current)}>
          Open in browser
        </button>
      </div>
      {offline?.done && (
        <div className="notice small">
          Saved {offline.saved} pages and files{offline.failed ? ` (${offline.failed} failed)` : ''}. Pages you have opened also stay
          available offline.
        </div>
      )}
      <webview ref={view} src={initialUrl} partition="persist:guide" className="webview" />
    </div>
  );
}
