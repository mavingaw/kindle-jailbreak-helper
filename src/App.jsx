import { useCallback, useEffect, useRef, useState } from 'react';
import { Helper } from './Helper.jsx';
import { GuideView } from './GuideView.jsx';
import { Health } from './Health.jsx';
import { Customize } from './Customize.jsx';
import { formatBytes } from './format.js';

const SITE = 'https://kindlemodding.org';

function DeviceChip({ device, busy, onRefresh }) {
  let text = 'No Kindle connected';
  let tone = 'muted';
  if (device?.connected) {
    const name = device.modelInfo?.name || device.usbName || 'Kindle';
    const mode = { 'mass-storage': `USB drive ${device.root || ''}`, mtp: 'MTP', 'usb-only': 'waiting for its storage…' }[device.mode] || '';
    text = `${name} · ${mode}${device.free != null ? ` · ${formatBytes(device.free)} free` : ''}`;
    tone = device.mode === 'usb-only' ? 'warn' : 'ok';
  }
  return (
    <div className={`chip ${tone}`}>
      <span className="dot" />
      <span>{text}</span>
      <button className="link" onClick={onRefresh} disabled={busy}>
        {busy ? 'Scanning…' : 'Refresh'}
      </button>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('helper');
  const [guideUrl, setGuideUrl] = useState(`${SITE}/jailbreaking/`);
  const [device, setDevice] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [dataInfo, setDataInfo] = useState(null);
  const scanRef = useRef(false);

  const detect = useCallback(async () => {
    if (scanRef.current) return;
    scanRef.current = true;
    setScanning(true);
    try {
      setDevice(await window.api.detect());
    } catch (e) {
      setLogs((l) => [...l, { time: Date.now(), msg: `Detection failed: ${e.message}` }]);
    } finally {
      scanRef.current = false;
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    window.api.loadData().then(setDataInfo).catch(() => {});
    detect();
    const offLog = window.api.onLog((entry) => setLogs((l) => [...l.slice(-300), entry]));
    const timer = setInterval(detect, 5000);
    return () => {
      offLog();
      clearInterval(timer);
    };
  }, [detect]);

  const openGuide = useCallback((url) => {
    setGuideUrl(url.startsWith('http') ? url : `${SITE}${url.startsWith('/') ? '' : '/'}${url}`);
    setTab('guide');
  }, []);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <strong>Kindle Jailbreak Helper</strong>
          <span className="sub">unofficial companion to kindlemodding.org</span>
        </div>
        <nav className="tabs">
          <button className={tab === 'helper' ? 'active' : ''} onClick={() => setTab('helper')}>
            Helper
          </button>
          <button className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>
            Check my Kindle
          </button>
          <button className={tab === 'custom' ? 'active' : ''} onClick={() => setTab('custom')}>
            Customize
          </button>
          <button className={tab === 'guide' ? 'active' : ''} onClick={() => setTab('guide')}>
            Guide
          </button>
        </nav>
        <DeviceChip device={device} busy={scanning} onRefresh={detect} />
      </header>
      <main>
        <section className={tab === 'helper' ? 'pane' : 'pane hidden'}>
          <Helper
            device={device}
            refresh={detect}
            openGuide={openGuide}
            openCheck={() => setTab('check')}
            logs={logs}
            dataInfo={dataInfo}
          />
        </section>
        <section className={tab === 'check' ? 'pane' : 'pane hidden'}>
          <Health active={tab === 'check'} logs={logs} liveDevice={device} />
        </section>
        <section className={tab === 'custom' ? 'pane' : 'pane hidden'}>
          <Customize active={tab === 'custom'} logs={logs} liveDevice={device} />
        </section>
        <section className={tab === 'guide' ? 'pane' : 'pane hidden'}>
          <GuideView url={guideUrl} />
        </section>
      </main>
    </div>
  );
}
