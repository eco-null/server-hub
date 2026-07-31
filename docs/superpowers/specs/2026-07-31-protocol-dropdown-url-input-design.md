# Design: Protocol Dropdown for URL Input

**Date:** 2026-07-31
**Status:** Approved (in review)
**Related:** 2026-07-31-server-hub-persistent-services-design.md (services now server-persisted)

## Problem

Typing `/` while entering a URL in the "Add service" form hijacks focus to the
search box, making it impossible to type `https://…`. Root cause: the search
shortcut handler (`index.html:747-750`) fires for every `/` keypress unless
focus is exactly on the search input — it ignores the URL field.

Separately, entering a URL is friction: the field demands the full
`https://` prefix typed by hand.

## Goal

1. Fix the `/` shortcut so it never fires while typing in any text field.
2. Give every URL entry point a **protocol dropdown** (`https://` default,
   `http://`) beside a **host-only field**, so the user types just the IP or
   domain (e.g. `immich.canzodal.com`).

## Scope

Three URL entry points, all converted to the dropdown + host pattern:

| Entry point | File | Current element |
|-------------|------|-----------------|
| Dashboard "+ Add" form | `index.html` | `#add-url` (type="url") |
| Edit modal | `index.html` | `#edit-url` (type="url") |
| "Your links" editor (add link) | `settings.html` | `#new-url` (type="url") |

The search box, category select, description field, and all other inputs are
untouched except for the shortcut guard (below).

## Design

### 1. Fix the `/` search shortcut

In `index.html:747-750`, only trigger the `/` shortcut when focus is not on an
editable element. Editable = `INPUT`, `TEXTAREA`, `SELECT`, or an element with
`contenteditable`. Implementation:

```js
document.addEventListener('keydown', e => {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT' || el.isContentEditable);
  if (e.key === '/' && !typing) {
    e.preventDefault(); searchInput.focus();
  }
  if (e.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = ''; filter(''); searchInput.blur();
  }
});
```

### 2. Protocol dropdown + host field (all three entry points)

Each URL input is replaced by a two-part row:

```html
<div class="flex gap-1">
  <select class="url-scheme form-input w-28 shrink-0" aria-label="URL scheme">
    <option value="https://">https://</option>
    <option value="http://">http://</option>
  </select>
  <input id="add-url" class="form-input min-w-0 flex-1" type="text"
         placeholder="host (e.g. immich.canzodal.com)" />
</div>
```

Rules:
- Scheme select defaults to `https://`.
- Host field is `type="text"` (a bare host like `immich.canzodal.com` is not a
  valid `type="url"` value).
- Ports and paths work in the host field: `example.com:8443`, `example.com/app`.
- Existing styling classes reused (`form-input`, `field focus-ring`) with
  minimal width classes for the select.

### 3. Auto-strip / auto-detect scheme on input

On `input` of the host field, if the value starts with `http://` or `https://`:
- Strip the scheme from the value (`https://immich.canzodal.com` →
  `immich.canzodal.com`).
- Set the scheme select to the detected scheme.
- Preserve the caret where possible; if caret math is fiddly, simply re-focus
  and place the caret at the end (acceptable: this only fires when the user
  pastes or types a full URL).

Shared helper (one per file, or a small inline function where the file already
has URL helpers):

```js
function schemeOf(v) {
  const m = /^https?:\/\//.exec(v);
  return m ? m[0] : null;
}
```

### 4. Build the full URL on submit/save

At every submit/save site, join scheme + host:

```js
const url = (schemeSelect.value + hostInput.value.trim()).trim();
```

Applied in:
- `index.html` add form submit handler (`addService` call site, line ~617)
- `index.html` edit modal save (`saveEditModal`, line ~715)
- `settings.html` `addNew` (line ~436)

### 5. Edit modal prefill

`openEditModal` (index.html:698) must split the stored URL:
- If it starts with `http://`/`https://`, set the scheme select accordingly and
  put the remainder (host + path) in the host field.
- Otherwise (shouldn't happen — server requires a scheme) put the raw value in
  the host field with the default scheme.

## Testing

- **DOM suite (`tests.html`)**: add assertions that
  - typing/pasting a full URL strips the scheme and sets the dropdown,
  - submitting builds `scheme + host` into the payload sent to the stubbed
    `POST /api/services`,
  - the `/` shortcut does not steal focus when an input is focused.
- **Server tests**: unchanged (server still validates the full URL; the
  frontend now guarantees the scheme).
- Manual: the three entry points, plus edit-modal prefill of both an
  `https://` and `http://` URL.

## Out of scope

- No server changes (validation already accepts the joined URL).
- No auto-categorization changes.
- No changes to the search box behavior beyond the shortcut guard.
