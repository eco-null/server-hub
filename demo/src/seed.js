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
    theme: 'auto',
    accent: '#5E6AD2',
    userName: 'Alex',
    pageTitle: 'Homelab',
    subtitle: 'Everything running at home, in one place.',
    defaultDomain: 'home.arpa',
    wallpaper: { mode: 'gradient', gradient: 'ocean', url: '', showGrid: true },
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
  };
}
