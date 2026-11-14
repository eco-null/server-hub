// @ts-check
/**
 * Browser storage that never throws. Falls back to memory when localStorage
 * is unavailable (private mode, blocked site data, opaque origins).
 */

export const KEY_PREFIX = 'serverhub:';
/** Device-level look-and-feel (theme + accent). Survives logout so the login page matches. */
export const UI_KEY = KEY_PREFIX + 'ui';

/**
 * @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void, keys(): string[] }} KV
 */

/** @returns {KV} */
export function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? /** @type {string} */ (m.get(k)) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

/** @returns {KV} */
function localKv() {
  try {
    if (typeof document === 'undefined') return memoryStorage();
    const ls = globalThis.localStorage;
    const probe = KEY_PREFIX + 'probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      getItem: (k) => ls.getItem(k),
      setItem: (k, v) => ls.setItem(k, v),
      removeItem: (k) => ls.removeItem(k),
      keys: () => Array.from({ length: ls.length }, (_, i) => ls.key(i)).filter((k) => typeof k === 'string'),
    };
  } catch {
    return memoryStorage();
  }
}

/** @type {KV} */
export const storage = localKv();

/**
 * @param {KV} kv
 * @param {string} key
 * @returns {any}
 */
export function readJson(kv, key) {
  try {
    const raw = kv.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {KV} kv
 * @param {string} key
 * @param {unknown} value
 */
export function writeJson(kv, key, value) {
  try {
    kv.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or blocked: the cache is optional */
  }
}

/**
 * Removes every cached item that belongs to a user (everything under our
 * prefix except the device-level UI preference).
 * @param {KV} [kv]
 */
export function clearUserData(kv = storage) {
  for (const k of kv.keys()) {
    if (k.startsWith(KEY_PREFIX) && k !== UI_KEY) {
      try {
        kv.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  }
}
