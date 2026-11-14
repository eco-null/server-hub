// @ts-check
/**
 * Auto-categorisation for services. Pure module (no DOM, no globals).
 *
 * Matching is token based: the name, host and description are split into
 * lowercase alphanumeric tokens and a keyword only matches when all of its
 * tokens appear as whole, consecutive tokens ("git" matches "Git server" but
 * never "digital"). Separators are ignored, so "pi-hole", "Pi Hole" and
 * "pihole" all match the keyword "pi-hole".
 *
 * The service name and host are checked first; the description and URL path
 * are only consulted when nothing in the name/host matched, because
 * descriptions are free text and the most common source of false positives.
 */

import { ICON_SET } from './lib/icon-ids.js';

/**
 * Category ids; identical to the backend's KNOWN_CATEGORIES.
 * @type {readonly string[]}
 */
export const CATEGORIES = Object.freeze([
  'Monitoring', 'Security', 'Network', 'Media', 'Productivity', 'Files',
  'Dev', 'Communication', 'Home', 'Finance', 'AI', 'Search', 'Database',
  'Other', 'Gaming', 'Books', 'Money', 'Travel', 'Health',
]);

const CATEGORY_SET = new Set(CATEGORIES);

/** @type {Readonly<Record<string, readonly string[]>>} */
export const KEYWORD_RULES = Object.freeze({
  Monitoring: ['grafana', 'prometheus', 'kuma', 'uptime', 'alertmanager', 'loki', 'zabbix', 'pyroscope', 'kibana', 'observium', 'munin', 'sensu', 'netdata', 'glances', 'wakatime', 'beszel', 'gatus', 'checkmk', 'nagios'],
  Security: ['vault', 'warden', 'bitwarden', 'authelia', 'authentik', 'keycloak', 'vaultwarden', 'tor-proxy', 'onion routing', 'clamav', 'fail2ban', 'wazuh', 'crowdsec', 'unifi-protect', 'pocket-id', 'passbolt'],
  Network: ['pi-hole', 'pihole', 'adguard', 'wireguard', 'openvpn', 'tailscale', 'headscale', 'wg-easy', 'unbound', 'dnsmasq', 'traefik', 'nginx-proxy-manager', 'npmplus', 'cloudflare-tunnel', 'cloudflared', 'blocky', 'zerotier', 'caddy', 'nginx', 'haproxy', 'opnsense', 'pfsense', 'unifi', 'router'],
  Media: ['jellyfin', 'plex', 'emby', 'navidrome', 'audiobookshelf', 'komga', 'kavita', 'komf', 'sonarr', 'radarr', 'lidarr', 'prowlarr', 'readarr', 'tautulli', 'overseerr', 'ombi', 'bazarr', 'immich', 'photoprism', 'lychee', 'piwigo', 'tubearchivist', 'jellyseerr', 'photos', 'music', 'movies'],
  Productivity: ['nextcloud', 'owncloud', 'joplin', 'paperless', 'paperless-ngx', 'outline', 'wikijs', 'wiki', 'bookstack', 'etherpad', 'codimd', 'hedgedoc', 'trilium', 'notes', 'docmost', 'draw.io', 'excalidraw', 'flatnotes', 'memos', 'vikunja', 'planka', 'calendar'],
  Files: ['filebrowser', 'duplicati', 'restic', 'borg', 'filerun', 'seafile', 'rutorrent', 'transmission', 'qbittorrent', 'deluge', 'sabnzbd', 'nzbget', 'syncthing', 'minio', 'garage', 'rclone', 'sftpgo', 'filezilla', 'torrent', 'files'],
  Dev: ['gitea', 'gitlab', 'forgejo', 'git', 'woodpecker', 'drone', 'jenkins', 'teampass', 'code', 'coder', 'code-server', 'terminal', 'theia', 'kasm', 'docker', 'portainer', 'dockge', 'komodo', 'dokploy', 'kubernetes', 'k9s', 'coolify', 'n8n', 'registry'],
  Communication: ['matrix', 'element', 'synapse', 'conduit', 'dendrite', 'mastodon', 'pleroma', 'akkoma', 'misskey', 'firefish', 'xmpp', 'prosody', 'ejabberd', 'rocketchat', 'mattermost', 'zulip', 'cinny', 'ntfy', 'gotify', 'simplelogin', 'mail', 'chat'],
  Home: ['homeassistant', 'home-assistant', 'home assistant', 'home automation', 'hass', 'mosquitto', 'mqtt', 'zigbee2mqtt', 'zwave', 'frigate', 'esphome', 'scrypted', 'domoticz', 'openhab', 'node-red', 'govee'],
  Finance: ['firefly', 'fireflyiii', 'maybe', 'actual', 'budget', 'wallet', 'invoice', 'expense', 'ledger'],
  AI: ['semantic-kernel', 'open-webui', 'open webui', 'ollama', 'litellm', 'llamacpp', 'stable-diffusion', 'comfyui', 'automatic1111', 'text-generation-webui', 'openai', 'librechat', 'chatgpt', 'flowise', 'langflow', 'lobe-chat'],
  Search: ['searxng', 'searx', 'whoogle', 'mwmbl', 'librey', 'yacy'],
  Database: ['adminer', 'pgadmin', 'redisinsight', 'mongo-express', 'metabase', 'superset', 'beekeeper', 'dbeaver', 'mongo', 'mongodb', 'redis', 'postgres', 'postgresql', 'mysql', 'mariadb', 'cockroach', 'phpmyadmin'],
  Gaming: ['steam', 'epic games', 'minecraft', 'mc-router', 'palworld', 'gamevault', 'romm', 'retroarch', 'lutris', 'playnite', 'gaming'],
  Books: ['calibre', 'calibre-web', 'librarian', 'booksonic', 'lazy librarian', 'books'],
  Money: ['actual-budget', 'firefly-iii', 'ghostfolio', 'kresus', 'hledger', 'fava'],
  Travel: ['traccar', 'owntracks', 'wanderer', 'travel'],
  Health: ['tandoor', 'mealie', 'grocy', 'sleep', 'fitness', 'health'],
});

/**
 * Order categories are tested in; earlier wins when several match.
 * @type {readonly string[]}
 */
export const RANK = Object.freeze([
  'Security', 'Network', 'Monitoring', 'Database', 'AI',
  'Communication', 'Media', 'Files', 'Productivity', 'Dev',
  'Search', 'Home', 'Finance', 'Gaming', 'Books', 'Money', 'Travel', 'Health',
]);

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * @param {string} url
 * @returns {{ host: string, path: string }}
 */
function splitUrl(url) {
  if (!url) return { host: '', path: '' };
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url);
    return { host: u.hostname, path: u.pathname };
  } catch {
    return { host: '', path: '' };
  }
}

/**
 * Prepared view of a token list: the set of tokens plus the concatenation of
 * each adjacent pair, so "Pi Hole" can match the single-word keyword "pihole".
 * @param {string[]} tokens
 */
function prepare(tokens) {
  const set = new Set(tokens);
  const pairs = new Set();
  for (let i = 0; i + 1 < tokens.length; i++) pairs.add(tokens[i] + tokens[i + 1]);
  return { tokens, set, pairs };
}

/**
 * @param {ReturnType<typeof prepare>} view
 * @param {{ parts: string[], joined: string }} kw
 */
function matches(view, kw) {
  const { parts, joined } = kw;
  if (parts.length === 1) return view.set.has(joined) || view.pairs.has(joined);
  // consecutive whole tokens
  outer: for (let i = 0; i + parts.length <= view.tokens.length; i++) {
    for (let j = 0; j < parts.length; j++) if (view.tokens[i + j] !== parts[j]) continue outer;
    return true;
  }
  return view.set.has(joined) || view.pairs.has(joined);
}

/** Compiled rules: [category, keyword, {parts, joined}] in match order. */
const COMPILED = RANK.flatMap((category) =>
  (KEYWORD_RULES[category] || [])
    .map((keyword) => {
      const parts = tokenize(keyword);
      return { category, keyword: keyword.toLowerCase(), parts, joined: parts.join('') };
    })
    .filter((k) => k.parts.length > 0),
);

/**
 * Guesses a category for a service.
 * @param {string} name
 * @param {string} url
 * @param {string} [description]
 * @returns {{ category: string, matched: string | null }}
 */
export function autoCategorize(name, url, description = '') {
  const { host, path } = splitUrl(url);
  const tiers = [
    prepare([...tokenize(name), ...tokenize(host)]),
    prepare([...tokenize(description), ...tokenize(path)]),
  ];
  for (const view of tiers) {
    if (!view.tokens.length) continue;
    for (const kw of COMPILED) {
      if (matches(view, kw)) return { category: kw.category, matched: kw.keyword };
    }
  }
  return { category: 'Other', matched: null };
}

/**
 * The category a service is shown under: its explicit category, or the
 * auto-detected one when `category` is null/unknown. The auto result is never
 * stored, so renaming a service re-categorises it.
 * @param {{ name: string, url: string, description?: string, category?: string | null }} service
 * @returns {string}
 */
export function resolveCategory(service) {
  if (typeof service.category === 'string' && CATEGORY_SET.has(service.category)) return service.category;
  return autoCategorize(service.name, service.url, service.description).category;
}

/** @type {Readonly<Record<string, string>>} */
const CATEGORY_ICON = Object.freeze({
  Monitoring: 'chart', Security: 'shield', Network: 'globe', Media: 'film',
  Productivity: 'note', Files: 'folder', Dev: 'git', Communication: 'broadcast',
  Home: 'home', Finance: 'wallet', AI: 'sparkles', Search: 'pulse',
  Database: 'database', Gaming: 'gamepad', Books: 'book', Money: 'wallet',
  Travel: 'map-pin', Health: 'activity', Other: 'box',
});

/** Name tokens that suggest a more specific icon than the category default. */
const NAME_ICON = [
  [['git', 'gitea', 'gitlab', 'forgejo', 'coder', 'code-server'], 'git'],
  [['music', 'navidrome', 'spotify'], 'music'],
  [['torrent', 'qbittorrent', 'deluge', 'transmission', 'sabnzbd', 'nzbget'], 'download'],
  [['steam', 'minecraft', 'palworld', 'gamevault', 'romm'], 'gamepad'],
  [['calibre', 'book', 'books', 'readarr'], 'book'],
  [['ghostfolio', 'finance', 'money', 'budget'], 'wallet'],
  [['traccar', 'map', 'maps', 'travel', 'gps'], 'map-pin'],
  [['mealie', 'grocy', 'health', 'fitness'], 'activity'],
].map(([words, id]) => ({ words: /** @type {string[]} */ (words).map((w) => tokenize(w).join('')), id: /** @type {string} */ (id) }));

/**
 * Picks a sensible default icon for a new service.
 * @param {string} category
 * @param {string} name
 * @returns {string} always a known icon id
 */
export function suggestIcon(category, name) {
  const view = prepare(tokenize(name));
  for (const rule of NAME_ICON) {
    if (rule.words.some((w) => view.set.has(w) || view.pairs.has(w))) return rule.id;
  }
  const byCategory = Object.hasOwn(CATEGORY_ICON, category) ? CATEGORY_ICON[category] : 'box';
  return ICON_SET.has(byCategory) ? byCategory : 'box';
}
