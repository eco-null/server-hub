// @ts-check
/** Small, prototype-pollution-safe object helpers. */

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
export function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep clone of JSON-like data.
 * @template T
 * @param {T} v
 * @returns {T}
 */
export function clone(v) {
  if (Array.isArray(v)) return /** @type {any} */ (v.map(clone));
  if (isPlainObject(v)) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(v)) if (!FORBIDDEN.has(k)) out[k] = clone(v[k]);
    return /** @type {any} */ (out);
  }
  return v;
}

/**
 * Returns a new object: `over` merged onto `base`. Plain objects merge
 * recursively, arrays and scalars replace, `undefined` is skipped, and keys
 * that could pollute prototypes are ignored. Neither input is mutated.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} over
 * @returns {Record<string, any>}
 */
export function deepMerge(base, over) {
  const out = clone(isPlainObject(base) ? base : {});
  if (!isPlainObject(over)) return out;
  for (const k of Object.keys(over)) {
    if (FORBIDDEN.has(k)) continue;
    const v = over[k];
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}

/**
 * @param {Record<string, any>} obj
 * @param {Iterable<string>} keys
 */
export function pick(obj, keys) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of keys) if (Object.hasOwn(obj, k)) out[k] = obj[k];
  return out;
}
