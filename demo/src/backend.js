// @ts-check
/**
 * In-browser stand-in for the Server Hub HTTP API (docs/API.md).
 *
 * Pure logic: no DOM and no network. State lives in one JSON document in the
 * given key/value storage (localStorage in the browser), so edits survive
 * reloads and page changes and stay with the visitor. `handle()` takes a
 * method, path and raw body and returns `{ status, body }` in the same shapes
 * and error format as the real server.
 */

import * as S from './validate.js';
import { seedState, DEMO_USERNAME, DOCKER_CONTAINERS, DOCKER_PROXY_HOST, DOCKER_PUBLIC_HOST, DOCKER_SELF_ID_PREFIX } from './seed.js';
import { serviceStatus, systemNow, systemsForNewHub, hostStats, dockerContainers, dockerServiceHealth } from './sim.js';
import { discover, suggest } from './docker.js';
import { matchStep, newSecret, newRecoveryCodes, normalizeRecoveryCode, provisioningUri } from './totp.js';
import { qrSvg } from './qr.js';

export const STATE_KEY = 'serverhub-demo:v1';
const PENDING_TTL_MS = 5 * 60 * 1000;
const PENDING_MAX_ATTEMPTS = 5;
const TOTP_SETUP_TTL_MS = 10 * 60 * 1000;
const GENERIC_BESZEL_ERROR = 'Could not reach Beszel or sign in; check the URL and credentials';

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string>} [fields]
   */
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
  body() {
    /** @type {Record<string, any>} */
    const err = { code: this.code, message: this.message };
    if (this.fields) err.fields = this.fields;
    return { error: err };
  }
}

const notFound = () => new HttpError(404, 'not_found', 'Not found');
const invalidCode = () => new HttpError(401, 'invalid_code', 'That code is not valid');
const wrongCurrentPassword = () => new HttpError(400, 'validation', 'Current password is incorrect', { current_password: 'incorrect' });

/** @param {S.ValidationError} e */
const validationError = (e) => new HttpError(400, 'validation', 'Invalid input', e.fields);

/**
 * Runs a validator and turns its failure into the API's 400 shape.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function parse(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof S.ValidationError) throw validationError(e);
    throw e;
  }
}

/** A canonical lowercase UUID, else 404 (like uuid.UUID() on the server). @param {unknown} raw */
export function canonicalId(raw) {
  if (typeof raw !== 'string' || raw.length > 64) throw notFound();
  const hex = raw.trim().toLowerCase().replace(/^urn:uuid:/, '').replace(/^\{(.*)\}$/, '$1').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw notFound();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} KV
 * @typedef {{ status: number, body?: any }} Reply
 */

/** @returns {KV} */
export function memoryKv() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}

/**
 * @param {{ storage?: KV, now?: () => number, uuid?: () => string, key?: string }} [opts]
 */
export function createBackend(opts = {}) {
  const storage = opts.storage || memoryKv();
  const now = opts.now || (() => Date.now());
  const uuid = opts.uuid || (() => globalThis.crypto.randomUUID());
  const key = opts.key || STATE_KEY;

  /** @returns {any} */
  function load() {
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const st = JSON.parse(raw);
        if (st && st.v === 1 && Array.isArray(st.users) && st.data) return withDocker(st);
      }
    } catch {
      /* corrupt or unavailable: start over */
    }
    const st = withDocker(seedState(uuid));
    save(st);
    return st;
  }

  /**
   * The Docker simulation's own state. Also fills it in for a document saved
   * before Docker discovery existed, so visitors with older data keep working.
   * @param {any} st
   */
  function withDocker(st) {
    if (!st.docker || typeof st.docker !== 'object') st.docker = { t0: null, visible_to_users: false };
    if (typeof st.docker.t0 !== 'number') st.docker.t0 = now();
    st.docker.visible_to_users = st.docker.visible_to_users === true;
    return st;
  }

  /** @param {any} st */
  function save(st) {
    try {
      storage.setItem(key, JSON.stringify(st));
    } catch {
      /* quota or blocked storage: the demo keeps working for this page view */
    }
  }

  const iso = () => new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // ---------- helpers on the state document ----------

  /** @param {any} u @param {boolean} [withCreated] */
  function userOut(u, withCreated = false) {
    /** @type {Record<string, any>} */
    const out = { id: u.id, email: u.email, username: u.username, role: u.role, twofa_enabled: !!u.totp_secret };
    if (withCreated) out.created_at = u.created_at;
    return out;
  }

  /** @param {any} st */
  function currentUser(st) {
    return (st.session && st.users.find((/** @type {any} */ u) => u.id === st.session)) || null;
  }

  /** @param {any} st */
  function requireUser(st) {
    const u = currentUser(st);
    if (!u) throw new HttpError(401, 'unauthenticated', 'Sign in required');
    return u;
  }

  /** @param {any} st */
  function requireAdmin(st) {
    const u = requireUser(st);
    if (u.role !== 'admin') throw new HttpError(403, 'forbidden', 'Admin access required');
    return u;
  }

  /** @param {any} st @param {string} uid */
  function userData(st, uid) {
    if (!st.data[uid]) st.data[uid] = { settings: null, services: [], bookmarks: [], beszel: [] };
    return st.data[uid];
  }

  /** @param {any} st @param {string} uid */
  function loadSettings(st, uid) {
    const stored = userData(st, uid).settings || {};
    try {
      return S.validate(S.Settings, S.deepMerge(S.defaultSettings(), stored));
    } catch {
      return S.defaultSettings();
    }
  }

  /** @param {any} st @param {any} user */
  function bootstrap(st, user) {
    const d = userData(st, user.id);
    return { user: userOut(user), settings: loadSettings(st, user.id), services: d.services, bookmarks: d.bookmarks, docker: { enabled: dockerVisible(st, user) } };
  }

  // ---------- Docker discovery (simulated host, see seed.js / sim.js) ----------

  /** Discovery is always "configured" in the demo; admins always see it, others only while the switch is on. @param {any} st @param {any} user */
  const dockerVisible = (st, user) => user.role === 'admin' || st.docker.visible_to_users === true;

  /** The containers the simulated Docker API lists right now. @param {any} st */
  const dockerList = (st) => dockerContainers(DOCKER_CONTAINERS, st.docker.t0, now());

  /** @param {any} st */
  const readConfig = (st) => ({ registration_open: !!st.registration_open, docker_visible_to_users: st.docker.visible_to_users === true });

  /** @param {any} st */
  const adminCount = (st) => st.users.filter((/** @type {any} */ u) => u.role === 'admin').length;

  /** @param {any} st @param {string} email @param {string} username */
  function assertUnique(st, email, username) {
    if (st.users.some((/** @type {any} */ u) => u.email === email)) throw new HttpError(409, 'conflict', 'That email is already in use', { email: 'taken' });
    if (st.users.some((/** @type {any} */ u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw new HttpError(409, 'conflict', 'That username is already taken', { username: 'taken' });
    }
  }

  /** @param {any} st @param {{ email: string, username: string, password: string }} b @param {string} role */
  function createUser(st, b, role) {
    assertUnique(st, b.email, b.username);
    const u = { id: uuid(), email: b.email, username: b.username, role, created_at: iso(), password: b.password, fixed_password: false, totp_secret: null, totp_pending: null, totp_pending_exp: 0, totp_last_step: -1, recovery: [] };
    st.users.push(u);
    userData(st, u.id);
    return u;
  }

  /** @param {any} user @param {string} password */
  function checkCurrentPassword(user, password) {
    if (password !== user.password) throw wrongCurrentPassword();
  }

  /** TOTP (single use per step) or an unused recovery code. @param {any} user @param {string} code */
  async function verifySecondFactor(user, code) {
    if (!user.totp_secret) return false;
    code = code.trim();
    if (/^\d{6}$/.test(code)) {
      const step = await matchStep(user.totp_secret, code, now() / 1000);
      if (step === null || step <= user.totp_last_step) return false;
      user.totp_last_step = step;
      return true;
    }
    const n = normalizeRecoveryCode(code);
    if (n.length !== 10) return false;
    const i = user.recovery.indexOf(n);
    if (i < 0) return false;
    user.recovery.splice(i, 1);
    return true;
  }

  /**
   * @param {any} st
   * @param {string} uid
   * @param {'services' | 'bookmarks' | 'beszel'} table
   * @param {string} id
   */
  function findOwned(st, uid, table, id) {
    const row = userData(st, uid)[table].find((/** @type {any} */ r) => r.id === id);
    if (!row) throw notFound();
    return row;
  }

  /** @param {any} inst */
  function beszelOut(inst) {
    return { id: inst.id, name: inst.name, url: inst.url, username: inst.username, has_password: !!inst.password };
  }

  /** @param {string} url */
  function defaultBeszelName(url) {
    try {
      return (new URL(url).hostname || 'Beszel').slice(0, 200);
    } catch {
      return 'Beszel';
    }
  }

  /** Simulated hub login: a password of "wrong" is rejected, everything else works. @param {{ username: string, password: string }} t */
  function beszelLoginError(t) {
    return t.password === 'wrong' ? 'Beszel rejected the username or password' : null;
  }

  // ---------- routes ----------

  /** @typedef {{ st: any, body: any, params: Record<string, string> }} Ctx */
  /** @type {Array<[string, RegExp, (c: Ctx) => any]>} */
  const routes = [];
  const route = (/** @type {string} */ method, /** @type {string} */ path, /** @type {(c: Ctx) => any} */ fn) => {
    routes.push([method, new RegExp('^' + path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '$'), fn]);
  };

  // auth
  route('GET', '/api/auth/state', ({ st }) => ({ setup_required: false, registration_open: !!st.registration_open, authenticated: !!currentUser(st) }));
  route('POST', '/api/auth/setup', ({ body }) => {
    parse(() => S.validate(S.SetupIn, body));
    throw new HttpError(409, 'setup_complete', 'Setup has already been completed');
  });
  route('POST', '/api/auth/register', ({ st, body }) => {
    if (!st.registration_open) throw new HttpError(403, 'registration_closed', 'Registration is closed');
    const b = parse(() => S.validate(S.SignupIn, body));
    const u = createUser(st, /** @type {any} */ (b), 'user');
    st.session = u.id;
    st.pending = null;
    return { user: userOut(u) };
  });
  route('POST', '/api/auth/login', ({ st, body }) => {
    const b = parse(() => S.validate(S.LoginIn, body));
    const ident = String(b.identifier).toLowerCase();
    const user = ident ? st.users.find((/** @type {any} */ u) => u.username.toLowerCase() === ident || u.email === ident) : null;
    if (!user || user.password !== b.password) throw new HttpError(401, 'invalid_credentials', 'Invalid username/email or password');
    if (user.totp_secret) {
      st.pending = { uid: user.id, exp: now() + PENDING_TTL_MS, attempts: 0 };
      return { twofa_required: true };
    }
    st.session = user.id;
    st.pending = null;
    return { user: userOut(user) };
  });
  route('POST', '/api/auth/2fa', async ({ st, body }) => {
    const b = parse(() => S.validate(S.CodeIn, body));
    const p = st.pending;
    if (!p || p.exp < now() || p.attempts >= PENDING_MAX_ATTEMPTS) {
      throw new HttpError(401, 'login_expired', 'Your sign-in attempt expired, enter your password again');
    }
    p.attempts += 1;
    const user = st.users.find((/** @type {any} */ u) => u.id === p.uid);
    if (!user || !(await verifySecondFactor(user, b.code))) throw invalidCode();
    st.session = user.id;
    st.pending = null;
    return { user: userOut(user) };
  });
  route('POST', '/api/auth/logout', ({ st }) => {
    st.session = null;
    st.pending = null;
    return null;
  });

  // account
  route('GET', '/api/me', ({ st }) => ({ user: userOut(requireUser(st)) }));
  route('PUT', '/api/me/password', ({ st, body }) => {
    const user = requireUser(st);
    const b = parse(() => S.validate(S.PasswordChangeIn, body));
    checkCurrentPassword(user, b.current_password);
    // The shared demo account keeps the password printed on the login page.
    if (!user.fixed_password) user.password = b.new_password;
    return null;
  });
  route('POST', '/api/me/2fa/setup', ({ st, body }) => {
    const user = requireUser(st);
    const b = parse(() => S.validate(S.TwofaSetupIn, body));
    if (user.totp_secret) throw new HttpError(409, 'twofa_enabled', 'Two-factor authentication is already enabled');
    checkCurrentPassword(user, b.current_password);
    const secret = newSecret();
    user.totp_pending = secret;
    user.totp_pending_exp = now() + TOTP_SETUP_TTL_MS;
    const uri = provisioningUri(secret, user.username);
    return { secret, otpauth_uri: uri, qr_svg: qrSvg(uri) };
  });
  route('POST', '/api/me/2fa/enable', async ({ st, body }) => {
    const user = requireUser(st);
    const b = parse(() => S.validate(S.CodeIn, body));
    if (user.totp_secret) throw new HttpError(409, 'twofa_enabled', 'Two-factor authentication is already enabled');
    if (!user.totp_pending || user.totp_pending_exp < now()) throw new HttpError(409, 'twofa_setup_expired', 'Start two-factor setup again');
    const step = await matchStep(user.totp_pending, b.code, now() / 1000);
    if (step === null) throw invalidCode();
    const codes = newRecoveryCodes();
    user.totp_secret = user.totp_pending;
    user.totp_pending = null;
    user.totp_pending_exp = 0;
    user.totp_last_step = step;
    user.recovery = codes.map(normalizeRecoveryCode);
    return { recovery_codes: codes };
  });
  route('POST', '/api/me/2fa/disable', async ({ st, body }) => {
    const user = requireUser(st);
    const b = parse(() => S.validate(S.TwofaDisableIn, body));
    if (!user.totp_secret) throw new HttpError(409, 'twofa_disabled', 'Two-factor authentication is not enabled');
    checkCurrentPassword(user, b.current_password);
    if (!(await verifySecondFactor(user, b.code))) throw invalidCode();
    user.totp_secret = null;
    user.totp_last_step = -1;
    user.recovery = [];
    return null;
  });

  // bootstrap and settings
  route('GET', '/api/bootstrap', ({ st }) => bootstrap(st, requireUser(st)));
  route('GET', '/api/settings', ({ st }) => ({ settings: loadSettings(st, requireUser(st).id) }));
  route('PATCH', '/api/settings', ({ st, body }) => {
    const user = requireUser(st);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'validation', 'Invalid input', { body: 'must be a JSON object' });
    const merged = parse(() => S.validate(S.Settings, S.deepMerge(loadSettings(st, user.id), body)));
    userData(st, user.id).settings = merged;
    return { settings: merged };
  });
  route('DELETE', '/api/settings', ({ st }) => {
    const user = requireUser(st);
    userData(st, user.id).settings = null;
    return { settings: S.defaultSettings() };
  });

  // services
  route('GET', '/api/services', ({ st }) => ({ services: userData(st, requireUser(st).id).services }));
  route('POST', '/api/services', ({ st, body }) => {
    const user = requireUser(st);
    const b = parse(() => S.validate(S.ServiceCreate, body));
    const list = userData(st, user.id).services;
    if (list.length >= S.MAX_SERVICES) throw new HttpError(409, 'limit_reached', `You can have at most ${S.MAX_SERVICES} of these`);
    const row = { id: uuid(), name: b.name, url: b.url, description: b.description, icon: b.icon, category: b.category, check: b.check, created_at: iso() };
    list.push(row);
    return { status: 201, body: { service: row } };
  });
  route('PATCH', '/api/services/{id}', ({ st, body, params }) => {
    const user = requireUser(st);
    const id = canonicalId(params.id);
    const b = parse(() => S.validatePatch(S.ServicePatch, body, ['category']));
    const row = findOwned(st, user.id, 'services', id);
    Object.assign(row, b);
    return { service: row };
  });
  route('DELETE', '/api/services/{id}', ({ st, params }) => {
    const user = requireUser(st);
    const id = canonicalId(params.id);
    const d = userData(st, user.id);
    findOwned(st, user.id, 'services', id);
    d.services = d.services.filter((/** @type {any} */ r) => r.id !== id);
    delete st.health[id];
    return null;
  });

  // bookmarks
  route('GET', '/api/bookmarks', ({ st }) => ({ bookmarks: userData(st, requireUser(st).id).bookmarks }));
  route('POST', '/api/bookmarks', ({ st, body }) => {
    const user = requireUser(st);
    const b = parse(() => S.validate(S.BookmarkCreate, body));
    const list = userData(st, user.id).bookmarks;
    if (list.length >= S.MAX_BOOKMARKS) throw new HttpError(409, 'limit_reached', `You can have at most ${S.MAX_BOOKMARKS} of these`);
    const row = { id: uuid(), name: b.name, url: b.url, color: b.color, created_at: iso() };
    list.push(row);
    return { status: 201, body: { bookmark: row } };
  });
  route('PATCH', '/api/bookmarks/{id}', ({ st, body, params }) => {
    const user = requireUser(st);
    const id = canonicalId(params.id);
    const b = parse(() => S.validatePatch(S.BookmarkPatch, body));
    const row = findOwned(st, user.id, 'bookmarks', id);
    Object.assign(row, b);
    return { bookmark: row };
  });
  route('DELETE', '/api/bookmarks/{id}', ({ st, params }) => {
    const user = requireUser(st);
    const id = canonicalId(params.id);
    const d = userData(st, user.id);
    findOwned(st, user.id, 'bookmarks', id);
    d.bookmarks = d.bookmarks.filter((/** @type {any} */ r) => r.id !== id);
    return null;
  });

  // status checks
  route('GET', '/api/status', ({ st }) => {
    const user = requireUser(st);
    /** @type {Record<string, any>} */
    const statuses = {};
    for (const s of userData(st, user.id).services) {
      if (!s.check) continue;
      let entry = serviceStatus(s, st.health[s.id] || 'up', now());
      if (user.role !== 'admin') entry = { ...entry, http_status: null, latency_ms: null };
      statuses[s.id] = entry;
    }
    // Discovered Docker services (keyed "docker:<name>"), for users who may see them.
    if (dockerVisible(st, user)) {
      for (const d of discover(dockerList(st)).services) {
        if (!d.check) continue;
        let entry = serviceStatus(d, dockerServiceHealth(d.container), now());
        if (user.role !== 'admin') entry = { ...entry, http_status: null, latency_ms: null };
        statuses[d.id] = entry;
      }
    }
    return { statuses };
  });

  // Docker discovery
  route('GET', '/api/docker', ({ st }) => {
    const user = requireUser(st);
    if (!dockerVisible(st, user)) return { enabled: false, available: false, error: null, services: [] };
    const found = discover(dockerList(st));
    /** @type {Record<string, any>} */
    const body = { enabled: true, available: true, error: null, services: found.services };
    if (user.role === 'admin') {
      body.skipped = found.skipped;
      body.warnings = found.warnings;
    }
    return body;
  });
  route('GET', '/api/admin/docker/suggestions', ({ st }) => {
    const user = requireAdmin(st);
    const suggestions = suggest(dockerList(st), {
      publicHost: DOCKER_PUBLIC_HOST,
      existingUrls: userData(st, user.id).services.map((/** @type {any} */ r) => r.url),
      excludeNames: [DOCKER_PROXY_HOST],
      excludeIdPrefix: DOCKER_SELF_ID_PREFIX,
    });
    return { available: true, error: null, suggestions };
  });

  // backup
  route('GET', '/api/backup', ({ st }) => {
    const data = bootstrap(st, requireUser(st));
    return {
      version: 1,
      exported_at: iso(),
      settings: data.settings,
      services: data.services.map((/** @type {any} */ r) => ({ name: r.name, url: r.url, description: r.description, icon: r.icon, category: r.category, check: r.check })),
      bookmarks: data.bookmarks.map((/** @type {any} */ r) => ({ name: r.name, url: r.url, color: r.color })),
    };
  });
  route('POST', '/api/backup', ({ st, body }) => {
    const user = requireUser(st);
    const doc = parse(() => S.validate(S.BackupDoc, body));
    let settings;
    try {
      settings = S.validate(S.Settings, S.deepMerge(S.defaultSettings(), doc.settings));
    } catch (e) {
      if (!(e instanceof S.ValidationError)) throw e;
      throw new HttpError(400, 'validation', 'Invalid input', Object.fromEntries(Object.entries(e.fields).map(([k, v]) => ['settings.' + k, v])));
    }
    const d = userData(st, user.id);
    for (const s of d.services) delete st.health[s.id];
    d.settings = settings;
    d.services = doc.services.map((/** @type {any} */ s) => ({ id: uuid(), name: s.name, url: s.url, description: s.description, icon: s.icon, category: s.category, check: s.check, created_at: iso() }));
    d.bookmarks = doc.bookmarks.map((/** @type {any} */ b) => ({ id: uuid(), name: b.name, url: b.url, color: b.color, created_at: iso() }));
    return bootstrap(st, user);
  });

  // beszel
  route('GET', '/api/beszel/instances', ({ st }) => ({ instances: userData(st, requireUser(st).id).beszel.map(beszelOut) }));
  route('POST', '/api/beszel/instances', ({ st, body }) => {
    const user = requireUser(st);
    const b = parse(() => S.validate(S.BeszelCreate, body));
    const list = userData(st, user.id).beszel;
    if (list.length >= S.MAX_BESZEL) throw new HttpError(409, 'limit_reached', `You can have at most ${S.MAX_BESZEL} of these`);
    const url = b.url.replace(/\/+$/, '');
    const inst = { id: uuid(), name: b.name || defaultBeszelName(b.url), url, username: b.username, password: b.password };
    list.push(inst);
    st.beszelSystems[inst.id] = systemsForNewHub(url);
    return { status: 201, body: { instance: beszelOut(inst) } };
  });
  route('PATCH', '/api/beszel/instances/{id}', ({ st, body, params }) => {
    const user = requireUser(st);
    const id = canonicalId(params.id);
    const b = parse(() => S.validatePatch(S.BeszelPatch, body));
    const inst = findOwned(st, user.id, 'beszel', id);
    if ('url' in b) b.url = b.url.replace(/\/+$/, '');
    if (b.name === '') b.name = defaultBeszelName(b.url || inst.url);
    Object.assign(inst, b);
    return { instance: beszelOut(inst) };
  });
  route('DELETE', '/api/beszel/instances/{id}', ({ st, params }) => {
    const user = requireUser(st);
    const id = canonicalId(params.id);
    const d = userData(st, user.id);
    findOwned(st, user.id, 'beszel', id);
    d.beszel = d.beszel.filter((/** @type {any} */ r) => r.id !== id);
    delete st.beszelSystems[id];
    return null;
  });
  route('POST', '/api/beszel/test', ({ st, body }) => {
    const user = requireUser(st);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'validation', 'Invalid input', { body: 'must be a JSON object' });
    /** @type {{ username: string, password: string }} */
    let target;
    if ('instance_id' in body) {
      const b = parse(() => S.validate(S.BeszelTestStored, body));
      target = findOwned(st, user.id, 'beszel', canonicalId(b.instance_id));
    } else {
      target = /** @type {any} */ (parse(() => S.validate(S.BeszelTestAdhoc, body)));
    }
    const err = beszelLoginError(target);
    if (err) return { ok: false, name: null, error: user.role === 'admin' ? err : GENERIC_BESZEL_ERROR };
    return { ok: true, name: target.username, error: null };
  });
  route('GET', '/api/beszel/systems', ({ st }) => {
    const user = requireUser(st);
    const instances = userData(st, user.id).beszel.map((/** @type {any} */ inst) => {
      const err = beszelLoginError(inst);
      if (err) return { id: inst.id, name: inst.name, ok: false, error: user.role === 'admin' ? err : GENERIC_BESZEL_ERROR, systems: [] };
      const systems = (st.beszelSystems[inst.id] || []).map((/** @type {any} */ s) => systemNow(inst.id, s, now()));
      return { id: inst.id, name: inst.name, ok: true, error: null, systems };
    });
    return { instances };
  });

  // admin
  route('GET', '/api/admin/users', ({ st }) => {
    requireAdmin(st);
    return { users: st.users.map((/** @type {any} */ u) => userOut(u, true)) };
  });
  route('POST', '/api/admin/users', ({ st, body }) => {
    requireAdmin(st);
    const b = parse(() => S.validate(S.AdminUserCreate, body));
    const u = createUser(st, /** @type {any} */ (b), b.role);
    return { status: 201, body: { user: userOut(u) } };
  });
  route('PATCH', '/api/admin/users/{id}', ({ st, body, params }) => {
    requireAdmin(st);
    const id = canonicalId(params.id);
    const b = parse(() => S.validatePatch(S.AdminUserPatch, body));
    const u = st.users.find((/** @type {any} */ x) => x.id === id);
    if (!u) throw notFound();
    if (b.role !== undefined && b.role !== u.role) {
      if (u.role === 'admin' && adminCount(st) <= 1) throw new HttpError(409, 'last_admin', 'The last admin cannot be demoted');
      u.role = b.role;
    }
    if (b.password !== undefined && !u.fixed_password) u.password = b.password;
    if (b.disable_twofa) {
      u.totp_secret = null;
      u.totp_last_step = -1;
      u.recovery = [];
    }
    return { user: userOut(u) };
  });
  route('DELETE', '/api/admin/users/{id}', ({ st, params }) => {
    requireAdmin(st);
    const id = canonicalId(params.id);
    const u = st.users.find((/** @type {any} */ x) => x.id === id);
    if (!u) throw notFound();
    if (u.role === 'admin' && adminCount(st) <= 1) throw new HttpError(409, 'last_admin', 'The last admin cannot be removed');
    st.users = st.users.filter((/** @type {any} */ x) => x.id !== id);
    for (const s of userData(st, id).services) delete st.health[s.id];
    for (const i of userData(st, id).beszel) delete st.beszelSystems[i.id];
    delete st.data[id];
    if (st.session === id) st.session = null;
    return null;
  });
  route('GET', '/api/admin/config', ({ st }) => {
    requireAdmin(st);
    return readConfig(st);
  });
  // Partial update: every key is optional, but the body must set at least one.
  route('PUT', '/api/admin/config', ({ st, body }) => {
    requireAdmin(st);
    const b = parse(() => S.validatePatch(S.AdminConfigPatch, body));
    if (!Object.keys(b).length) throw new HttpError(400, 'validation', 'Invalid input', { body: 'must set at least one of: ' + S.ADMIN_CONFIG_KEYS.join(', ') });
    if ('registration_open' in b) st.registration_open = b.registration_open;
    if ('docker_visible_to_users' in b) st.docker.visible_to_users = b.docker_visible_to_users;
    return readConfig(st);
  });
  route('GET', '/api/stats', ({ st }) => {
    requireAdmin(st);
    return hostStats(now());
  });

  /**
   * Handles one API request. `path` is the API path ("/api/..."), with or without a query.
   * @param {string} method
   * @param {string} path
   * @param {string | null | undefined} rawBody
   * @returns {Promise<Reply>}
   */
  async function handle(method, path, rawBody) {
    method = method.toUpperCase();
    const pathname = path.split(/[?#]/)[0];
    const st = load();
    try {
      let body = {};
      if (method !== 'GET' && method !== 'HEAD' && rawBody && rawBody.trim()) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
        }
      }
      let pathMatched = false;
      for (const [m, re, fn] of routes) {
        const match = re.exec(pathname);
        if (!match) continue;
        pathMatched = true;
        if (m !== method) continue;
        const params = /** @type {Record<string, string>} */ ({ ...match.groups });
        const out = await fn({ st, body, params });
        save(st);
        if (out === null) return { status: 204 };
        if (out && typeof out === 'object' && 'status' in out && 'body' in out && Object.keys(out).length === 2) return out;
        return { status: 200, body: out };
      }
      if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      throw notFound();
    } catch (e) {
      // Failed requests can still change state (2FA attempts, sign-in counters).
      save(st);
      if (e instanceof HttpError) return { status: e.status, body: e.body() };
      return { status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } };
    }
  }

  /** Forgets every change: the next request starts from the seed again. */
  function reset() {
    storage.removeItem(key);
  }

  return { handle, reset, load, DEMO_USERNAME };
}
