# Protocol Dropdown URL Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make URL entry in all three service-entry points use a scheme dropdown (`https://` default, `http://`) beside a host-only field, and fix the `/` shortcut so it never hijacks typing in text fields.

**Architecture:** Each URL input becomes a two-part row: a `<select>` carrying the scheme and a `type="text"` input for host + optional port/path. A shared `schemeOf()` helper detects and strips a pasted/typed full URL on input; submit/save joins `scheme + host` back into a full URL before the existing API call. The `/` search-shortcut handler gains an "editable element" guard.

**Tech Stack:** Vanilla HTML/JS + Tailwind CDN (existing). No server changes. No new dependencies.

## Global Constraints

- Server is untouched: `server.py` and `test_server.py` are NOT modified by any task.
- Scheme `<select>` values are exactly `"https://"` and `"http://"`; `https://` is the default selected option everywhere.
- Host inputs are `type="text"` (never `type="url"` — a bare host like `immich.canzodal.com` fails `url` validation).
- Reuse existing styling classes: `form-input` (index.html), `field focus-ring` (settings.html), plus Tailwind `flex gap-1`, `w-28`, `shrink-0`, `min-w-0`, `flex-1`.
- No comments added to code. Existing patterns (`esc()`, `svgFor()`, `window.__HUB__` export) are preserved.
- The existing client suite stays green at every task boundary (76 assertions → grows as tasks add DOM tests).

---

### Task 1: Fix the `/` search shortcut so it never fires while typing

**Files:**
- Modify: `index.html:747-754`
- Test: `tests.html` (DOM suite additions)

**Interfaces:**
- Consumes: existing `searchInput` element (index.html:502).
- Produces: no new exports. Behavior change only.

- [ ] **Step 1: Replace the keydown handler**

In `index.html`, replace the handler at lines 747-754:

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

- [ ] **Step 2: Add DOM-suite assertions**

In `tests.html`, inside `runDomTests` (before the final "Restore default state" line at tests.html:319-320), add:

```js
    // / shortcut does not steal focus while typing in an input
    w.document.getElementById('add-form').classList.remove('hidden');
    w.document.getElementById('add-name').focus();
    ok(w.document.activeElement === w.document.getElementById('add-name'), 'add-name focused');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: '/' }));
    ok(w.document.activeElement === w.document.getElementById('add-name'), '/ while typing in an input does not focus search');
    w.document.getElementById('add-form').classList.add('hidden');
    w.document.body.focus();
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: '/' }));
    ok(w.document.activeElement === w.document.getElementById('search'), '/ with no input focused focuses search');
```

- [ ] **Step 3: Run the client suite**

Run the existing jsdom harness (serves the worktree over HTTP, injects `matchMedia`/`fetch` polyfills, loads `tests.html`, waits for `#summary`).
Expected: all previous assertions pass plus the 3 new ones → total grows to 79 ALL GREEN.

- [ ] **Step 4: Commit**

```bash
git add index.html tests.html
git commit -m "fix: / shortcut ignores typing in inputs"
```

---

### Task 2: Scheme dropdown in the dashboard "+ Add" form

**Files:**
- Modify: `index.html:243-245` (add-url input), `index.html:594-632` (add-form JS)
- Test: `tests.html` (DOM suite additions + stub capture)

**Interfaces:**
- Consumes: `addForm`, `addName`, `addUrl`, `addDesc`, `addPreview`, `addService` (index.html:608-612), `window.autoCategorize`.
- Produces: new DOM elements `#add-scheme` (select) and `#add-url` (now `type="text"`, host-only). New local helper `schemeOf(v)`. Submit handler now builds `url = scheme + host`.

- [ ] **Step 1: Replace the add-url input markup**

In `index.html:243-245`, replace the single URL input:

```html
          <input id="add-name" class="form-input" placeholder="Name (e.g. Grafana)" required />
          <input id="add-url"  class="form-input" placeholder="URL (https://…)" required type="url" />
```

with:

```html
          <input id="add-name" class="form-input" placeholder="Name (e.g. Grafana)" required />
          <div class="flex gap-1 min-w-0">
            <select id="add-scheme" class="form-input w-28 shrink-0" aria-label="URL scheme">
              <option value="https://" selected>https://</option>
              <option value="http://">http://</option>
            </select>
            <input id="add-url" class="form-input min-w-0 flex-1" type="text" placeholder="host (e.g. immich.canzodal.com)" required />
          </div>
```

- [ ] **Step 2: Add `schemeOf` helper and strip handler**

Immediately before `addToggle.addEventListener` (index.html:600), add:

```js
  function schemeOf(v) {
    const m = /^https?:\/\//.exec(v);
    return m ? m[0] : null;
  }
```

Immediately after the `addToggle` block (after line 606), add:

```js
  addUrl.addEventListener('input', () => {
    const scheme = schemeOf(addUrl.value);
    if (scheme) {
      document.getElementById('add-scheme').value = scheme;
      addUrl.value = addUrl.value.slice(scheme.length);
    }
  });
```

- [ ] **Step 3: Build the full URL in the submit handler**

In the submit handler (index.html:614-632), replace line 617:

```js
    const url  = addUrl.value.trim();
```

with:

```js
    const url  = (document.getElementById('add-scheme').value + addUrl.value.trim()).trim();
```

- [ ] **Step 4: Add DOM-suite assertions**

In `tests.html` `runDomTests`, add (before the "Restore default state" line):

```js
    // Scheme dropdown: pasting a full URL strips the scheme and sets the select
    const addScheme = w.document.getElementById('add-scheme');
    const addUrlField = w.document.getElementById('add-url');
    addScheme.value = 'https://';
    addUrlField.value = 'https://immich.canzodal.com';
    addUrlField.dispatchEvent(new w.Event('input'));
    eq(addScheme.value, 'https://', 'pasting https URL sets scheme select to https');
    eq(addUrlField.value, 'immich.canzodal.com', 'pasting full URL strips the scheme');

    // Submit builds scheme + host into the POST payload
    apiLog = [];
    stubFetch(CANNED);
    let lastPostBody = null;
    const prevFetch = w.fetch;
    w.fetch = (url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST' && String(url).includes('/api/services')) {
        lastPostBody = JSON.parse(opts.body);
      }
      return prevFetch(url, opts);
    };
    addScheme.value = 'http://';
    addUrlField.value = '192.168.1.50:8096';
    w.document.getElementById('add-name').value = 'Jellyfin';
    w.document.getElementById('add-desc').value = 'Movies';
    w.document.getElementById('add-form').dispatchEvent(new w.Event('submit'));
    await new Promise(r => setTimeout(r, 10));
    ok(apiLog.some(x => x === 'POST /api/services'), 'add form submits POST to /api/services');
    ok(lastPostBody && lastPostBody.url === 'http://192.168.1.50:8096', 'submit builds full URL from scheme + host', lastPostBody && lastPostBody.url);
    w.document.getElementById('add-name').value = '';
    w.document.getElementById('add-desc').value = '';
    addUrlField.value = '';
```

- [ ] **Step 5: Run the client suite**

Run the jsdom harness. Expected: 79 previous + 4 new = 83 ALL GREEN.

- [ ] **Step 6: Commit**

```bash
git add index.html tests.html
git commit -m "feat: scheme dropdown + host field in add form"
```

---

### Task 3: Scheme dropdown in the edit modal

**Files:**
- Modify: `index.html:328-331` (edit-url label block), `index.html:693-704` (openEditModal), `index.html:711-732` (saveEditModal)
- Test: `tests.html` (DOM suite — update prefill assertion, add PUT-body assertion)

**Interfaces:**
- Consumes: `SERVICES`, `editingId`, `apiJson`, `selectedIcon`, `renderIconPicker`, `schemeOf` (defined in Task 2).
- Produces: new DOM elements `#edit-scheme` (select) and `#edit-url` (now `type="text"`, host-only). `openEditModal` splits stored URL; `saveEditModal` builds full URL.

- [ ] **Step 1: Replace the edit-url label block**

In `index.html:328-331`, replace:

```html
      <label class="block">
        <span class="text-xs text-[color:var(--fg-muted)]">URL</span>
        <input id="edit-url" class="form-input mt-1" type="url" placeholder="https://…" />
      </label>
```

with:

```html
      <label class="block">
        <span class="text-xs text-[color:var(--fg-muted)]">URL</span>
        <div class="flex gap-1 mt-1">
          <select id="edit-scheme" class="form-input w-28 shrink-0" aria-label="URL scheme">
            <option value="https://" selected>https://</option>
            <option value="http://">http://</option>
          </select>
          <input id="edit-url" class="form-input min-w-0 flex-1" type="text" placeholder="host (e.g. immich.canzodal.com)" />
        </div>
      </label>
```

- [ ] **Step 2: Add the strip handler**

Immediately after the `addUrl` strip handler added in Task 2 (Step 2), add:

```js
  document.getElementById('edit-url').addEventListener('input', () => {
    const el = document.getElementById('edit-url');
    const scheme = schemeOf(el.value);
    if (scheme) {
      document.getElementById('edit-scheme').value = scheme;
      el.value = el.value.slice(scheme.length);
    }
  });
```

- [ ] **Step 3: Split stored URL in openEditModal**

In `openEditModal` (index.html:693-704), replace line 698:

```js
    document.getElementById('edit-url').value = s.url;
```

with:

```js
    const scheme = schemeOf(s.url) || 'https://';
    document.getElementById('edit-scheme').value = scheme;
    document.getElementById('edit-url').value = s.url.slice(scheme.length);
```

- [ ] **Step 4: Build full URL in saveEditModal**

In `saveEditModal` (index.html:711-732), replace line 715:

```js
    const url  = document.getElementById('edit-url').value.trim();
```

with:

```js
    const url  = (document.getElementById('edit-scheme').value + document.getElementById('edit-url').value.trim()).trim();
```

- [ ] **Step 5: Update and extend DOM-suite assertions**

In `tests.html` `runDomTests`, update the prefill assertion (line 292):

```js
    eq(w.document.getElementById('edit-url').value, 'https://grafana.example.com', 'modal prefills url');
```

to:

```js
    eq(w.document.getElementById('edit-scheme').value, 'https://', 'modal prefill sets scheme select');
    eq(w.document.getElementById('edit-url').value, 'grafana.example.com', 'modal prefills url without scheme');
```

Then, in the save-edit block (after tests.html:304), add a PUT-payload assertion. Modify the block so the PUT body is captured — replace lines 298-305:

```js
    apiLog = [];
    stubFetch(CANNED);
    w.document.getElementById('edit-name').value = 'Grafana Ops';
    await w.__HUB__.saveEdit();
    ok(apiLog.some(x => x === 'PUT /api/services/svc-1'), 'save issues PUT to /api/services/<id>');
    ok(modal.classList.contains('hidden'), 'modal closes after save');
    const renamed = Array.from(w.document.querySelectorAll('.card')).some(c => c.dataset.name === 'grafana ops');
    ok(renamed, 'renamed card rendered after save');
```

with:

```js
    apiLog = [];
    stubFetch(CANNED);
    let lastPutBody = null;
    const prevFetch2 = w.fetch;
    w.fetch = (url, opts = {}) => {
      if ((opts.method || 'GET') === 'PUT' && String(url).includes('/api/services/')) {
        lastPutBody = JSON.parse(opts.body);
      }
      return prevFetch2(url, opts);
    };
    w.document.getElementById('edit-name').value = 'Grafana Ops';
    w.document.getElementById('edit-scheme').value = 'https://';
    w.document.getElementById('edit-url').value = 'grafana.example.com';
    await w.__HUB__.saveEdit();
    ok(apiLog.some(x => x === 'PUT /api/services/svc-1'), 'save issues PUT to /api/services/<id>');
    ok(lastPutBody && lastPutBody.url === 'https://grafana.example.com', 'save PUTs scheme + host URL', lastPutBody && lastPutBody.url);
    ok(modal.classList.contains('hidden'), 'modal closes after save');
    const renamed = Array.from(w.document.querySelectorAll('.card')).some(c => c.dataset.name === 'grafana ops');
    ok(renamed, 'renamed card rendered after save');
```

Note: `lastPutBody` and `prevFetch2` are new local names — Task 2 already used `lastPostBody` and `prevFetch` in the same `runDomTests` scope, so `prevFetch2` avoids a duplicate `const` declaration.

- [ ] **Step 6: Run the client suite**

Run the jsdom harness. Expected: 83 previous − 1 replaced assertion + 1 new scheme assertion + 1 new PUT-body assertion = 84 ALL GREEN.

- [ ] **Step 7: Commit**

```bash
git add index.html tests.html
git commit -m "feat: scheme dropdown in edit modal"
```

---

### Task 4: Scheme dropdown in settings.html "Your links" editor

**Files:**
- Modify: `settings.html:199` (new-url input), `settings.html:431-450` (live category preview + addNew)

**Interfaces:**
- Consumes: `newName`, `newUrl`, `newDesc`, `newCat`, `apiJson`, `window.autoCategorize`, `renderServices`, `toast`.
- Produces: new DOM element `#new-scheme` (select). `addNew` builds `url = scheme + host`. `settings.html` is NOT covered by the DOM suite (it is not iframe-loaded by tests.html); verified manually per Step 4.

- [ ] **Step 1: Replace the new-url input**

In `settings.html:199`, replace:

```html
          <input id="new-url"  class="field focus-ring" placeholder="URL (https://…)" type="url" />
```

with:

```html
          <div class="flex gap-1 min-w-0">
            <select id="new-scheme" class="field focus-ring w-28 shrink-0" aria-label="URL scheme">
              <option value="https://" selected>https://</option>
              <option value="http://">http://</option>
            </select>
            <input id="new-url"  class="field focus-ring min-w-0 flex-1" type="text" placeholder="host (e.g. immich.canzodal.com)" />
          </div>
```

- [ ] **Step 2: Add the strip handler**

After the live-preview wiring at settings.html:431-433, add:

```js
  const newScheme = document.getElementById('new-scheme');
  newUrl.addEventListener('input', () => {
    const m = /^https?:\/\//.exec(newUrl.value);
    if (m) {
      newScheme.value = m[0];
      newUrl.value = newUrl.value.slice(m[0].length);
    }
  });
```

- [ ] **Step 3: Build the full URL in addNew**

In `addNew` (settings.html:434-450), replace line 436:

```js
    const url  = newUrl.value.trim();
```

with:

```js
    const url  = (newScheme.value + newUrl.value.trim()).trim();
```

(Note: `newScheme` is defined in Step 2 before `addNew` runs — the script is top-to-bottom, and `addNew` is only invoked by the button/submit listeners wired after.)

- [ ] **Step 4: Verify manually**

Start the server (`HUB_PASSWORD=… python server.py`), sign in, open `/settings.html`, open "+ Add link", and confirm:
1. Default select shows `https://`.
2. Pasting `https://immich.canzodal.com` into the host field flips the select to `https://` and leaves `immich.canzodal.com`.
3. Entering a bare host `immich.canzodal.com` and clicking Add saves a link whose card/URL is `https://immich.canzodal.com`.
4. Switching the select to `http://` and adding `192.168.1.50:8096` saves `http://192.168.1.50:8096`.
5. No server error toast appears (no 400).

Also run the full client suite (jsdom harness) and the server suite (`python -m unittest test_server`, expected 28 OK) to confirm no regressions.

- [ ] **Step 5: Commit**

```bash
git add settings.html
git commit -m "feat: scheme dropdown in settings links editor"
```

---

## Self-review notes

- **Spec coverage:** `/` shortcut guard → Task 1; dropdown + host field in all three entry points → Tasks 2-4; auto-strip on paste/type → Tasks 2-3 strip handlers + Task 4; join on submit/save → Tasks 2-4; `type="text"` → all three; edit-modal prefill split → Task 3 Step 3; DOM tests for strip, build, and shortcut → Tasks 1-3; server untouched → Global Constraints.
- **Type consistency:** `schemeOf` is defined in Task 2 and reused by Task 3 (same file, same scope). Task 4 inlines the regex (settings.html has no shared scope with index.html). `#add-scheme`, `#edit-scheme`, `#new-scheme` values are all `"https://"`/`"http://"`. The submit/save handlers all produce `scheme + host` before calling the unchanged `apiJson`/`addService`.
- **Placeholder scan:** every step has concrete code; no TBD/TODO.
- **Test-count reconciliation:** 76 (baseline) → Task 1 +3 = 79 → Task 2 +4 = 83 → Task 3 −1 +2 = 84. Verify counts match the harness summary at each boundary.
