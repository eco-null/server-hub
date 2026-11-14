// @ts-check
/**
 * A port of the Docker discovery logic in serverhub/integrations/docker.py:
 * turns a container list in the Docker Engine API's shape into service cards
 * (`discover`) and suggestions (`suggest`), with the same label rules,
 * fallbacks, limits, icon/category guesses and reason texts. The container
 * list itself comes from sim.js, so the demo runs the real parsing end to end.
 */

import * as S from './validate.js';

const MAX_LABEL_VALUE = 2048;
const MAX_CONTAINERS = 500;
const MAX_DISCOVERED_CHECKS = 100;
const MAX_URL = 2000;
const MAX_PORTS = 64;
const LABEL_PREFIX = 'serverhub.';
const STATES = new Set(['running', 'exited', 'paused', 'restarting', 'created', 'dead', 'removing']);
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const HEALTH_IN_STATUS = /\((healthy|unhealthy|health: starting)\)/;

/** Ports most likely to be a web UI, in order of preference. */
const WEB_PORTS = [80, 443, 8080, 3000, 8000, 8443, 5000, 8081, 8888, 9000, 8096, 8123, 9090, 3001, 8001, 8082, 5001, 7878, 8989, 9443, 2283, 5678, 8384];
const HTTPS_PORTS = new Set([443, 8443, 9443]);

/** (substring of the image or container name, icon, category). First match wins. @type {Array<[string, string, string | null]>} */
const HEURISTICS = [
  ['grafana', 'chart', 'Monitoring'], ['prometheus', 'pulse', 'Monitoring'], ['uptime-kuma', 'activity', 'Monitoring'],
  ['beszel', 'activity', 'Monitoring'], ['netdata', 'activity', 'Monitoring'],
  ['portainer', 'layers', 'Dev'], ['dozzle', 'terminal', 'Dev'], ['gitea', 'git', 'Dev'], ['forgejo', 'git', 'Dev'],
  ['gitlab', 'git', 'Dev'], ['code-server', 'code', 'Dev'], ['jenkins', 'cog', 'Dev'],
  ['postgres', 'database', 'Database'], ['mariadb', 'database', 'Database'], ['mysql', 'database', 'Database'],
  ['mongo', 'database', 'Database'], ['redis', 'database', 'Database'], ['adminer', 'database', 'Database'],
  ['vaultwarden', 'key', 'Security'], ['bitwarden', 'key', 'Security'], ['authelia', 'shield', 'Security'],
  ['authentik', 'shield', 'Security'], ['crowdsec', 'shield', 'Security'],
  ['pihole', 'shield', 'Network'], ['adguard', 'shield', 'Network'], ['wireguard', 'lock', 'Network'],
  ['wg-easy', 'lock', 'Network'], ['unifi', 'wifi', 'Network'],
  ['jellyfin', 'film', 'Media'], ['plex', 'film', 'Media'], ['emby', 'film', 'Media'], ['sonarr', 'film', 'Media'],
  ['radarr', 'film', 'Media'], ['navidrome', 'music', 'Media'], ['lidarr', 'music', 'Media'],
  ['audiobookshelf', 'headphones', 'Books'], ['calibre', 'book', 'Books'], ['kavita', 'book', 'Books'],
  ['immich', 'image', 'Media'], ['photoprism', 'camera', 'Media'], ['qbittorrent', 'download', 'Media'],
  ['transmission', 'download', 'Media'], ['sabnzbd', 'download', 'Media'],
  ['nextcloud', 'cloud', 'Files'], ['seafile', 'cloud', 'Files'], ['syncthing', 'refresh', 'Files'],
  ['filebrowser', 'folder', 'Files'],
  ['paperless', 'file', 'Productivity'], ['bookstack', 'book', 'Productivity'], ['wiki', 'book', 'Productivity'],
  ['vikunja', 'calendar', 'Productivity'],
  ['homeassistant', 'home', 'Home'], ['home-assistant', 'home', 'Home'], ['node-red', 'zap', 'Home'],
  ['mosquitto', 'broadcast', 'Home'],
  ['ollama', 'sparkles', 'AI'], ['open-webui', 'sparkles', 'AI'], ['searxng', 'globe', 'Search'],
  ['matrix', 'message', 'Communication'], ['synapse', 'message', 'Communication'], ['mailu', 'mail', 'Communication'],
  ['firefly', 'wallet', 'Finance'], ['actual', 'wallet', 'Finance'], ['n8n', 'zap', 'Productivity'],
  ['nginx', 'globe', null], ['httpd', 'globe', null], ['caddy', 'globe', null],
];

/** @type {Map<string, string>} */
const CATEGORY_BY_LOWER = new Map([...S.KNOWN_CATEGORIES].map((c) => [c.toLowerCase(), c]));

const NON_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]$/u;

/**
 * A printable, single-line, length-capped copy of an untrusted value.
 * @param {unknown} v
 * @param {number} limit
 */
export function cleanText(v, limit) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const c of Array.from(v).slice(0, limit * 2)) {
    if (NON_PRINTABLE.test(c)) {
      if ('\t\n\r'.includes(c)) out += ' ';
      continue;
    }
    out += c;
  }
  return Array.from(out.trim()).slice(0, limit).join('');
}

/** @param {any} c @returns {string | null} */
export function containerName(c) {
  const names = c.Names;
  if (!Array.isArray(names)) return null;
  for (const n of names.slice(0, 16)) {
    if (typeof n === 'string' && n.split('/').length === 2 && n.startsWith('/') && CONTAINER_NAME.test(n.slice(1))) return n.slice(1);
  }
  return null;
}

/** `my_app-1` -> `My App`; `server-hub` -> `Server Hub`. @param {string} name */
export function prettify(name) {
  const base = name.replace(/[-_]\d+$/, '') || name;
  const words = base.split(/[-_.\s]+/).filter(Boolean);
  const pretty = words.map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join(' ');
  return (pretty || name).slice(0, 200);
}

/** @param {...string} hints @returns {[string, string | null]} */
export function guessIconCategory(...hints) {
  const hay = hints.filter(Boolean).map((h) => h.toLowerCase()).join(' ');
  for (const [needle, icon, category] of HEURISTICS) if (hay.includes(needle)) return [icon, category];
  return ['box', null];
}

/** @param {any} c */
const image = (c) => cleanText(c.Image, 300);

/** `ghcr.io/org/app:1.2@sha256:..` -> `app`. @param {string} img */
function imageBase(img) {
  const ref = img.split('@', 1)[0];
  const last = ref.slice(ref.lastIndexOf('/') + 1);
  return last.split(':', 1)[0];
}

/** @param {any} c @returns {Record<string, any>} */
const labelsOf = (c) => (c.Labels && typeof c.Labels === 'object' && !Array.isArray(c.Labels) ? c.Labels : {});

/** @param {any} c @returns {string | null} */
const stateOf = (c) => (typeof c.State === 'string' && STATES.has(c.State) ? c.State : null);

/** @param {any} c @returns {'healthy' | 'unhealthy' | 'starting' | null} */
function healthOf(c) {
  const h = c.Health;
  if (h && typeof h === 'object' && typeof h.Status === 'string') return ['healthy', 'unhealthy', 'starting'].includes(h.Status) ? h.Status : null;
  if (typeof c.Status === 'string') {
    const m = HEALTH_IN_STATUS.exec(c.Status.slice(0, 300));
    if (m) return m[1] === 'health: starting' ? 'starting' : /** @type {'healthy' | 'unhealthy'} */ (m[1]);
  }
  return null;
}

/** @param {string} raw @returns {boolean | null} */
function flag(raw) {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return null;
}

/** @param {string} ip */
function isLoopback(ip) {
  if (/^127\.\d+\.\d+\.\d+$/.test(ip)) return true;
  return ip === '::1' || /^(0*:)+0*1$/.test(ip);
}

/** Published ports, de-duplicated (IPv4 + IPv6 bindings), loopback-only ones dropped. @param {any} c */
export function publishedPorts(c) {
  if (!Array.isArray(c.Ports)) return [];
  const seen = new Set();
  /** @type {Array<{ private: number, public: number, protocol: string }>} */
  const out = [];
  for (const p of c.Ports.slice(0, MAX_PORTS)) {
    if (!p || typeof p !== 'object') continue;
    const { PrivatePort: priv, PublicPort: pub, Type: proto } = p;
    if (!Number.isInteger(priv) || !Number.isInteger(pub)) continue;
    if (!(priv > 0 && priv < 65536 && pub > 0 && pub < 65536) || (proto !== 'tcp' && proto !== 'udp')) continue;
    if (typeof p.IP === 'string' && p.IP && isLoopback(p.IP)) continue;
    const key = `${priv}/${pub}/${proto}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ private: priv, public: pub, protocol: proto });
    }
  }
  out.sort((a, b) => (a.protocol < b.protocol ? -1 : a.protocol > b.protocol ? 1 : a.private - b.private || a.public - b.public));
  return out;
}

/** The published TCP port most likely to be a web UI. @param {Array<{ private: number, public: number, protocol: string }>} ports */
export function webPort(ports) {
  const tcp = ports.filter((p) => p.protocol === 'tcp');
  if (!tcp.length) return null;
  /** @param {number} port */
  const rank = (port) => {
    const i = WEB_PORTS.indexOf(port);
    return i < 0 ? WEB_PORTS.length : i;
  };
  return tcp.reduce((best, p) => {
    const a = [rank(p.private), p.private, p.public];
    const b = [rank(best.private), best.private, best.public];
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? p : best;
    return best;
  });
}

/** @param {string | null | undefined} publicHost @param {{ private: number, public: number } | null} port */
export function suggestedUrl(publicHost, port) {
  if (!publicHost || !port) return null;
  const https = HTTPS_PORTS.has(port.private) || HTTPS_PORTS.has(port.public);
  const scheme = https ? 'https' : 'http';
  const suffix = port.public === (https ? 443 : 80) ? '' : `:${port.public}`;
  const host = publicHost.includes(':') && !publicHost.startsWith('[') ? `[${publicHost}]` : publicHost;
  return `${scheme}://${host}${suffix}`;
}

/**
 * Comparison key for "is this URL already one of my services?" (the rule in
 * docs/API.md, "Docker discovery"): scheme and host lowercased, user info
 * dropped, the port dropped when it is the scheme's default (http 80, https
 * 443), the path as written minus ALL trailing slashes, a non-empty query
 * kept, the fragment dropped. Unparseable input: trimmed and lowercased.
 * @param {string} url
 */
export function normalizeUrl(url) {
  const raw = url.trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

// Skip reasons (admin diagnostics, documented in docs/API.md).
const SKIP_NO_NAME = 'container has no usable name';
const SKIP_UNKNOWN_STATE = 'unknown container state';
const SKIP_DUPLICATE = 'duplicate container name; only the first one is listed';
const SKIP_URL_MISSING = 'serverhub.url is missing';
const SKIP_URL_INVALID = 'serverhub.url is invalid';
const SKIP_URL_TOO_LONG = `serverhub.url is longer than ${MAX_URL} characters`;
const SKIP_URL_CREDENTIALS = 'serverhub.url must not contain credentials (user:password@)';
const SKIP_URL_NOT_HTTP = 'serverhub.url is not a valid http(s) URL';
const SKIP_LABELS_INVALID = 'serverhub labels could not be validated';

/**
 * @typedef {{ container: string, reason: string }} Note
 * @typedef {{ services: any[], skipped: Note[], warnings: Note[] }} Discovery
 */

/**
 * @param {Record<string, any>} labels
 * @param {string} key
 * @returns {[string | null, boolean]} (value, present); over-long or non-string values are present but invalid
 */
function label(labels, key) {
  if (!(LABEL_PREFIX + key in labels)) return [null, false];
  const v = labels[LABEL_PREFIX + key];
  if (typeof v !== 'string' || v.length > MAX_LABEL_VALUE) return [null, true];
  return [v, true];
}

/** @param {any} c @param {string} name @param {Record<string, any>} labels @param {Discovery} out */
function serviceFromLabels(c, name, labels, out) {
  const warn = (/** @type {string} */ reason) => out.warnings.push({ container: name, reason });
  const img = image(c);
  const [defaultIcon] = guessIconCategory(imageBase(img), name);

  const skip = (/** @type {string} */ reason) => {
    out.skipped.push({ container: name, reason });
    return null;
  };
  const rawUrl = labels[LABEL_PREFIX + 'url'];
  if (!(LABEL_PREFIX + 'url' in labels)) return skip(SKIP_URL_MISSING);
  if (typeof rawUrl !== 'string') return skip(SKIP_URL_INVALID);
  if (Array.from(rawUrl).length > MAX_URL) return skip(SKIP_URL_TOO_LONG);
  const url = rawUrl;
  // User info in the authority (the netloc of urlsplit contains "@").
  if (/^[^/?#]*:\/\/[^/?#]*@/.test(url.trim()) || /^\/\/[^/?#]*@/.test(url.trim())) return skip(SKIP_URL_CREDENTIALS);
  /** @type {Record<string, any>} */
  const fields = { url, name: prettify(name), icon: defaultIcon };

  let [raw, present] = label(labels, 'name');
  if (present) {
    const value = raw !== null ? cleanText(raw, 400) : '';
    if (value) fields.name = value;
    else warn('serverhub.name is empty or invalid; using the container name');
  }
  [raw, present] = label(labels, 'description');
  if (present) {
    if (raw === null) warn('serverhub.description is invalid; ignored');
    else fields.description = cleanText(raw, 1000);
  }
  [raw, present] = label(labels, 'icon');
  if (present) {
    const value = (raw || '').trim().toLowerCase();
    if (S.KNOWN_ICONS.has(value)) fields.icon = value;
    else warn('serverhub.icon is not a known icon id; using a default');
  }
  [raw, present] = label(labels, 'category');
  if (present) {
    const value = CATEGORY_BY_LOWER.get((raw || '').trim().toLowerCase());
    if (value !== undefined) fields.category = value;
    else if ((raw || '').trim()) warn('serverhub.category is not a known category id; using auto');
  }
  [raw, present] = label(labels, 'check');
  if (present) {
    const f = raw !== null ? flag(raw) : null;
    if (f === null) warn('serverhub.check must be true or false; using true');
    else fields.check = f;
  }

  // The same validators as an ordinary service. A bad URL skips the container;
  // any other bad field falls back to its default.
  /** @type {Record<string, any>} */
  const defaults = { name: prettify(name), description: '', icon: 'box', category: null };
  /** @type {Record<string, any> | null} */
  let svc = null;
  for (let i = 0; i <= Object.keys(defaults).length && !svc; i++) {
    try {
      svc = S.validate(S.ServiceCreate, fields);
    } catch (e) {
      if (!(e instanceof S.ValidationError)) throw e;
      const bad = new Set(Object.keys(e.fields).map((k) => k.split('.')[0]));
      if (bad.has('url')) return skip(SKIP_URL_NOT_HTTP);
      // A field without a default failed (not the URL): say so, do not blame serverhub.url.
      if (!bad.size || [...bad].some((f) => !(f in defaults))) return skip(SKIP_LABELS_INVALID);
      for (const f of [...bad].sort()) {
        warn(`serverhub.${f} is invalid; using a default`);
        fields[f] = defaults[f];
      }
    }
  }
  if (!svc) return null;

  return {
    id: `docker:${name}`,
    name: svc.name,
    url: svc.url,
    description: svc.description,
    icon: svc.icon,
    category: svc.category,
    check: svc.check,
    container: { name, image: img, state: stateOf(c), status: cleanText(c.Status, 200), health: healthOf(c) },
  };
}

/**
 * Service cards for every container labelled `serverhub.enable=true`.
 * @param {any[]} containers
 * @returns {Discovery}
 */
export function discover(containers) {
  /** @type {Discovery} */
  const out = { services: [], skipped: [], warnings: [] };
  /** @type {Set<string>} */
  const seen = new Set();
  for (const c of containers.slice(0, MAX_CONTAINERS)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const labels = labelsOf(c);
    const enable = labels[LABEL_PREFIX + 'enable'];
    if (typeof enable !== 'string' || flag(enable.slice(0, 16)) !== true) continue;
    const name = containerName(c);
    if (name === null) {
      out.skipped.push({ container: '?', reason: SKIP_NO_NAME });
      continue;
    }
    if (seen.has(name)) {
      // Docker names are unique; a second one means a misbehaving API.
      out.skipped.push({ container: name, reason: SKIP_DUPLICATE });
      continue;
    }
    if (stateOf(c) === null) {
      out.skipped.push({ container: name, reason: SKIP_UNKNOWN_STATE });
      continue;
    }
    const svc = serviceFromLabels(c, name, labels, out);
    if (svc) {
      seen.add(name);
      out.services.push(svc);
    }
  }
  if (containers.length > MAX_CONTAINERS) out.warnings.push({ container: '*', reason: `only the first ${MAX_CONTAINERS} containers were examined` });
  out.services.sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id));
  const checked = out.services.filter((s) => s.check && s.container.state === 'running').length;
  if (checked > MAX_DISCOVERED_CHECKS) {
    out.warnings.push({ container: '*', reason: `only the first ${MAX_DISCOVERED_CHECKS} running discovered services (by name) are status-checked; the other ${checked - MAX_DISCOVERED_CHECKS} report unknown` });
  }
  return out;
}

/**
 * Which discovered services get a status check: `targets` = ids of running
 * containers with `check` (the first 100 in list order); `fixed` = id ->
 * 'down' (not running) | 'unknown' (over the cap) answered without a request.
 * `check: false` services are in neither.
 * @param {Array<{ id: string, check: boolean, container: { state: string } }>} services
 * @returns {{ targets: string[], fixed: Record<string, 'down' | 'unknown'> }}
 */
export function statusPlan(services) {
  /** @type {string[]} */
  const targets = [];
  /** @type {Record<string, 'down' | 'unknown'>} */
  const fixed = {};
  for (const s of services) {
    if (!s.check) continue;
    if (s.container.state !== 'running') fixed[s.id] = 'down';
    else if (targets.length < MAX_DISCOVERED_CHECKS) targets.push(s.id);
    else fixed[s.id] = 'unknown';
  }
  return { targets, fixed };
}

const SELF_COMPOSE_SERVICES = new Set(['server-hub', 'docker-proxy']);
const SELF_IMAGES = new Set(['server-hub', 'serverhub']);
const PROXY_IMAGE_MARKER = 'socket-proxy';

/**
 * Server Hub itself or the socket proxy: by Compose service label, image name
 * (last path segment, no tag or digest) or the container id prefix.
 * @param {any} c
 * @param {string | null} [ownIdPrefix]
 */
export function isSelfOrProxy(c, ownIdPrefix = null) {
  const svc = labelsOf(c)['com.docker.compose.service'];
  if (typeof svc === 'string' && SELF_COMPOSE_SERVICES.has(svc)) return true;
  const base = imageBase(image(c)).toLowerCase();
  if (SELF_IMAGES.has(base) || base.includes(PROXY_IMAGE_MARKER)) return true;
  return !!(ownIdPrefix && typeof c.Id === 'string' && c.Id.startsWith(ownIdPrefix));
}

/** @param {string} a @param {string} b */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Running, unlabelled containers that publish at least one TCP port.
 * @param {any[]} containers
 * @param {{ publicHost: string | null, existingUrls: Iterable<string>, excludeIdPrefix?: string | null }} o
 */
export function suggest(containers, { publicHost, existingUrls, excludeIdPrefix = null }) {
  const existing = new Set([...existingUrls].map(normalizeUrl));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const out = [];
  for (const c of containers.slice(0, MAX_CONTAINERS)) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || stateOf(c) !== 'running') continue;
    if (LABEL_PREFIX + 'enable' in labelsOf(c)) continue; // labelled (either way): discovered or explicitly opted out
    const name = containerName(c);
    if (name === null || seen.has(name)) continue;
    if (isSelfOrProxy(c, excludeIdPrefix)) continue; // Server Hub's own container or the socket proxy
    seen.add(name);
    const ports = publishedPorts(c);
    const best = webPort(ports);
    if (!best) continue;
    const url = suggestedUrl(publicHost, best);
    if (url !== null && existing.has(normalizeUrl(url))) continue;
    const img = image(c);
    const [icon, category] = guessIconCategory(imageBase(img), name);
    out.push({
      container: { name, image: img, state: 'running' },
      ports,
      suggested: { name: prettify(name), url, icon, category },
    });
  }
  out.sort((a, b) => cmp(a.container.name.toLowerCase(), b.container.name.toLowerCase()));
  return out;
}
