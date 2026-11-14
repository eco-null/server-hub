// @ts-check
/**
 * Optimistic first paint: the last bootstrap payload is cached per user id and
 * rendered immediately, then replaced by the fresh response.
 */

import { KEY_PREFIX, readJson, writeJson, storage } from './storage.js';

const LAST_USER_KEY = KEY_PREFIX + 'last-user';
const bootKey = (/** @type {string} */ uid) => KEY_PREFIX + 'boot:' + uid;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * @typedef {import('./types.js').Bootstrap} Bootstrap
 */

/**
 * @param {import('./storage.js').KV} [kv]
 * @param {() => number} [now]
 */
export function createBootCache(kv = storage, now = Date.now) {
  return {
    /** @returns {Bootstrap | null} cached payload for the last signed-in user */
    read() {
      const uid = kv.getItem(LAST_USER_KEY);
      if (!uid) return null;
      const entry = readJson(kv, bootKey(uid));
      if (!entry || typeof entry.t !== 'number' || !entry.data || !entry.data.user) return null;
      if (entry.data.user.id !== uid || now() - entry.t > MAX_AGE_MS) return null;
      return entry.data;
    },
    /** @param {Bootstrap} data */
    write(data) {
      if (!data || !data.user || typeof data.user.id !== 'string') return;
      const prev = kv.getItem(LAST_USER_KEY);
      if (prev && prev !== data.user.id) kv.removeItem(bootKey(prev));
      kv.setItem(LAST_USER_KEY, data.user.id);
      writeJson(kv, bootKey(data.user.id), { t: now(), data });
    },
  };
}

export const bootCache = createBootCache();
