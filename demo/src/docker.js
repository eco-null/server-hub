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

/** Comparison key for "is this URL already one of my services?". @param {string} url */
export function normalizeUrl(url) {
  try {
    const u = new URL(url.trim());
    const scheme = u.protocol.replace(/:$/, '').toLowerCase();
    const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
    return `${scheme}://${u.hostname.toLowerCase().replace(/^\[|\]$/g, '')}:${port}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

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

  const [url, urlPresent] = label(labels, 'url');
  if (url === null) {
    out.skipped.push({ container: name, reason: !urlPresent ? 'serverhub.url is missing' : 'serverhub.url is invalid' });
    return null;
  }
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
      if (bad.has('url') || !bad.size || [...bad].some((f) => !(f in defaults))) {
        out.skipped.push({ container: name, reason: 'serverhub.url is not a valid http(s) URL' });
        return null;
      }
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
  for (const c of containers.slice(0, MAX_CONTAINERS)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const labels = labelsOf(c);
    const enable = labels[LABEL_PREFIX + 'enable'];
    if (typeof enable !== 'string' || flag(enable.slice(0, 16)) !== true) continue;
    const name = containerName(c);
    if (name === null) {
      out.skipped.push({ container: '?', reason: 'container has no usable name' });
      continue;
    }
    if (stateOf(c) === null) {
      out.skipped.push({ container: name, reason: 'unknown container state' });
      continue;
    }
    const svc = serviceFromLabels(c, name, labels, out);
    if (svc) out.services.push(svc);
  }
  if (containers.length > MAX_CONTAINERS) out.warnings.push({ container: '*', reason: `only the first ${MAX_CONTAINERS} containers were examined` });
  out.services.sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id));
  return out;
}

/** @param {string} a @param {string} b */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Running, unlabelled containers that publish at least one TCP port.
 * @param {any[]} containers
 * @param {{ publicHost: string | null, existingUrls: Iterable<string>, excludeNames?: string[], excludeIdPrefix?: string | null }} o
 */
export function suggest(containers, { publicHost, existingUrls, excludeNames = [], excludeIdPrefix = null }) {
  const existing = new Set([...existingUrls].map(normalizeUrl));
  /** @type {any[]} */
  const out = [];
  for (const c of containers.slice(0, MAX_CONTAINERS)) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || stateOf(c) !== 'running') continue;
    if (LABEL_PREFIX + 'enable' in labelsOf(c)) continue; // labelled (either way): discovered or explicitly opted out
    const name = containerName(c);
    if (name === null || excludeNames.includes(name)) continue;
    if (excludeIdPrefix && typeof c.Id === 'string' && c.Id.startsWith(excludeIdPrefix)) continue; // Server Hub's own container
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
