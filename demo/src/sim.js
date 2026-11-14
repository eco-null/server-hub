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
 * Docker's own wording for a duration ("5 minutes", "About an hour", "3 days").
 * @param {number} seconds
 */
export function humanDuration(seconds) {
  const s = Math.floor(seconds);
  if (s < 1) return 'Less than a second';
  if (s === 1) return '1 second';
  if (s < 60) return `${s} seconds`;
  const minutes = Math.floor(s / 60);
  if (minutes === 1) return 'About a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(s / 3600);
  if (hours === 1) return 'About an hour';
  if (hours < 48) return `${hours} hours`;
  if (hours < 24 * 7 * 2) return `${Math.floor(hours / 24)} days`;
  if (hours < 24 * 30 * 2) return `${Math.floor(hours / 24 / 7)} weeks`;
  if (hours < 24 * 365 * 2) return `${Math.floor(hours / 24 / 30)} months`;
  return `${Math.floor(hours / 24 / 365)} years`;
}

/** A 64-digit hex container id derived from the name. @param {string} name */
function containerId(name) {
  let out = '';
  for (let i = 0; i < 8; i++) out += hash(`${name}:${i}`).toString(16).padStart(8, '0');
  return out;
}

/**
 * What the Docker Engine API (`GET /containers/json?all=true`) would answer
 * `nowMs` after the simulated host started (`t0`). Uptimes grow with the
 * clock, and a container whose health check is still "starting" turns healthy
 * once it has been up long enough.
 * @param {Array<import('./seed.js').DockerFixture>} fixtures
 * @param {number} t0 ms since epoch
 * @param {number} nowMs
 * @returns {Array<Record<string, any>>}
 */
export function dockerContainers(fixtures, t0, nowMs) {
  const elapsed = Math.max(0, Math.floor((nowMs - t0) / 1000));
  return fixtures.map((f) => {
    const running = f.state === 'running';
    const t = (running ? f.upS || 0 : f.agoS || 0) + elapsed;
    /** @type {string | null} */
    let health = running ? f.health || null : null;
    if (running && f.healthyAfterS !== undefined && t >= f.healthyAfterS) health = 'healthy';
    const status = running
      ? `Up ${humanDuration(t)}` + (health ? ` (${health === 'starting' ? 'health: starting' : health})` : '')
      : `Exited (${f.exitCode ?? 0}) ${humanDuration(t)} ago`;
    const ports = [];
    for (const [priv, pub, type = 'tcp', ip] of running ? f.ports || [] : []) {
      for (const addr of ip ? [ip] : ['0.0.0.0', '::']) ports.push({ IP: addr, PrivatePort: priv, PublicPort: pub, Type: type });
    }
    return {
      Id: ((f.idPrefix || '') + containerId(f.name)).slice(0, 64),
      Names: [`/${f.name}`],
      Image: f.image,
      State: f.state,
      Status: status,
      Labels: f.labels || {},
      Ports: ports,
      ...(health ? { Health: { Status: health, FailingStreak: health === 'unhealthy' ? 3 : 0 } } : {}),
    };
  });
}

/**
 * What a status check of a discovered service would find: only a running
 * container that is not unhealthy or still starting answers.
 * @param {{ state: string, health: string | null }} container
 * @returns {'up' | 'down'}
 */
export function dockerServiceHealth(container) {
  return container.state === 'running' && (container.health === null || container.health === 'healthy') ? 'up' : 'down';
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
