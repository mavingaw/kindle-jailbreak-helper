export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '…';
  if (sec < 60) return 'under a minute';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}
