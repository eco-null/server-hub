// @ts-check

/**
 * A tiny observable state container.
 * @template {Record<string, any>} S
 * @param {S} initial
 */
export function createState(initial) {
  let value = initial;
  /** @type {Set<(s: S, prev: S) => void>} */
  const subs = new Set();
  return {
    /** @returns {S} */
    get: () => value,
    /** Shallow-merges a patch and notifies subscribers. @param {Partial<S>} patch */
    set(patch) {
      const prev = value;
      value = { ...value, ...patch };
      for (const fn of subs) fn(value, prev);
    },
    /** @param {(s: S, prev: S) => void} fn */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
