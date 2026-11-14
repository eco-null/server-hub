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
export const DEPLOYMENT_GUIDE_URL = 'https://github.com/eco-null/server-hub/blob/main/docs/DEPLOYMENT.md';

/**
 * True for a service that came from Docker (read-only, never editable).
 * @param {{ id?: unknown }} s
 */
export function isDiscovered(s) {
  return typeof s.id === 'string' && s.id.startsWith(DOCKER_ID_PREFIX);
}

/**
 * Key that makes two addresses count as the same service: lower-cased host,
 * default port dropped, no trailing slash, no fragment. The scheme stays part
 * of the key (http and https on one host are different endpoints). Returns
 * null for anything that is not a valid http(s) URL; those never match.
 * @param {unknown} url
 * @returns {string | null}
 */
export function urlKey(url) {
  const href = safeUrl(url);
  if (!href) return null;
  const u = new URL(href);
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
 * @typedef {{ enabled: boolean, available: boolean, error: string | null, services: DiscoveredService[], stale: boolean }} DockerView
 */

/** @returns {DockerView} */
export function emptyDockerView() {
  return { enabled: false, available: true, error: null, services: [], stale: false };
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
    next = { enabled: false, available: true, error: null, services: [], stale: false };
  } else if (r.available === false) {
    next = { enabled: true, available: false, error: typeof r.error === 'string' && r.error ? r.error : null, services: prev.services, stale: prev.services.length > 0 };
  } else {
    const services = Array.isArray(r.services) ? r.services.filter(isDiscoveredShape) : [];
    next = { enabled: true, available: true, error: null, services, stale: false };
  }
  return sameView(prev, next) ? prev : next;
}

/** @param {DockerView} a @param {DockerView} b */
function sameView(a, b) {
  return a.enabled === b.enabled && a.available === b.available && a.error === b.error && a.stale === b.stale && (a.services === b.services || JSON.stringify(a.services) === JSON.stringify(b.services));
}

/**
 * One line for the admin notice, or null when there is nothing to say.
 * @param {DockerView} v
 */
export function unavailableNotice(v) {
  if (!v.enabled || v.available) return null;
  const why = v.error ? ` ${v.error.replace(/[.\s]+$/, '')}.` : '';
  return v.stale ? `Docker discovery is unavailable.${why} Showing the last known containers.` : `Docker discovery is unavailable.${why}`;
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
