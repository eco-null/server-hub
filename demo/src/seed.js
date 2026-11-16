// @ts-check
/**
 * The demo's starting state: a believable homelab for "Alex". Every address
 * is under home.arpa (the special-use domain for home networks, RFC 8375), so
 * nothing here points at a real person's server. No IPs, no secrets.
 */

/** Credentials shown on the demo login page. Not a secret: this is a public demo. */
export const DEMO_USERNAME = 'demo';
export const DEMO_PASSWORD = 'serverhub-demo';

const T0 = '2026-09-12T08:30:00Z';

/** @param {number} n */
const at = (n) => new Date(Date.parse(T0) + n * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * name, url, icon, category, description, simulated health
 * @type {Array<[string, string, string, string, string, ('up' | 'down' | 'unknown')?]>}
 */
const SERVICES = [
  ['Jellyfin', 'https://jellyfin.home.arpa', 'film', 'Media', 'Movies and shows for the whole family'],
  ['Immich', 'https://photos.home.arpa', 'image', 'Media', 'Photo and video backup from our phones'],
  ['Navidrome', 'https://music.home.arpa', 'music', 'Media', 'Music library and streaming'],
  ['Audiobookshelf', 'https://audiobooks.home.arpa', 'headphones', 'Media', 'Audiobooks and podcasts', 'unknown'],
  ['Grafana', 'https://grafana.home.arpa', 'chart', 'Monitoring', 'Dashboards for the rack and the network'],
  ['Uptime Kuma', 'https://status.home.arpa', 'pulse', 'Monitoring', 'Uptime checks and notifications'],
  ['Pi-hole', 'http://pihole.home.arpa/admin', 'shield', 'Network', 'Network-wide ad blocking and local DNS'],
  ['Nginx Proxy Manager', 'https://proxy.home.arpa', 'globe', 'Network', 'Reverse proxy and certificates'],
  ['UniFi Network', 'https://unifi.home.arpa:8443', 'wifi', 'Network', 'Access points and switches'],
  ['Vaultwarden', 'https://vault.home.arpa', 'key', 'Security', 'Password manager'],
  ['Authentik', 'https://auth.home.arpa', 'shield-check', 'Security', 'Single sign-on for the other apps'],
  ['Nextcloud', 'https://cloud.home.arpa', 'cloud', 'Productivity', 'Files, calendars and contacts'],
  ['Paperless-ngx', 'https://paperless.home.arpa', 'file', 'Productivity', 'Scanned letters and receipts, searchable'],
  ['Gitea', 'https://git.home.arpa', 'git', 'Dev', 'Personal repositories and mirrors'],
  ['Portainer', 'https://portainer.home.arpa:9443', 'box', 'Dev', 'Docker containers on both hosts'],
  ['Home Assistant', 'http://homeassistant.home.arpa:8123', 'home', 'Home', 'Lights, heating and sensors'],
  ['Frigate', 'http://frigate.home.arpa:5000', 'camera', 'Home', 'Camera recordings and detection', 'down'],
  ['Open WebUI', 'https://ai.home.arpa', 'sparkles', 'AI', 'Chat with local models running on the GPU box'],
];

/** @type {Array<[string, string, string]>} */
const BOOKMARKS = [
  ['Proxmox', 'https://pve.home.arpa:8006', '#E57000'],
  ['Router', 'http://router.home.arpa', '#0EA5E9'],
  ['NAS', 'https://nas.home.arpa:5001', '#22C55E'],
  ['Printer', 'http://printer.home.arpa', '#A855F7'],
  ['awesome-selfhosted', 'https://awesome-selfhosted.net', '#F59E0B'],
  ['Server Hub', 'https://github.com/eco-null/server-hub', '#5E6AD2'],
];

/**
 * Beszel hubs and their systems. Base values for the simulated metrics.
 * @type {Array<{ name: string, url: string, username: string, systems: Array<{ name: string, host: string, cpu: number, memory: number, disk: number, uptimeDays: number }> }>}
 */
export const BESZEL_HUBS = [
  {
    name: 'Rack',
    url: 'https://beszel.home.arpa',
    username: 'alex@home.arpa',
    systems: [
      { name: 'pve-01', host: 'pve-01.home.arpa', cpu: 18, memory: 61, disk: 42, uptimeDays: 41 },
      { name: 'nas', host: 'nas.home.arpa', cpu: 7, memory: 38, disk: 73, uptimeDays: 96 },
      { name: 'docker-host', host: 'docker.home.arpa', cpu: 26, memory: 70, disk: 55, uptimeDays: 12 },
    ],
  },
  {
    name: 'Edge',
    url: 'http://monitor.home.arpa:8090',
    username: 'alex@home.arpa',
    systems: [
      { name: 'pihole-pi', host: 'pihole.home.arpa', cpu: 4, memory: 33, disk: 21, uptimeDays: 58 },
      { name: 'gpu-box', host: 'gpu.home.arpa', cpu: 35, memory: 64, disk: 48, uptimeDays: 3 },
      { name: 'backup-vps', host: 'backup.home.arpa', cpu: 3, memory: 27, disk: 81, uptimeDays: 133 },
    ],
  },
];

/**
 * Docker auto-discovery: the simulated Docker host. The socket proxy is
 * reached as `docker-proxy`; suggestions point at the host's public address.
 * Everything under home.arpa, like the rest of the seed.
 */
export const DOCKER_PROXY_HOST = 'docker-proxy';
export const DOCKER_PUBLIC_HOST = 'docker.home.arpa';
/** Server Hub's own container (a hostname-style short id): never suggested. */
export const DOCKER_SELF_ID_PREFIX = '5c1f0a9e2b4d';

/**
 * What `GET /containers/json?all=true` would list, before the clock is applied
 * (see `dockerContainers()` in sim.js). Times are seconds: `upS` is the uptime
 * when the demo starts, `agoS` how long ago a stopped container exited, and
 * `healthyAfterS` the uptime at which a "starting" health check turns healthy.
 * Ports are `[private, public]` (published on all addresses) or
 * `[private, public, 'tcp' | 'udp', ip]`.
 * @typedef {{
 *   name: string, image: string, state: 'running' | 'exited', upS?: number, agoS?: number, exitCode?: number,
 *   health?: 'healthy' | 'unhealthy' | 'starting', healthyAfterS?: number, idPrefix?: string,
 *   ports?: Array<[number, number] | [number, number, string, string]>, labels?: Record<string, string>,
 * }} DockerFixture
 */

/** @param {Record<string, string>} l @returns {Record<string, string>} */
const sh = (l) => Object.fromEntries(Object.entries(l).map(([k, v]) => ['serverhub.' + k, v]));

const DAY = 86400;
const HOUR = 3600;

/** @type {DockerFixture[]} */
export const DOCKER_CONTAINERS = [
  { name: 'dozzle', image: 'amir20/dozzle:v8.13.4', state: 'running', upS: 12 * DAY, health: 'healthy', ports: [[8080, 8888]], labels: sh({ enable: 'true', name: 'Dozzle', url: 'https://logs.home.arpa', description: 'Live logs for every container on this host', icon: 'terminal', category: 'Dev' }) },
  // Starts "starting" and turns healthy 90 seconds after it came up (so about a minute after the demo opens).
  { name: 'mealie', image: 'ghcr.io/mealie-recipes/mealie:v2.4.2', state: 'running', upS: 20, health: 'starting', healthyAfterS: 90, ports: [[9000, 9925]], labels: sh({ enable: 'true', name: 'Mealie', url: 'https://recipes.home.arpa', description: 'Recipes and the weekly meal plan', icon: 'book', category: 'Home' }) },
  // Same address as the user's own "Portainer" card, which wins.
  { name: 'portainer', image: 'portainer/portainer-ce:2.21.4', state: 'running', upS: 12 * DAY, ports: [[9443, 9443], [8000, 8000]], labels: sh({ enable: 'true', name: 'Portainer', url: 'https://portainer.home.arpa:9443', description: 'Manage the containers on this host' }) },
  { name: 'qbittorrent', image: 'lscr.io/linuxserver/qbittorrent:5.0.2', state: 'running', upS: 3 * DAY, ports: [[8080, 8085]], labels: sh({ enable: 'true', name: 'qBittorrent', url: 'https://downloads.home.arpa', description: 'Torrent client behind the VPN container', icon: 'download', category: 'Media', check: 'false' }) },
  { name: 'radarr', image: 'lscr.io/linuxserver/radarr:5.14.0', state: 'running', upS: 3 * DAY, ports: [[7878, 7878]], labels: sh({ enable: 'true', name: 'Radarr', url: 'https://radarr.home.arpa', description: 'Movie library automation', icon: 'film', category: 'Media' }) },
  { name: 'searxng', image: 'searxng/searxng:2025.1.12', state: 'running', upS: 6 * HOUR, health: 'unhealthy', ports: [[8080, 8890]], labels: sh({ enable: 'true', name: 'SearXNG', url: 'https://search.home.arpa', description: 'Private metasearch for the whole house', icon: 'globe', category: 'Search' }) },
  { name: 'sonarr', image: 'lscr.io/linuxserver/sonarr:4.0.11', state: 'running', upS: 3 * DAY, ports: [[8989, 8989]], labels: sh({ enable: 'true', name: 'Sonarr', url: 'https://sonarr.home.arpa', description: 'TV show library automation', icon: 'film', category: 'Media' }) },
  { name: 'syncthing', image: 'syncthing/syncthing:1.29.2', state: 'exited', agoS: 2 * DAY, exitCode: 137, labels: sh({ enable: 'true', name: 'Syncthing', url: 'https://sync.home.arpa', description: 'File sync between the laptops and the NAS', icon: 'refresh', category: 'Files' }) },
  // The icon label is not a known icon id: a warning, and the card falls back to the guessed icon.
  { name: 'vikunja', image: 'vikunja/vikunja:0.24.6', state: 'running', upS: 4 * DAY, health: 'healthy', ports: [[3456, 3456]], labels: sh({ enable: 'true', name: 'Vikunja', url: 'https://tasks.home.arpa', description: 'Shared to-do lists', icon: 'tasks', category: 'Productivity' }) },
  // Labelled, but the address has no scheme: skipped.
  { name: 'whoami', image: 'traefik/whoami:v1.10.3', state: 'running', upS: 12 * DAY, ports: [[80, 8089]], labels: sh({ enable: 'true', name: 'Whoami', url: 'whoami.home.arpa' }) },
  // Opted out explicitly: neither discovered nor suggested.
  { name: 'adminer', image: 'adminer:4.8.1', state: 'running', upS: 12 * DAY, ports: [[8080, 8081]], labels: sh({ enable: 'false' }) },
  // Plumbing that is never suggested.
  { name: DOCKER_PROXY_HOST, image: 'tecnativa/docker-socket-proxy:0.3.0', state: 'running', upS: 12 * DAY },
  { name: 'server-hub', image: 'ghcr.io/eco-null/server-hub:2.0.0', state: 'running', upS: 12 * DAY, health: 'healthy', idPrefix: DOCKER_SELF_ID_PREFIX, ports: [[8080, 8080]] },
  { name: 'postgres', image: 'postgres:16-alpine', state: 'running', upS: 12 * DAY, health: 'healthy', ports: [[5432, 5432, 'tcp', '127.0.0.1']] },
  { name: 'old-registry', image: 'registry:2', state: 'exited', agoS: 19 * DAY, exitCode: 0, ports: [[5000, 5000]] },
  // Unlabelled and publishing a web port: suggestions for the admin.
  { name: 'bookstack', image: 'lscr.io/linuxserver/bookstack:24.12.1', state: 'running', upS: 5 * DAY, ports: [[80, 6875]] },
  { name: 'filebrowser', image: 'filebrowser/filebrowser:v2.31.2', state: 'running', upS: 9 * DAY, health: 'healthy', ports: [[80, 8082]] },
  { name: 'node-red', image: 'nodered/node-red:4.0.8', state: 'running', upS: 9 * DAY, ports: [[1880, 1880]] },
  { name: 'prometheus', image: 'prom/prometheus:v3.1.0', state: 'running', upS: 12 * DAY, ports: [[9090, 9090]] },
];

/**
 * A fresh demo state. `uuid` is injected so tests are deterministic.
 * @param {() => string} uuid
 */
export function seedState(uuid) {
  const demoId = uuid();
  const users = [
    { id: demoId, email: 'demo@home.arpa', username: DEMO_USERNAME, role: 'admin', created_at: at(0), password: DEMO_PASSWORD, fixed_password: true },
    { id: uuid(), email: 'jordan@home.arpa', username: 'jordan', role: 'user', created_at: at(60 * 24 * 3), password: 'jordan-password-1' },
    { id: uuid(), email: 'sam@home.arpa', username: 'sam', role: 'user', created_at: at(60 * 24 * 9), password: 'sam-password-12' },
  ].map((u) => ({ totp_secret: null, totp_pending: null, totp_pending_exp: 0, totp_last_step: -1, recovery: [], fixed_password: false, ...u }));

  /** @type {Record<string, 'up' | 'down' | 'unknown'>} */
  const health = {};
  const services = SERVICES.map(([name, url, icon, category, description, h], i) => {
    const id = uuid();
    if (h) health[id] = h;
    return { id, name, url, description, icon, category, check: true, created_at: at(10 + i) };
  });
  const bookmarks = BOOKMARKS.map(([name, url, color], i) => ({ id: uuid(), name, url, color, created_at: at(40 + i) }));
  /** @type {Record<string, any>} */
  const beszelSystems = {};
  const beszel = BESZEL_HUBS.map((hub) => {
    const id = uuid();
    beszelSystems[id] = hub.systems;
    return { id, name: hub.name, url: hub.url, username: hub.username, password: 'demo' };
  });

  const settings = {
    theme: 'dark',
    accent: '#5E6AD2',
    userName: 'Alex',
    pageTitle: 'Homelab',
    subtitle: 'Everything running at home, in one place.',
    defaultDomain: 'home.arpa',
    wallpaper: { mode: 'none', gradient: 'default', url: '', showGrid: false },
    features: { clock: true, greeting: true, stats: true, search: true, statusChecks: true },
    search: { provider: 'duckduckgo', searxngUrl: '' },
  };

  /** @type {Record<string, { settings: any, services: any[], bookmarks: any[], beszel: any[] }>} */
  const data = {};
  for (const u of users) data[u.id] = { settings: null, services: [], bookmarks: [], beszel: [] };
  data[demoId] = { settings, services, bookmarks, beszel };

  return {
    v: 1,
    session: demoId,
    pending: null,
    registration_open: false,
    users,
    data,
    health,
    beszelSystems,
    // Docker discovery. `t0` (ms) is when the simulated containers' clocks started; set on first load.
    docker: { t0: null, visible_to_users: false },
  };
}
