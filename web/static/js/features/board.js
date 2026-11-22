// @ts-check
/**
 * The optional grid dashboard: service groups and widgets as tiles the user
 * orders, sizes and hides. Tiles wrap the existing elements (moved, never
 * copied), so widgets keep their listeners and state.
 *
 * Moving works with the pointer (drag the handle) and the keyboard (focus the
 * handle, then arrow keys, Home or End); each move is announced.
 */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { SIZES, moveTile, updateTile } from '../lib/grid.js';

/** @typedef {import('../lib/grid.js').Tile} Tile */

const SIZE_NAME = { s: 'Small', m: 'Medium', l: 'Large' };

/**
 * @param {{
 *   root: HTMLElement,
 *   live: HTMLElement,
 *   hintId: string,
 *   titleOf: (id: string) => string,
 *   onChange: (tiles: Tile[]) => void,
 * }} o
 */
export function createBoard({ root, live, hintId, titleOf, onChange }) {
  /** @type {Tile[]} */
  let tiles = [];
  /** @type {Map<string, HTMLElement>} */
  let elements = new Map();
  let editing = false;
  /** @type {Map<string, { wrap: HTMLElement, body: HTMLElement, handle: HTMLButtonElement, sizes: HTMLButtonElement[], hide: HTMLButtonElement }>} */
  const views = new Map();

  const announce = (/** @type {string} */ msg) => {
    live.textContent = msg;
  };
  const indexOf = (/** @type {string} */ id) => tiles.findIndex((t) => t.id === id);

  /** Applies an edit, repaints and reports it. @param {Tile[]} next */
  function commit(next) {
    paint(next);
    onChange(tiles);
  }

  /** @param {string} id */
  function view(id) {
    const existing = views.get(id);
    if (existing) return existing;
    const title = titleOf(id);
    const handle = /** @type {HTMLButtonElement} */ (
      h('button', { type: 'button', class: 'tile-handle', 'aria-label': `Move ${title}`, 'aria-describedby': hintId, title: 'Drag to move' }, icon('ui-grip'))
    );
    const sizes = SIZES.map(
      (size) =>
        /** @type {HTMLButtonElement} */ (
          h('button', { type: 'button', class: 'tile-size', 'aria-label': SIZE_NAME[size], title: SIZE_NAME[size], onclick: () => commit(updateTile(tiles, id, { size })) }, size.toUpperCase())
        ),
    );
    const hide = /** @type {HTMLButtonElement} */ (
      h('button', {
        type: 'button',
        class: 'btn btn-sm btn-ghost tile-hide',
        onclick: () => {
          const hidden = !tiles[indexOf(id)]?.hidden;
          commit(updateTile(tiles, id, { hidden }));
          announce(`${title} ${hidden ? 'hidden' : 'shown'}.`);
        },
      })
    );
    const body = h('div', { class: 'tile-body' });
    const wrap = h(
      'div',
      { class: 'tile', dataset: { tile: id } },
      h('div', { class: 'tile-bar' }, handle, h('div', { class: 'tile-sizes', role: 'group', 'aria-label': `Size of ${title}` }, sizes), hide),
      body,
    );

    handle.addEventListener('keydown', (e) => {
      const from = indexOf(id);
      const to =
        e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? from - 1
        : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? from + 1
        : e.key === 'Home' ? 0
        : e.key === 'End' ? tiles.length - 1
        : null;
      if (to === null) return;
      e.preventDefault();
      if (to < 0 || to >= tiles.length || to === from) return;
      commit(moveTile(tiles, id, to));
      handle.focus(); // moving the node in the DOM drops the focus
      announce(`${title}: position ${to + 1} of ${tiles.length}.`);
    });

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !editing) return;
      e.preventDefault();
      handle.focus();
      const before = tiles.map((t) => t.id).join();
      /** The tile last swapped with; ignored until the pointer leaves it, so tiles of different sizes do not flip back and forth. */
      /** @type {Element | null} */
      let last = null;
      wrap.classList.add('is-dragging');
      const move = (/** @type {PointerEvent} */ ev) => {
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tile') || null;
        if (over === last) return;
        last = null;
        if (!(over instanceof HTMLElement) || over === wrap || !root.contains(over)) return;
        const to = indexOf(over.dataset.tile || '');
        if (to < 0) return;
        paint(moveTile(tiles, id, to));
        last = over;
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        wrap.classList.remove('is-dragging');
        handle.focus();
        if (tiles.map((t) => t.id).join() !== before) {
          onChange(tiles);
          announce(`${title}: position ${indexOf(id) + 1} of ${tiles.length}.`);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });

    const v = { wrap, body, handle, sizes, hide };
    views.set(id, v);
    return v;
  }

  /** Puts the tiles in order with their size and visibility, moving only nodes that are out of place. @param {Tile[]} next */
  function paint(next) {
    tiles = next.filter((t) => elements.has(t.id));
    /** @type {HTMLElement[]} */
    const nodes = [];
    for (const t of tiles) {
      const v = view(t.id);
      const el = /** @type {HTMLElement} */ (elements.get(t.id));
      if (v.body.firstElementChild !== el || v.body.childElementCount !== 1) v.body.replaceChildren(el);
      v.wrap.className = `tile tile-${t.size}` + (t.hidden ? ' tile-hidden' : '') + (v.wrap.classList.contains('is-dragging') ? ' is-dragging' : '');
      v.wrap.hidden = t.hidden && !editing;
      v.sizes.forEach((b, i) => b.setAttribute('aria-pressed', String(SIZES[i] === t.size)));
      v.hide.textContent = t.hidden ? 'Show' : 'Hide';
      v.hide.setAttribute('aria-label', `${t.hidden ? 'Show' : 'Hide'} ${titleOf(t.id)}`);
      nodes.push(v.wrap);
    }
    let ref = root.firstChild;
    for (const node of nodes) {
      if (node === ref) ref = ref.nextSibling;
      else root.insertBefore(node, ref);
    }
    while (ref) {
      const next = ref.nextSibling;
      root.removeChild(ref);
      ref = next;
    }
  }

  return {
    /**
     * @param {Tile[]} next tiles in order
     * @param {Map<string, HTMLElement>} els the element each tile shows
     */
    render(next, els) {
      elements = els;
      paint(next);
    },
    /** @param {boolean} on */
    setEditing(on) {
      editing = on;
      root.classList.toggle('is-editing', on);
      paint(tiles);
    },
    /** Focuses the first tile's move handle (entering edit mode). */
    focusFirst() {
      const first = tiles[0] && views.get(tiles[0].id);
      if (first) first.handle.focus();
    },
    /** Empties the board; the wrapped elements are left detached for their owners to re-place. */
    clear() {
      tiles = [];
      elements = new Map();
      for (const v of views.values()) v.body.replaceChildren();
      root.replaceChildren();
    },
  };
}
