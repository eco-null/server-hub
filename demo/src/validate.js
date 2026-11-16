// @ts-check
/**
 * A small port of the request schemas in serverhub/api/schemas.py.
 *
 * It mirrors the pydantic behaviour the web UI depends on: strict types (no
 * coercion), unknown keys rejected as "unknown field", missing required keys as
 * "required", the same field paths ("wallpaper.url") and, for the rules the UI
 * shows to people, the same messages.
 */

export const KNOWN_ICONS = new Set([
  'chart', 'pulse', 'database', 'shield', 'shield-check', 'key', 'lock',
  'lock-key', 'cloud', 'note', 'file', 'film', 'music', 'headphones', 'git',
  'branch', 'terminal', 'globe', 'home', 'broadcast', 'cog', 'box',
  'shopping', 'flask', 'sparkles', 'camera', 'image', 'book', 'gamepad',
  'wallet', 'map-pin', 'activity', 'cpu', 'server', 'wifi', 'zap', 'mail',
  'message', 'calendar', 'clock', 'download', 'upload', 'sliders', 'user',
  'users', 'bookmark', 'star', 'heart', 'link', 'external-link', 'folder',
  'archive', 'package', 'layers', 'refresh', 'bell', 'bug', 'code', 'command',
]);

export const KNOWN_CATEGORIES = new Set([
  'Monitoring', 'Security', 'Network', 'Media', 'Productivity', 'Files',
  'Dev', 'Communication', 'Home', 'Finance', 'AI', 'Search', 'Database',
  'Other', 'Gaming', 'Books', 'Money', 'Travel', 'Health',
]);

export const MAX_SERVICES = 500;
export const MAX_BOOKMARKS = 500;
export const MAX_BESZEL = 20;

/** Thrown by validators; `fields` maps a dotted path to its problem. */
export class ValidationError extends Error {
  /** @param {Record<string, string>} fields */
  constructor(fields) {
    super('Invalid input');
    this.fields = fields;
  }
}

/** Raised inside an after-validator; becomes the field's message. */
class ValueErr extends Error {}

// ---------- after-validators (same rules and texts as the backend) ----------

/** Unicode categories the backend refuses in URLs: whitespace, Cc, Cf, Cs, Co, Cn, Zl, Zp. */
const BAD_CHAR = /[\s\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/** Mirrors fetcher.check_url_syntax. @param {string} url */
export function urlSyntaxOk(url) {
  if (!url || url.length > 2000 || BAD_CHAR.test(url)) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  // urlsplit takes the host from the text between "//" and the next / ? #; WHATWG URL skips
  // extra slashes instead ("https:///path" gets the host "path"), so check the raw text.
  const hostPort = /** @type {RegExpExecArray} */ (/^https?:\/\/([^/?#]*)/i.exec(url))[1].replace(/^.*@/, '');
  if (!hostPort.startsWith('[') && !hostPort.split(':')[0]) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.hostname || u.port === '0') return false;
  return true;
}

/** @param {string} v */
export function httpUrl(v) {
  v = v.trim();
  if (/\s/.test(v)) throw new ValueErr('must not contain spaces');
  if (!urlSyntaxOk(v)) throw new ValueErr('must be a valid http(s) URL');
  return v;
}

/** A service URL: an http(s) URL without user info (the server never sends credentials when checking). @param {string} v */
export function serviceUrl(v) {
  v = httpUrl(v);
  if (/^[a-z]+:\/\/[^/?#]*@/i.test(v)) throw new ValueErr('must not contain credentials (user:password@)');
  return v;
}

/** @param {string} v */
function beszelUrl(v) {
  v = httpUrl(v);
  const u = new URL(v);
  // urlsplit keeps the path as typed; WHATWG URL already resolves dot segments, so check the raw text.
  const rest = v.replace(/^[a-z]+:\/\/[^/?#]*/i, '');
  const rawPath = rest.split(/[?#]/)[0];
  if (v.includes('?') || v.includes('#') || u.username || u.password || /^[a-z]+:\/\/[^/?#]*@/i.test(v)) {
    throw new ValueErr('must not contain a query, fragment or credentials');
  }
  if (!/^[A-Za-z0-9._~/-]*$/.test(rawPath) || rawPath.split('/').some((seg) => seg === '.' || seg === '..')) {
    throw new ValueErr('path may only contain letters, digits and . _ ~ - /');
  }
  return v;
}

/** @param {string} v */
function optionalHttpUrl(v) {
  return v.trim() ? httpUrl(v) : '';
}

/** @param {string} v */
function imageUrl(v) {
  v = v.trim();
  if (!v) return '';
  if (v.startsWith('/static/') && !/\s/.test(v) && !v.includes('..')) return v;
  httpUrl(v);
  if (!v.toLowerCase().startsWith('https://')) throw new ValueErr('must be an https:// URL');
  return v;
}

/** @param {string} v */
function icon(v) {
  if (!KNOWN_ICONS.has(v)) throw new ValueErr('unknown icon id');
  return v;
}

/** @param {string | null} v */
function category(v) {
  if (v !== null && !KNOWN_CATEGORIES.has(v)) throw new ValueErr('unknown category id');
  return v;
}

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/;
/** @param {string} v */
function email(v) {
  v = v.trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) throw new ValueErr('must be a valid email address');
  return v;
}

// ---------- field specs ----------

/**
 * @typedef {{
 *   t: 'str' | 'bool' | 'literal' | 'model' | 'list' | 'dict' | 'any',
 *   required?: boolean, def?: any, nullable?: boolean,
 *   strip?: boolean, min?: number, max?: number, pattern?: string,
 *   values?: any[], after?: (v: any) => any, afterNull?: boolean,
 *   model?: Model, items?: Field, maxItems?: number,
 * }} Field
 * @typedef {{ name: string, fields: Record<string, Field>, extra?: 'forbid' | 'ignore' }} Model
 */

/** @param {any} v */
const repr = (v) => (typeof v === 'string' ? `'${v}'` : v === true ? 'True' : v === false ? 'False' : String(v));

/** @param {any[]} values */
function literalMsg(values) {
  const parts = values.map(repr);
  return 'Input should be ' + (parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' or ' + parts[parts.length - 1]);
}

/** @param {any} v */
const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {Field} f
 * @param {any} v
 * @param {string} loc
 * @param {Record<string, string>} errors
 */
function checkField(f, v, loc, errors) {
  const fail = (/** @type {string} */ msg) => {
    if (!(loc in errors)) errors[loc] = msg;
    return undefined;
  };
  if (v === null) {
    if (f.nullable) return f.after && f.afterNull ? runAfter(f, v, fail) : null;
    if (f.t !== 'any') return fail(nullMsg(f));
  }
  switch (f.t) {
    case 'any':
      return v;
    case 'bool':
      return typeof v === 'boolean' ? v : fail('Input should be a valid boolean');
    case 'literal':
      return f.values && f.values.some((x) => x === v) ? v : fail(literalMsg(f.values || []));
    case 'dict':
      return isDict(v) ? v : fail('Input should be a valid dictionary');
    case 'model': {
      if (!isDict(v)) return fail(`Input should be a valid dictionary or instance of ${f.model?.name}`);
      return validateInto(/** @type {Model} */ (f.model), v, loc + '.', errors);
    }
    case 'list': {
      if (!Array.isArray(v)) return fail('Input should be a valid list');
      if (f.maxItems !== undefined && v.length > f.maxItems) return fail(`List should have at most ${f.maxItems} items after validation, not ${v.length}`);
      return v.map((item, i) => checkField(/** @type {Field} */ (f.items), item, `${loc}.${i}`, errors));
    }
    case 'str': {
      if (typeof v !== 'string') return fail('Input should be a valid string');
      let s = f.strip ? v.trim() : v;
      if (f.min !== undefined && s.length < f.min) return fail(`String should have at least ${f.min} character${f.min === 1 ? '' : 's'}`);
      if (f.max !== undefined && s.length > f.max) return fail(`String should have at most ${f.max} character${f.max === 1 ? '' : 's'}`);
      if (f.pattern !== undefined && !new RegExp(f.pattern, 'u').test(s)) return fail(`String should match pattern '${f.pattern}'`);
      return f.after ? runAfter(f, s, fail) : s;
    }
  }
  return v;
}

/** @param {Field} f */
function nullMsg(f) {
  if (f.t === 'str') return 'Input should be a valid string';
  if (f.t === 'bool') return 'Input should be a valid boolean';
  if (f.t === 'literal') return literalMsg(f.values || []);
  if (f.t === 'list') return 'Input should be a valid list';
  if (f.t === 'model') return `Input should be a valid dictionary or instance of ${f.model?.name}`;
  return 'Input should be a valid dictionary';
}

/**
 * @param {Field} f
 * @param {any} v
 * @param {(m: string) => undefined} fail
 */
function runAfter(f, v, fail) {
  try {
    return /** @type {(v: any) => any} */ (f.after)(v);
  } catch (e) {
    if (e instanceof ValueErr) return fail(e.message);
    throw e;
  }
}

/**
 * @param {Model} model
 * @param {Record<string, any>} data
 * @param {string} prefix
 * @param {Record<string, string>} errors
 */
function validateInto(model, data, prefix, errors) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, f] of Object.entries(model.fields)) {
    if (Object.hasOwn(data, name)) {
      out[name] = checkField(f, data[name], prefix + name, errors);
    } else if (f.required) {
      if (!(prefix + name in errors)) errors[prefix + name] = 'required';
    } else if (f.def !== undefined) {
      out[name] = typeof f.def === 'function' ? f.def() : structuredClone(f.def);
    }
  }
  if (model.extra !== 'ignore') {
    for (const k of Object.keys(data)) {
      if (!Object.hasOwn(model.fields, k) && !(prefix + k in errors)) errors[prefix + k] = 'unknown field';
    }
  }
  return out;
}

/**
 * Validates `data` against `model`; returns the cleaned object (defaults filled in).
 * Patch models only return the keys that were sent (like `exclude_unset`).
 * @param {Model} model
 * @param {unknown} data
 * @returns {Record<string, any>}
 */
export function validate(model, data) {
  if (!isDict(data)) throw new ValidationError({ body: 'must be a JSON object' });
  /** @type {Record<string, string>} */
  const errors = {};
  const out = validateInto(model, /** @type {Record<string, any>} */ (data), '', errors);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

/**
 * Patch models: like `validate`, but fields that were sent as null (and are
 * not nullable in the database) are rejected as "must not be null".
 * @param {Model} model
 * @param {unknown} data
 * @param {string[]} [nullable]
 */
export function validatePatch(model, data, nullable = []) {
  const out = validate(model, data);
  /** @type {Record<string, string>} */
  const bad = {};
  for (const [k, v] of Object.entries(out)) if (v === null && !nullable.includes(k)) bad[k] = 'must not be null';
  if (Object.keys(bad).length) throw new ValidationError(bad);
  return out;
}

// ---------- models ----------

/** @param {Record<string, Field>} fields @returns {Record<string, Field>} */
const optional = (fields) => Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { ...f, required: false, def: undefined, nullable: true }]));

const URL_FIELD = /** @type {Field} */ ({ t: 'str', max: 2000, after: httpUrl, required: true });
const SERVICE_URL_FIELD = /** @type {Field} */ ({ t: 'str', max: 2000, after: serviceUrl, required: true });
const COLOR = /** @type {Field} */ ({ t: 'str', pattern: '^#[0-9a-fA-F]{6}$' });
const NAME = /** @type {Field} */ ({ t: 'str', strip: true, min: 1, max: 200, required: true });

/** @type {Model} */
export const Wallpaper = {
  name: 'Wallpaper',
  fields: {
    mode: { t: 'literal', values: ['none', 'gradient', 'image'], def: 'none' },
    gradient: { t: 'str', pattern: '^[a-z0-9-]{0,40}$', def: 'default' },
    url: { t: 'str', max: 2000, after: imageUrl, def: '' },
    showGrid: { t: 'bool', def: false },
  },
};

/** @type {Model} */
export const Features = {
  name: 'Features',
  fields: {
    clock: { t: 'bool', def: true },
    greeting: { t: 'bool', def: true },
    stats: { t: 'bool', def: true },
    search: { t: 'bool', def: true },
    statusChecks: { t: 'bool', def: true },
  },
};

/** @type {Model} */
export const Search = {
  name: 'Search',
  fields: {
    provider: { t: 'literal', values: ['google', 'duckduckgo', 'bing', 'startpage', 'searxng'], def: 'duckduckgo' },
    searxngUrl: { t: 'str', max: 2000, after: optionalHttpUrl, def: '' },
  },
};

/** @type {Model} */
export const Settings = {
  name: 'Settings',
  fields: {
    theme: { t: 'literal', values: ['auto', 'light', 'dark'], def: 'dark' },
    accent: { ...COLOR, def: '#5E6AD2' },
    userName: { t: 'str', max: 100, def: '' },
    pageTitle: { t: 'str', max: 100, def: '' },
    subtitle: { t: 'str', max: 200, def: '' },
    defaultDomain: { t: 'str', pattern: '^[A-Za-z0-9.:-]{0,253}$', def: '' },
    wallpaper: { t: 'model', model: Wallpaper, def: () => validate(Wallpaper, {}) },
    features: { t: 'model', model: Features, def: () => validate(Features, {}) },
    search: { t: 'model', model: Search, def: () => validate(Search, {}) },
  },
};

/** @returns {Record<string, any>} */
export const defaultSettings = () => validate(Settings, {});

/**
 * @param {Record<string, any>} base
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
export function deepMerge(base, patch) {
  /** @type {Record<string, any>} */
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isDict(v) && isDict(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

const SERVICE_FIELDS = /** @type {Record<string, Field>} */ ({
  name: NAME,
  url: SERVICE_URL_FIELD,
  description: { t: 'str', strip: true, max: 500, def: '' },
  icon: { t: 'str', after: icon, def: 'box' },
  category: { t: 'str', nullable: true, afterNull: true, after: category, def: null },
  check: { t: 'bool', def: true },
});

/** @type {Model} */
export const ServiceCreate = { name: 'ServiceCreate', fields: SERVICE_FIELDS };
/** @type {Model} */
export const ServicePatch = { name: 'ServicePatch', fields: optional(SERVICE_FIELDS) };

const BOOKMARK_FIELDS = /** @type {Record<string, Field>} */ ({
  name: NAME,
  url: URL_FIELD,
  color: { ...COLOR, def: '#5E6AD2' },
});
/** @type {Model} */
export const BookmarkCreate = { name: 'BookmarkCreate', fields: BOOKMARK_FIELDS };
/** @type {Model} */
export const BookmarkPatch = { name: 'BookmarkPatch', fields: optional(BOOKMARK_FIELDS) };

const BESZEL_USER = /** @type {Field} */ ({ t: 'str', strip: true, min: 1, max: 254, required: true });
const BESZEL_PASSWORD = /** @type {Field} */ ({ t: 'str', min: 1, max: 1024, required: true });
const BESZEL_URL = /** @type {Field} */ ({ t: 'str', max: 2000, after: beszelUrl, required: true });

/** @type {Model} */
export const BeszelCreate = {
  name: 'BeszelCreate',
  fields: { name: { t: 'str', strip: true, max: 200, def: '' }, url: BESZEL_URL, username: BESZEL_USER, password: BESZEL_PASSWORD },
};
/** @type {Model} */
export const BeszelPatch = { name: 'BeszelPatch', fields: optional(BeszelCreate.fields) };
/** @type {Model} */
export const BeszelTestAdhoc = { name: 'BeszelTestAdhoc', fields: { url: BESZEL_URL, username: BESZEL_USER, password: BESZEL_PASSWORD } };
/** @type {Model} */
export const BeszelTestStored = { name: 'BeszelTestStored', fields: { instance_id: { t: 'str', max: 64, required: true } } };

const EMAIL = /** @type {Field} */ ({ t: 'str', after: email, required: true });
const USERNAME = /** @type {Field} */ ({ t: 'str', pattern: '^[a-zA-Z0-9_]{3,20}$', required: true });
const NEW_PASSWORD = /** @type {Field} */ ({ t: 'str', min: 10, max: 128, required: true });
const ANY_PASSWORD = /** @type {Field} */ ({ t: 'str', max: 1024, required: true });
const CODE = /** @type {Field} */ ({ t: 'str', strip: true, min: 1, max: 64, required: true });

/** @type {Model} */
export const SignupIn = { name: 'SignupIn', fields: { email: EMAIL, username: USERNAME, password: NEW_PASSWORD } };
/** @type {Model} */
export const SetupIn = { name: 'SetupIn', fields: { ...SignupIn.fields, setup_token: { t: 'str', max: 512, required: true } } };
/** @type {Model} */
export const LoginIn = { name: 'LoginIn', fields: { identifier: { t: 'str', strip: true, max: 254, required: true }, password: ANY_PASSWORD } };
/** @type {Model} */
export const CodeIn = { name: 'CodeIn', fields: { code: CODE } };
/** @type {Model} */
export const TwofaSetupIn = { name: 'TwofaSetupIn', fields: { current_password: ANY_PASSWORD } };
/** @type {Model} */
export const TwofaDisableIn = { name: 'TwofaDisableIn', fields: { current_password: ANY_PASSWORD, code: CODE } };
/** @type {Model} */
export const PasswordChangeIn = { name: 'PasswordChangeIn', fields: { current_password: ANY_PASSWORD, new_password: NEW_PASSWORD } };
/** @type {Model} */
export const AdminUserCreate = {
  name: 'AdminUserCreate',
  fields: { email: EMAIL, username: USERNAME, password: NEW_PASSWORD, role: { t: 'literal', values: ['admin', 'user'], def: 'user' } },
};
/** @type {Model} */
export const AdminUserPatch = {
  name: 'AdminUserPatch',
  fields: {
    role: { t: 'literal', values: ['admin', 'user'], nullable: true },
    password: { ...NEW_PASSWORD, required: false, nullable: true },
    disable_twofa: { t: 'literal', values: [true], nullable: true },
  },
};
/** @type {Model} */
export const AdminConfigPatch = {
  name: 'AdminConfigPatch',
  fields: { registration_open: { t: 'bool', nullable: true }, docker_visible_to_users: { t: 'bool', nullable: true } },
};
/** The keys of the admin config, in the order the API reports them. */
export const ADMIN_CONFIG_KEYS = ['registration_open', 'docker_visible_to_users'];

/** @type {Model} */
// Backups made before service URLs refused user info must still restore.
const BackupService = { name: 'BackupService', fields: { ...SERVICE_FIELDS, url: URL_FIELD }, extra: 'ignore' };
/** @type {Model} */
const BackupBookmark = { name: 'BackupBookmark', fields: BOOKMARK_FIELDS, extra: 'ignore' };
/** @type {Model} */
export const BackupDoc = {
  name: 'BackupDoc',
  fields: {
    version: { t: 'literal', values: [1], required: true },
    exported_at: { t: 'str', nullable: true, def: null },
    settings: { t: 'dict', def: () => ({}) },
    services: { t: 'list', items: { t: 'model', model: BackupService }, maxItems: MAX_SERVICES, def: () => [] },
    bookmarks: { t: 'list', items: { t: 'model', model: BackupBookmark }, maxItems: MAX_BOOKMARKS, def: () => [] },
  },
};
