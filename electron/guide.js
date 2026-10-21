const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, net, session } = require('electron');

const PARTITION = 'persist:guide';
const HOST = 'kindlemodding.org';
const ORIGIN = `https://${HOST}`;
// Sections saved by "Save guide for offline".
const CRAWL_PREFIXES = ['/jailbreaking/', '/firmware-and-flashing/', '/jailbreak-wizard.html', '/assets/', '/jailbreaks.json', '/models.json'];

const cacheDir = () => path.join(app.getPath('userData'), 'guide-cache');

function keyFor(url) {
  const u = new URL(url);
  u.hash = '';
  let p = u.pathname;
  if (p.endsWith('/')) p += 'index.html';
  return crypto.createHash('sha1').update(u.origin + p + u.search).digest('hex');
}

async function writeCache(url, res) {
  const body = Buffer.from(await res.arrayBuffer());
  const key = keyFor(url);
  await fsp.mkdir(cacheDir(), { recursive: true });
  await fsp.writeFile(path.join(cacheDir(), key), body);
  await fsp.writeFile(
    path.join(cacheDir(), key + '.json'),
    JSON.stringify({ url, status: res.status, type: res.headers.get('content-type'), saved: Date.now() })
  );
  return body;
}

async function readCache(url) {
  const key = keyFor(url);
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(cacheDir(), key + '.json'), 'utf8'));
    const body = await fsp.readFile(path.join(cacheDir(), key));
    return new Response(body, { status: 200, headers: { 'content-type': meta.type || 'application/octet-stream', 'x-offline-cache': '1' } });
  } catch {
    return null;
  }
}

// Network first; every successful kindlemodding.org GET is also saved, so pages
// you have opened keep working with no internet.
async function fetchAndCache(url) {
  const res = await net.fetch(url, { bypassCustomProtocolHandlers: true });
  if (!res.ok) return res;
  const body = await writeCache(url, res.clone());
  return new Response(body, { status: res.status, headers: res.headers });
}

function setupGuideSession() {
  const ses = session.fromPartition(PARTITION);
  ses.protocol.handle('https', async (req) => {
    const u = new URL(req.url);
    if (u.hostname !== HOST || req.method !== 'GET') {
      return net.fetch(req, { bypassCustomProtocolHandlers: true });
    }
    try {
      return await fetchAndCache(req.url);
    } catch {
      const cached = await readCache(req.url);
      if (cached) return cached;
      return new Response(
        `<html><body style="font-family:sans-serif;padding:2em"><h2>Offline</h2><p>This page has not been saved yet. Connect to the internet, or use "Save guide for offline" next time you are online.</p><p><code>${u.pathname}</code></p></body></html>`,
        { status: 503, headers: { 'content-type': 'text/html' } }
      );
    }
  });
  return ses;
}

// Breadth-first crawl of the guide sections, saving pages and their assets.
async function saveOffline(onProgress) {
  const queue = [`${ORIGIN}/jailbreaking/`, `${ORIGIN}/jailbreak-wizard.html`];
  const seen = new Set(queue);
  let saved = 0;
  let failed = 0;
  const MAX = 600;

  while (queue.length && seen.size <= MAX) {
    const url = queue.shift();
    onProgress?.({ saved, failed, queued: queue.length, url });
    try {
      const res = await net.fetch(url, { bypassCustomProtocolHandlers: true });
      if (!res.ok) {
        failed++;
        continue;
      }
      const type = res.headers.get('content-type') || '';
      const body = await writeCache(url, res);
      saved++;
      if (!/text\/(html|css)/.test(type)) continue;
      const text = body.toString('utf8');
      // The site's HTML is minified, so attribute values are often unquoted.
      const refs = [
        ...text.matchAll(/(?:href|src)\s*=\s*(?:"([^"#]*)|'([^'#]*)|([^\s>"'#]+))|url\(\s*["']?([^"')]+)/gi),
      ]
        .map((m) => m[1] || m[2] || m[3] || m[4])
        .filter(Boolean);
      for (const ref of refs) {
        let next;
        try {
          next = new URL(ref, url);
        } catch {
          continue;
        }
        if (next.hostname !== HOST) continue;
        next.hash = '';
        const isAsset = /\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|json)$/i.test(next.pathname);
        if (!isAsset && !CRAWL_PREFIXES.some((p) => next.pathname.startsWith(p))) continue;
        // Skip big binaries (jailbreak payloads); the helper downloads those itself.
        if (/\.(zip|gz|azw3|bin|so|sh)$/i.test(next.pathname)) continue;
        const s = next.toString();
        if (!seen.has(s)) {
          seen.add(s);
          queue.push(s);
        }
      }
    } catch {
      failed++;
    }
  }
  onProgress?.({ saved, failed, queued: 0, done: true });
  return { saved, failed };
}

async function cacheStats() {
  try {
    const files = (await fsp.readdir(cacheDir())).filter((f) => f.endsWith('.json'));
    return { pages: files.length };
  } catch {
    return { pages: 0 };
  }
}

async function clearCache() {
  await fsp.rm(cacheDir(), { recursive: true, force: true });
}

module.exports = { PARTITION, ORIGIN, HOST, setupGuideSession, saveOffline, cacheStats, clearCache };
