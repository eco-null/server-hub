import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LAYOUT, groupTileId, normalizeLayout, resolveTiles, tilesToSave, moveTile, updateTile } from '../static/js/lib/grid.js';

test('normalizeLayout: garbage input gives the disabled empty layout', () => {
  for (const raw of [null, undefined, 'x', 5, true, []]) {
    assert.deepEqual(normalizeLayout(raw), { enabled: false, items: [] }, String(raw));
  }
  assert.deepEqual(normalizeLayout({ items: 'nope' }), { enabled: false, items: [] });
  assert.deepEqual(DEFAULT_LAYOUT, { enabled: false, items: [] });
});

test('normalizeLayout: drops malformed tiles and keeps the first of duplicate ids', () => {
  const out = normalizeLayout({
    enabled: true,
    items: [
      null,
      { id: 42, size: 'm', hidden: false },
      { size: 'm' },
      { id: 'group:Media', size: 'l', hidden: true },
      { id: 'group:Media', size: 's', hidden: false },
      { id: 'widget:clock', size: 'm', hidden: false },
    ],
  });
  assert.deepEqual(out.items, [
    { id: 'group:Media', size: 'l', hidden: true },
    { id: 'widget:clock', size: 'm', hidden: false },
  ]);
});

test('normalizeLayout: bad sizes become s, hidden and enabled only when exactly true', () => {
  const out = normalizeLayout({
    enabled: 'true',
    items: [
      { id: 'a', size: 'xl', hidden: 'true' },
      { id: 'b', size: 'm', hidden: 1 },
      { id: 'c', size: 'l', hidden: true },
      { id: 'd' },
    ],
  });
  assert.equal(out.enabled, false, 'string "true" does not enable the grid');
  assert.deepEqual(out.items, [
    { id: 'a', size: 's', hidden: false },
    { id: 'b', size: 'm', hidden: false },
    { id: 'c', size: 'l', hidden: true },
    { id: 'd', size: 's', hidden: false },
  ]);
  assert.equal(normalizeLayout({ enabled: true, items: [] }).enabled, true);
});

test('resolveTiles: keeps stored order, drops unavailable tiles, appends new ones at default size', () => {
  const stored = [
    { id: 'group:Media', size: 'l', hidden: false },
    { id: 'widget:gone', size: 'm', hidden: false },
    { id: 'group:Dev', size: 'm', hidden: true },
  ];
  const available = [
    { id: 'group:Infra', size: 's' },
    { id: 'group:Dev', size: 's' },
    { id: 'group:Media', size: 's' },
    { id: 'widget:clock', size: 'm' },
  ];
  assert.deepEqual(resolveTiles(stored, available), [
    { id: 'group:Media', size: 'l', hidden: false },
    { id: 'group:Dev', size: 'm', hidden: true },
    { id: 'group:Infra', size: 's', hidden: false },
    { id: 'widget:clock', size: 'm', hidden: false },
  ]);
});

test('resolveTiles: returns copies, so mutating the result leaves the input alone', () => {
  const stored = [{ id: 'a', size: 's', hidden: false }];
  const available = [{ id: 'a', size: 's' }, { id: 'b', size: 'm' }];
  const out = resolveTiles(stored, available);
  out[0].hidden = true;
  out[1].size = 'l';
  assert.deepEqual(stored, [{ id: 'a', size: 's', hidden: false }]);
  assert.deepEqual(available, [{ id: 'a', size: 's' }, { id: 'b', size: 'm' }]);
});

test('tilesToSave: shown tiles first in order, then unshown stored tiles, no duplicates', () => {
  const shown = [
    { id: 'b', size: 'm', hidden: false },
    { id: 'a', size: 's', hidden: false },
  ];
  const stored = [
    { id: 'a', size: 'l', hidden: true },
    { id: 'x', size: 'l', hidden: true },
    { id: 'c', size: 's', hidden: false },
    { id: 'b', size: 's', hidden: false },
  ];
  assert.deepEqual(tilesToSave(shown, stored), [
    { id: 'b', size: 'm', hidden: false },
    { id: 'a', size: 's', hidden: false },
    { id: 'x', size: 'l', hidden: true },
    { id: 'c', size: 's', hidden: false },
  ]);
  const saved = tilesToSave(shown, stored);
  assert.equal(new Set(saved.map((t) => t.id)).size, saved.length);
});

test('tilesToSave: returns copies', () => {
  const shown = [{ id: 'a', size: 's', hidden: false }];
  const stored = [{ id: 'z', size: 's', hidden: false }];
  const out = tilesToSave(shown, stored);
  out[0].size = 'l';
  out[1].hidden = true;
  assert.deepEqual(shown, [{ id: 'a', size: 's', hidden: false }]);
  assert.deepEqual(stored, [{ id: 'z', size: 's', hidden: false }]);
});

test('moveTile: moves forward and backward', () => {
  const tiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const ids = (list) => list.map((t) => t.id);
  assert.deepEqual(ids(moveTile(tiles, 'a', 2)), ['b', 'c', 'a', 'd']);
  assert.deepEqual(ids(moveTile(tiles, 'd', 0)), ['d', 'a', 'b', 'c']);
  assert.deepEqual(ids(moveTile(tiles, 'c', 0)), ['c', 'a', 'b', 'd']);
  assert.deepEqual(ids(moveTile(tiles, 'b', 1)), ['a', 'b', 'c', 'd'], 'same position is a no-op');
  assert.deepEqual(ids(tiles), ['a', 'b', 'c', 'd'], 'input is not mutated');
});

test('moveTile: clamps the target position to the list bounds', () => {
  const tiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ids = (list) => list.map((t) => t.id);
  assert.deepEqual(ids(moveTile(tiles, 'c', -5)), ['c', 'a', 'b']);
  assert.deepEqual(ids(moveTile(tiles, 'a', 99)), ['b', 'c', 'a']);
});

test('moveTile: unknown id returns an equal copy', () => {
  const tiles = [{ id: 'a' }, { id: 'b' }];
  const out = moveTile(tiles, 'nope', 0);
  assert.deepEqual(out, tiles);
  assert.notEqual(out, tiles);
});

test('updateTile: changes only the matching tile and leaves the input untouched', () => {
  const tiles = [
    { id: 'a', size: 's', hidden: false },
    { id: 'b', size: 's', hidden: false },
  ];
  const out = updateTile(tiles, 'b', { size: 'l', hidden: true });
  assert.deepEqual(out, [
    { id: 'a', size: 's', hidden: false },
    { id: 'b', size: 'l', hidden: true },
  ]);
  assert.deepEqual(tiles, [
    { id: 'a', size: 's', hidden: false },
    { id: 'b', size: 's', hidden: false },
  ]);
  assert.deepEqual(updateTile(tiles, 'zzz', { hidden: true }), tiles, 'unknown id changes nothing');
});

test('groupTileId prefixes the category', () => {
  assert.equal(groupTileId('Media'), 'group:Media');
});
