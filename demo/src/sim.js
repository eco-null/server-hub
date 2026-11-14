// @ts-check
/**
 * Deterministic simulation of the things the real server measures: service
 * status checks, Beszel system metrics and host stats. Values depend only on
 * an id and the clock, so they drift smoothly between polls and two tabs
 * agree with each other.
 */

/** FNV-1a, 32 bit. @param {string} s */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pseudo-random in [-1, 1] for (seed, integer bucket). @param {string} seed @param {number} n */
function rnd(seed, n) {
  return (hash(seed + ':' + n) / 0xffffffff) * 2 - 1;
}

/**
 * Smooth noise in [-1, 1]: interpolates between random values every `period` ms.
 * @param {string} seed
 * @param {number} nowMs
 * @param {number} [period]
 */
export function drift(seed, nowMs, period = 20000) {
  const x = nowMs / period;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return rnd(seed, i) * (1 - s) + rnd(seed, i + 1) * s;
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** @param {number} v */
const round1 = (v) => Math.round(v * 10) / 10;

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * One status entry as GET /api/status reports it.
 * @param {{ id: string, url: string }} service
 * @param {'up' | 'down' | 'unknown'} health
 * @param {number} nowMs
 */
export function serviceStatus(service, health, nowMs) {
  // Checks are cached for a few seconds on the real server; mimic that granularity.
  const checkedAt = Math.floor(nowMs / 5000) * 5000;
  if (health === 'unknown') return { state: 'unknown', http_status: null, latency_ms: null, checked_at: null };
  if (health === 'down') return { state: 'down', http_status: null, latency_ms: null, checked_at: iso(checkedAt) };
  const h = hash(service.url);
  const base = 6 + (h % 90);
  const latency = Math.max(2, Math.round(base * (1 + 0.35 * drift(service.id, nowMs, 15000))));
  const http = h % 9 === 0 ? 401 : h % 7 === 0 ? 302 : 200;
  return { state: 'up', http_status: http, latency_ms: latency, checked_at: iso(checkedAt) };
}

/**
 * @typedef {{ name: string, host: string, cpu: number, memory: number, disk: number, uptimeDays: number }} SystemBase
 */

/**
 * A Beszel `System` with metrics drifting around the base values.
 * @param {string} hubId
 * @param {SystemBase} s
 * @param {number} nowMs
 */
export function systemNow(hubId, s, nowMs) {
  const seed = hubId + '/' + s.name;
  const cpu = clamp(s.cpu + Math.max(6, s.cpu * 0.5) * drift(seed + ':cpu', nowMs, 12000), 0.5, 99);
  const memory = clamp(s.memory + 3 * drift(seed + ':mem', nowMs, 45000), 1, 98);
  const disk = clamp(s.disk + 0.4 * drift(seed + ':disk', nowMs, 120000), 1, 99);
  const dayStart = Math.floor(nowMs / 86400000) * 86400000;
  return {
    name: s.name,
    status: 'up',
    host: s.host,
    cpu: round1(cpu),
    memory: round1(memory),
    disk: round1(disk),
    uptime_seconds: s.uptimeDays * 86400 + Math.floor((nowMs - dayStart) / 1000),
  };
}

/**
 * Systems for a hub the visitor added themselves: one or two plausible
 * machines named after the hub's host.
 * @param {string} url
 * @returns {SystemBase[]}
 */
export function systemsForNewHub(url) {
  let host = 'beszel';
  try {
    host = new URL(url).hostname || host;
  } catch {
    /* validated before; keep the fallback */
  }
  const label = host.split('.')[0] || 'server';
  const h = hash(url);
  const list = [{ name: label, host, cpu: 8 + (h % 30), memory: 30 + (h % 45), disk: 20 + ((h >>> 8) % 60), uptimeDays: 1 + (h % 60) }];
  if (h % 2 === 0) list.push({ name: label + '-backup', host: 'backup.' + host, cpu: 3 + (h % 10), memory: 20 + ((h >>> 4) % 30), disk: 40 + ((h >>> 12) % 50), uptimeDays: 5 + ((h >>> 3) % 90) });
  return list;
}

/** GET /api/stats for the demo "server". @param {number} nowMs */
export function hostStats(nowMs) {
  return {
    hostname: 'serverhub',
    cpu: round1(clamp(11 + 6 * drift('host:cpu', nowMs, 10000), 1, 99)),
    memory: round1(clamp(46 + 2 * drift('host:mem', nowMs, 60000), 1, 99)),
    disk: round1(clamp(37 + 0.2 * drift('host:disk', nowMs, 300000), 1, 99)),
  };
}
