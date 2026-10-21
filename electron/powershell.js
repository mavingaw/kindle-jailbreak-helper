const { execFile } = require('node:child_process');

// Run a PowerShell script passed as -EncodedCommand so no quoting can break it.
function runPowerShell(script, { timeout = 60000 } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        resolve(stdout.trim());
      }
    );
  });
}

async function runPowerShellJson(script, opts) {
  const out = await runPowerShell(`$ProgressPreference='SilentlyContinue'\n${script}`, opts);
  if (!out) return null;
  return JSON.parse(out);
}

// Single-quoted PowerShell literal.
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

module.exports = { runPowerShell, runPowerShellJson, psq };
