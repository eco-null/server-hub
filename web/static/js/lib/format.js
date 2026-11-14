// @ts-check

/** @param {number} n */
export const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Compact uptime: "3d 4h", "5h 12m", "42s". Empty string when unknown.
 * @param {unknown} sec
 */
export function formatUptime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 1) return '';
  const s = Math.floor(sec);
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }
  return `${s}s`;
}

/**
 * @param {unknown} v
 * @returns {number | null} 0..100 or null when not a number
 */
export function clampPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

/**
 * Usage level: amber from 75 %, red from 90 %.
 * @param {number | null} pct
 * @returns {'ok' | 'warn' | 'crit'}
 */
export function loadLevel(pct) {
  if (pct == null) return 'ok';
  return pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok';
}

/** @param {number} hour 0..23 */
export function greetingFor(hour) {
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** @param {Date} d */
export function formatClock(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
