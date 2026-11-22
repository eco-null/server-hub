// @ts-check
/**
 * Pure helpers for the optional grid dashboard (see features/board.js).
 * A tile is one service category group ("group:Media") or a widget.
 */

/** @typedef {'s' | 'm' | 'l'} TileSize */
/** @typedef {{ id: string, size: TileSize, hidden: boolean }} Tile */
/** @typedef {{ enabled: boolean, items: Tile[] }} Layout */

/** @type {Readonly<Layout>} */
export const DEFAULT_LAYOUT = Object.freeze({ enabled: false, items: /** @type {Tile[]} */ ([]) });

/** @type {readonly TileSize[]} */
export const SIZES = Object.freeze(['s', 'm', 'l']);

/** @param {string} category */
export const groupTileId = (category) => 'group:' + category;

/**
 * Fills in anything the server left out and drops malformed tiles.
 * @param {unknown} raw
 * @returns {Layout}
 */
export function normalizeLayout(raw) {
  const r = /** @type {any} */ (raw && typeof raw === 'object' ? raw : {});
  const seen = new Set();
  /** @type {Tile[]} */
  const items = [];
  for (const t of Array.isArray(r.items) ? r.items : []) {
    if (!t || typeof t.id !== 'string' || seen.has(t.id)) continue;
    seen.add(t.id);
    items.push({ id: t.id, size: SIZES.includes(t.size) ? t.size : 's', hidden: t.hidden === true });
  }
  return { enabled: r.enabled === true, items };
}

/**
 * The tiles to show, in order: the arranged ones that exist right now, then any
 * other available tile in its default place and size.
 * @param {readonly Tile[]} stored
 * @param {ReadonlyArray<{ id: string, size: TileSize }>} available default order and sizes
 * @returns {Tile[]}
 */
export function resolveTiles(stored, available) {
  const ids = new Set(available.map((a) => a.id));
  const out = stored.filter((t) => ids.has(t.id)).map((t) => ({ ...t }));
  const placed = new Set(out.map((t) => t.id));
  for (const a of available) if (!placed.has(a.id)) out.push({ id: a.id, size: a.size, hidden: false });
  return out;
}

/**
 * What to save after an edit of `shown`: the shown tiles in their new order,
 * then stored tiles that are not available right now (an empty category, or
 * stats for a user who cannot see them), so they keep their size and visibility.
 * @param {readonly Tile[]} shown
 * @param {readonly Tile[]} stored
 * @returns {Tile[]}
 */
export function tilesToSave(shown, stored) {
  const ids = new Set(shown.map((t) => t.id));
  return [...shown.map((t) => ({ ...t })), ...stored.filter((t) => !ids.has(t.id)).map((t) => ({ ...t }))];
}

/**
 * Moves tile `id` to position `to` (clamped).
 * @param {readonly Tile[]} tiles
 * @param {string} id
 * @param {number} to
 * @returns {Tile[]}
 */
export function moveTile(tiles, id, to) {
  const from = tiles.findIndex((t) => t.id === id);
  if (from < 0) return [...tiles];
  const out = [...tiles];
  const [tile] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, Math.round(to))), 0, tile);
  return out;
}

/**
 * @param {readonly Tile[]} tiles
 * @param {string} id
 * @param {Partial<Pick<Tile, 'size' | 'hidden'>>} patch
 * @returns {Tile[]}
 */
export function updateTile(tiles, id, patch) {
  return tiles.map((t) => (t.id === id ? { ...t, ...patch } : t));
}
