// @ts-check
/**
 * Pure helpers for Docker auto-discovery (no DOM, no globals): merging
 * discovered services into the user's own, container state and health as text
 * and tone, handling of a poll response, and turning a suggestion into a
 * service draft.
 */

import { safeUrl } from './url.js';

/** @typedef {import('../types.js').Service} Service */
/** @typedef {import('../types.js').DiscoveredService} DiscoveredService */
/** @typedef {import('../types.js').DockerContainer} DockerContainer */

export const DOCKER_ID_PREFIX = 'docker:';

/** Where the deployment guide explains how to turn the feature on. */
export const DEPLOYMENT_GUIDE_URL = 'https://github.com/eco-null/server-hub/blob/main/docs/DEPLOYMENT.md#docker-discovery';

/**
 * True for a service that came from Docker (read-only, never editable).
 * @param {{ id?: unknown }} s
 */
export function isDiscovered(s) {
  return typeof s.id === 'string' && s.id.startsWith(DOCKER_ID_PREFIX);
}

/**
 * Key that makes two addresses count as the same service. Mirrors the
 * server's `normalize_url` (docs/API.md, "Docker discovery"): scheme and host
 * lower-cased, the port dropped when it is the scheme's default, the path as
 * written minus ALL trailing slashes, a non-empty query kept, user info and
 * fragment ignored. The scheme stays part of the key (http and https are
 * different endpoints). Input that cannot be parsed compares as the trimmed,
 * lower-cased string. Returns null for non-strings and empty input.
 * @param {unknown} url
 * @returns {string | null}
 */
export function urlKey(url) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/**
 * Own services plus discovered ones. A discovered service whose address equals
 * one of the user's own services is left out: the user's own card wins, since
 * it carries their name, icon and category. Discovered services among
 * themselves are never merged (each container stays visible).
 * @template {{ url: string }} O
 * @param {O[]} own
 * @param {Array<DiscoveredService>} discovered
 * @returns {Array<O | DiscoveredService>}
 */
export function mergeServices(own, discovered) {
  if (!discovered.length) return own;
  const taken = new Set();
  for (const s of own) {
    const k = urlKey(s.url);
    if (k) taken.add(k);
  }
  const extra = discovered.filter((d) => {
    const k = urlKey(d.url);
    return !(k && taken.has(k));
  });
  return [...own, ...extra];
}

const STATE_LABEL = Object.freeze({
  running: 'Running',
  exited: 'Exited',
  paused: 'Paused',
  restarting: 'Restarting',
  created: 'Created',
  dead: 'Dead',
  removing: 'Removing',
});

/** @param {string} state */
export function stateLabel(state) {
  if (Object.hasOwn(STATE_LABEL, state)) return STATE_LABEL[/** @type {keyof typeof STATE_LABEL} */ (state)];
  return state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Unknown';
}

/** @param {string | null | undefined} health */
export function healthLabel(health) {
  if (health === 'healthy') return 'Healthy';
  if (health === 'unhealthy') return 'Unhealthy';
  if (health === 'starting') return 'Starting';
  return 'No health check';
}

/** @typedef {{ label: string, tone: 'bad' | 'warn' | 'neutral' }} Badge */

/**
 * What a card says about its container, or null when all is well (running and
 * not unhealthy or starting). Tone is for styling; the label always carries
 * the meaning, so colour is never the only signal.
 * @param {Pick<DockerContainer, 'state' | 'health'>} c
 * @returns {Badge | null}
 */
export function containerBadge(c) {
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return { label: 'Unhealthy', tone: 'bad' };
    if (c.health === 'starting') return { label: 'Starting', tone: 'warn' };
    return null;
  }
  const label = stateLabel(c.state);
  if (c.state === 'exited' || c.state === 'dead' || c.state === 'paused') return { label, tone: 'bad' };
  if (c.state === 'restarting' || c.state === 'created' || c.state === 'removing') return { label, tone: 'warn' };
  return { label, tone: 'neutral' };
}

/**
 * Tooltip text: the container name, image and Docker's own status text.
 * @param {DiscoveredService} s
 * @param {{ stale?: boolean }} [opts]
 */
export function containerTitle(s, opts = {}) {
  const c = s.container;
  return [
    s.name,
    `Container: ${c.name}`,
    `Image: ${c.image}`,
    `Status: ${c.status || stateLabel(c.state)}`,
    opts.stale ? 'Docker is unavailable, so this is the last known state.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @typedef {{ enabled: boolean, available: boolean, error: string | null, services: DiscoveredService[], stale: boolean, updatedAt: string | null }} DockerView
 * `stale`: the cards are not current. Either the server says so (it serves its last good list while Docker
 * fails; `available` stays true) or Docker is unavailable and the cards are the last ones this page saw.
 */

/** @returns {DockerView} */
export function emptyDockerView() {
  return { enabled: false, available: true, error: null, services: [], stale: false, updatedAt: null };
}

/**
 * @param {unknown} v
 * @returns {v is DiscoveredService}
 */
function isDiscoveredShape(v) {
  if (!v || typeof v !== 'object') return false;
  const o = /** @type {Record<string, any>} */ (v);
  return typeof o.id === 'string' && o.id.startsWith(DOCKER_ID_PREFIX) && typeof o.name === 'string' && typeof o.url === 'string' && !!o.container && typeof o.container === 'object' && typeof o.container.state === 'string';
}

/**
 * Next dashboard view after a `GET /api/docker` poll. Returns `prev` itself
 * when nothing changed, so an identical poll does not repaint the grid.
 *  - `enabled: false`: nothing to show, no notice.
 *  - `available: false`: keeps the last known services (marked stale) and
 *    carries the server's error text for admins.
 *  - otherwise: the fresh list.
 *  - no usable response (request failed): unchanged.
 * @param {DockerView} prev
 * @param {unknown} res parsed response, or anything unusable
 * @returns {DockerView}
 */
export function nextDockerView(prev, res) {
  /** @type {DockerView} */
  let next;
  const r = res && typeof res === 'object' ? /** @type {Record<string, any>} */ (res) : null;
  // Not a usable response (the request failed, or the body is not an object): keep what is shown.
  if (!r) return prev;
  if (r.enabled === false) {
    next = emptyDockerView();
  } else if (r.available === false) {
    // Nothing usable on the server: keep what this page saw last, marked stale.
    next = { enabled: true, available: false, error: typeof r.error === 'string' && r.error ? r.error : null, services: prev.services, stale: prev.services.length > 0, updatedAt: prev.updatedAt };
  } else {
    const services = Array.isArray(r.services) ? r.services.filter(isDiscoveredShape) : [];
    // The server's own stale flag (it serves its last good list while Docker fails); a missing field means fresh.
    const stale = r.stale === true;
    const updatedAt = typeof r.updated_at === 'string' ? r.updated_at : null;
    // Admins get the error as the first listing-wide warning ("<error>; showing the container list from N s ago").
    const note = stale && Array.isArray(r.warnings) ? r.warnings.find((w) => w && w.container === '*' && typeof w.reason === 'string') : null;
    const error = note ? note.reason.replace(/;\s*showing the container list from .*$/i, '').trim() || null : null;
    next = { enabled: true, available: true, error, services, stale, updatedAt };
  }
  return sameView(prev, next) ? prev : next;
}

/** @param {DockerView} a @param {DockerView} b */
function sameView(a, b) {
  // `updatedAt` moves on every server refresh; it only matters (and is only compared) while the cards are stale.
  return a.enabled === b.enabled && a.available === b.available && a.error === b.error && a.stale === b.stale && (!a.stale || a.updatedAt === b.updatedAt) && (a.services === b.services || JSON.stringify(a.services) === JSON.stringify(b.services));
}

/**
 * "12 s ago", "3 min ago"; null when the time is unknown.
 * @param {string | null | undefined} iso
 * @param {number} [now]
 */
export function agoText(iso, now = Date.now()) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/**
 * One line for the admin notice, or null when there is nothing to say.
 * @param {DockerView} v
 * @param {number} [now]
 */
export function unavailableNotice(v, now = Date.now()) {
  if (!v.enabled) return null;
  const why = v.error ? ` ${v.error.replace(/[.\s]+$/, '')}.` : '';
  if (v.available) {
    if (!v.stale) return null;
    const ago = agoText(v.updatedAt, now);
    return `Docker discovery is not responding.${why} Showing the container list${ago ? ' from ' + ago : ' it last received'}.`;
  }
  return v.stale ? `Docker discovery is unavailable.${why} Showing the last known containers.` : `Docker discovery is unavailable.${why}`;
}

/**
 * How many discovered services the dashboard hides because their address
 * equals one of the user's own services.
 * @param {Array<{ url: string }>} own
 * @param {DiscoveredService[]} discovered
 */
export function hiddenDuplicates(own, discovered) {
  return discovered.length - (mergeServices(own, discovered).length - own.length);
}

/** @param {{ private: number, public: number, protocol: string }} p */
export function formatPort(p) {
  return `${p.public} → ${p.private}/${p.protocol}`;
}

/**
 * The values the add-service dialog starts with for a suggestion. An empty
 * `url` means the server could not build one (no public host configured).
 * @param {import('../types.js').DockerSuggestion} s
 * @returns {{ name: string, url: string, description: string, icon: string, category: string | null, check: boolean, needsUrl: boolean }}
 */
export function suggestionToDraft(s) {
  const url = s.suggested.url && safeUrl(s.suggested.url) ? s.suggested.url : '';
  return {
    name: s.suggested.name || s.container.name,
    url,
    description: '',
    icon: s.suggested.icon,
    category: s.suggested.category || null,
    check: true,
    needsUrl: !url,
  };
}
