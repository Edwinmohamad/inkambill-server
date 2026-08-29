// v1.21.0 — new: "Local Billing Server Resource Monitor" widget (Dashboard Section 1, item 5).
// Lightweight, dependency-free server telemetry using only Node's built-in `os` and `fs` modules — no new
// npm package required. CPU% is an approximation (1-minute load average relative to core count, the same
// technique `uptime`/`top`-style tools use on Linux; on platforms without a real load average — e.g.
// Windows — os.loadavg() returns zeros, so cpuPercent gracefully reports 0 instead of crashing). Disk usage
// is read via fs.statfsSync on the project's own working directory (the partition the app/database backups
// actually live on in a typical single-VPS deployment), wrapped in try/catch since statfsSync can be
// unavailable/restricted in some sandboxed or containerized environments.
const fs = require('fs');
const os = require('os');

function bytesToGb(bytes) {
  return Math.round((bytes / (1024 ** 3)) * 10) / 10;
}

function getServerResourceSnapshot() {
  const snapshot = {
    cpuPercent: 0,
    cpuCores: os.cpus()?.length || 1,
    loadavg1: 0,
    ramPercent: 0,
    ramUsedGb: 0,
    ramTotalGb: 0,
    diskPercent: null,
    diskUsedGb: null,
    diskTotalGb: null,
    diskAvailable: false,
  };
  try {
    const cores = os.cpus()?.length || 1;
    const load1 = os.loadavg()[0] || 0;
    snapshot.loadavg1 = Math.round(load1 * 100) / 100;
    snapshot.cpuCores = cores;
    snapshot.cpuPercent = Math.max(0, Math.min(100, Math.round((load1 / cores) * 100)));
  } catch (e) { /* leave defaults on unsupported platforms */ }
  try {
    const total = os.totalmem();
    const free = os.freemem();
    const used = Math.max(0, total - free);
    snapshot.ramTotalGb = bytesToGb(total);
    snapshot.ramUsedGb = bytesToGb(used);
    snapshot.ramPercent = total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
  } catch (e) { /* leave defaults */ }
  try {
    if (typeof fs.statfsSync === 'function') {
      const stat = fs.statfsSync(process.cwd());
      const totalBytes = stat.blocks * stat.bsize;
      const freeBytes = stat.bavail * stat.bsize;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      snapshot.diskTotalGb = bytesToGb(totalBytes);
      snapshot.diskUsedGb = bytesToGb(usedBytes);
      snapshot.diskPercent = totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 100))) : 0;
      snapshot.diskAvailable = true;
    }
  } catch (e) { /* statfsSync unsupported/restricted — widget shows "-" for disk instead of crashing */ }
  return snapshot;
}

module.exports = { getServerResourceSnapshot };
