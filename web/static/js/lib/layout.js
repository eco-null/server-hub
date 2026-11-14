// @ts-check
/** Pure layout helpers for the services grid. */

/**
 * Number of equal columns for `count` items when at most `max` columns fit.
 * Picks the largest column count that avoids a lone item in the last row
 * (4 items with room for 3 columns give 2 x 2, not 3 + 1) and then leaves the
 * fewest empty cells. When everything fits in one row it uses one row.
 * @param {number} count
 * @param {number} max
 * @returns {number}
 */
export function balancedColumns(count, max) {
  const m = Math.max(1, Math.floor(max) || 1);
  const n = Math.max(0, Math.floor(count) || 0);
  if (n <= m) return Math.max(1, n);
  let best = 1;
  let bestOrphan = Infinity;
  let bestEmpty = Infinity;
  for (let c = m; c >= 2; c--) {
    const last = n % c || c;
    const orphan = last === 1 ? 1 : 0;
    const empty = (c - last) % c;
    if (orphan < bestOrphan || (orphan === bestOrphan && empty < bestEmpty)) {
      best = c;
      bestOrphan = orphan;
      bestEmpty = empty;
    }
  }
  return best;
}

/**
 * How many columns of at least `minWidth` (with `gap` between) fit in `width`.
 * @param {number} width
 * @param {number} minWidth
 * @param {number} gap
 * @returns {number}
 */
export function columnsFor(width, minWidth, gap) {
  if (!(width > 0) || !(minWidth > 0)) return 1;
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}
