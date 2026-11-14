// @ts-check
/**
 * Settings: Docker auto-discovery (admin only). Shows whether the server can
 * read the host's containers, who sees discovered services, how to label a
 * container, which containers were skipped, and suggestions to add as services.
 */

import { h } from '../dom.js';
import { createSwitch } from '../ui.js';
import { icon, serviceIcon } from '../icons.js';
import { hostOf, safeUrl } from '../lib/url.js';
import { copyText } from '../lib/clipboard.js';
import { DEPLOYMENT_GUIDE_URL, formatPort, hiddenDuplicates, suggestionToDraft, agoText } from '../lib/docker.js';
import { openAddService } from '../features/service-dialogs.js';
import { toastSuccess, toastError } from '../toast.js';

const PUBLIC_HOST_HINT = 'Set SERVERHUB_DOCKER_PUBLIC_HOST on the server to fill in the address automatically.';

/** The seven labels, in the order they are documented (docs/API.md, "Docker discovery"). */
const LABELS = [
  ['serverhub.enable', 'Required. Set to true to show the container on the dashboard.'],
  ['serverhub.url', 'Required. A valid http or https address, without a username or password in it. The card opens it, and the server requests the same address for status checks unless serverhub.check is false.'],
  ['serverhub.name', 'The name on the card, up to 200 characters. Defaults to the container name.'],
  ['serverhub.description', 'A short line under the name, up to 500 characters. Defaults to empty.'],
  ['serverhub.icon', 'An icon id, for example chart, database or server. Guessed from the image and name when left out.'],
  ['serverhub.category', 'The group it appears in, for example Monitoring. Detected automatically when left out.'],
  ['serverhub.check', 'true or false: whether the server checks that the address answers. Defaults to true.'],
];

const COMPOSE_EXAMPLE = `services:
  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    labels:
      serverhub.enable: "true"
      serverhub.url: "https://grafana.example.com"
      serverhub.name: "Grafana"
      serverhub.description: "Dashboards and alerts"
      serverhub.icon: "chart"
      serverhub.category: "Monitoring"
      serverhub.check: "true"
`;

/**
 * @param {HTMLElement} root
 * @param {import('./env.js').Env} env
 */
export function mountDocker(root, env) {
  const { api, store, state } = env;
  let started = false;

  root.append(h('p', { class: 'muted', role: 'status' }, 'Loading…'));

  /** @param {...import('../dom.js').Child} children */
  const show = (...children) => root.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));

  function notConfigured() {
    const guide = safeUrl(DEPLOYMENT_GUIDE_URL);
    show(
      h(
        'div',
        { class: 'sub-card glass' },
        h('h3', { class: 'card-title-sm' }, 'Docker discovery is not set up'),
        h('p', { class: 'muted' }, 'Server Hub can show your running containers as services automatically. It reads them through a socket proxy that allows only the container list, so it never gets control of Docker. Containers labeled serverhub.enable=true then appear on the dashboard, and you can add other containers with one click from the suggestions here.'),
        h(
          'p',
          { class: 'muted' },
          'To turn it on, the operator sets ',
          h('code', { class: 'mono' }, 'COMPOSE_PROFILES=docker'),
          ' (this starts the proxy), ',
          h('code', { class: 'mono' }, 'SERVERHUB_DOCKER_HOST'),
          ' (where Server Hub reaches it) and ',
          h('code', { class: 'mono' }, 'DOCKER_GID'),
          ' (the group that owns the Docker socket; without it the proxy exits at start), then runs ',
          h('code', { class: 'mono' }, 'docker compose up -d'),
          '.',
        ),
        guide
          ? h('div', null, h('a', { class: 'btn', href: guide, target: '_blank', rel: 'noopener noreferrer' }, h('span', null, 'Read the deployment guide'), icon('external-link'), h('span', { class: 'sr-only' }, ' (opens in a new tab)')))
          : null,
      ),
    );
  }

  /** @param {string} message */
  function loadFailed(message) {
    show(
      h('p', { class: 'muted', role: 'alert' }, message),
      h('div', null, h('button', { type: 'button', class: 'btn', onclick: () => void load() }, 'Try again')),
    );
  }

  /** @param {import('../types.js').DockerResponse} dock */
  function statusRow(dock) {
    const n = dock.services.length;
    const ok = dock.available;
    const hidden = hiddenDuplicates(state.get().services, dock.services);
    const skippedN = Array.isArray(dock.skipped) ? dock.skipped.length : 0;
    const summary =
      n === 0
        ? skippedN > 0
          ? `No cards yet: ${skippedN} labeled container${skippedN === 1 ? ' was' : 's were'} skipped. See Skipped containers below.`
          : 'No containers carry the serverhub.enable label yet.'
        : `${n} discovered container${n === 1 ? '' : 's'}` + (hidden > 0 ? `, ${hidden} hidden as ${hidden === 1 ? 'a duplicate' : 'duplicates'} of your own services` : ', all shown on the dashboard') + '.';
    return h(
      'div',
      { class: 'docker-status' },
      h('span', { class: 'tag ' + (!ok ? 'tag-bad' : dock.stale ? 'tag-warn' : 'tag-ok') }, !ok ? 'Unavailable' : dock.stale ? 'Not responding' : 'Connected'),
      ok
        ? h('p', { class: 'muted' }, summary + (dock.stale ? ` Showing the container list${agoText(dock.updated_at) ? ' from ' + agoText(dock.updated_at) : ' it last received'}.` : ''))
        : h('p', { class: 'muted' }, dock.error || "Server Hub can't read the Docker socket proxy right now."),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => void load() }, 'Refresh'),
    );
  }

  /** @param {boolean | null} value `null` when the setting could not be read */
  function visibilitySwitch(value) {
    const note = h('p', { class: 'field-hint', role: 'status' });
    const sw = createSwitch({
      label: 'Show discovered services to all users',
      description: 'Off: only administrators see them. On: every signed-in user sees them on their dashboard.',
      checked: !!value,
      onChange: async (checked) => {
        sw.input.disabled = true;
        note.textContent = '';
        try {
          const res = await api.put('/api/admin/config', { docker_visible_to_users: checked });
          sw.input.checked = !!res.docker_visible_to_users;
          note.textContent = res.docker_visible_to_users ? 'All users can see discovered services.' : 'Only administrators can see discovered services.';
        } catch (err) {
          sw.input.checked = !checked;
          toastError(err instanceof Error ? err.message : "Couldn't change the setting.");
        } finally {
          sw.input.disabled = false;
        }
      },
    });
    if (value === null) {
      sw.input.disabled = true;
      note.textContent = "Couldn't load this setting. Use Refresh to try again.";
    }
    return h('div', { class: 'stack' }, sw.root, note);
  }

  function labelReference() {
    const copy = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm',
        onclick: async () => {
          if (await copyText(COMPOSE_EXAMPLE)) toastSuccess('Copied the Compose example.');
          else toastError("Couldn't copy. Select the example and copy it yourself.");
        },
      },
      h('span', null, 'Copy example'),
    );
    return h(
      'details',
      { class: 'docker-ref' },
      h('summary', null, 'Label reference'),
      h(
        'div',
        { class: 'docker-ref-body' },
        h('p', { class: 'muted' }, 'Add these labels to a container and recreate it. serverhub.enable and serverhub.url are both required: a labeled container without a valid web address is skipped.'),
        h('dl', { class: 'docker-labels' }, LABELS.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        h('p', { class: 'field-hint' }, 'True or false values also accept 1 or 0, yes or no, and on or off, in any letter case. An invalid serverhub.check counts as true. A name or description that is too long, or any other invalid value, falls back to its default and is listed under Warnings.'),
        h('pre', { class: 'docker-pre', tabindex: '0', 'aria-label': 'Docker Compose example' }, h('code', null, COMPOSE_EXAMPLE)),
        h('div', { class: 'docker-ref-actions' }, copy),
      ),
    );
  }

  /**
   * @param {string} title
   * @param {string} intro
   * @param {Array<{ container: string, reason: string }>} items `"*"` marks a note about the whole listing
   */
  function diagnostics(title, intro, items) {
    if (!items.length) return null;
    return h(
      'div',
      { class: 'docker-sub' },
      h('h3', { class: 'card-title-sm' }, title),
      h('p', { class: 'muted' }, intro),
      h(
        'ul',
        { class: 'list', 'aria-label': title },
        items.map((s) =>
          h(
            'li',
            { class: 'list-row sug-row' },
            h('span', { class: 'list-icon' }, icon('ui-info')),
            h('div', { class: 'list-main' }, s.container === '*' ? h('p', { class: 'list-title' }, 'General note') : h('p', { class: 'list-title mono' }, s.container), h('p', { class: 'list-sub' }, s.reason)),
          ),
        ),
      ),
    );
  }

  /** @param {import('../types.js').DockerSuggestions | null} sug @param {boolean} connected */
  function suggestionsBlock(sug, connected) {
    const heading = h('h3', { class: 'card-title-sm', id: 'docker-sug-h', tabindex: '-1' }, 'Suggestions');
    const intro = h('p', { class: 'muted' }, 'Running containers without a serverhub.enable label (a container with the label set to any value is left out) that publish a TCP port reachable from outside the host, not only on the host itself. Adding one creates a normal service you can edit.');
    const list = h('ul', { class: 'list', 'aria-labelledby': 'docker-sug-h' });
    const empty = h('p', { class: 'muted', role: 'status' });
    /** @type {import('../types.js').DockerSuggestion[]} */
    let items = sug && sug.available ? [...sug.suggestions] : [];

    /** @param {import('../types.js').DockerSuggestion} s */
    function row(s) {
      const draft = suggestionToDraft(s);
      const add = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-primary',
          'aria-label': `Add ${draft.name}`,
          onclick: () =>
            void openAddService({
              api,
              defaultDomain: store.get().defaultDomain,
              prefill: { ...draft, urlHint: draft.needsUrl ? PUBLIC_HOST_HINT : undefined },
              onSaved: (svc) => {
                state.set({ services: [...state.get().services, svc] });
                remove(s);
              },
            }),
        },
        icon('ui-plus'),
        h('span', null, 'Add'),
      );
      return h(
        'li',
        { class: 'list-row sug-row', dataset: { container: s.container.name } },
        h('span', { class: 'list-icon' }, serviceIcon(s.suggested.icon)),
        h(
          'div',
          { class: 'list-main' },
          h('p', { class: 'list-title' }, s.container.name),
          h('p', { class: 'list-sub mono' }, s.container.image),
          h('p', { class: 'list-sub' }, `Adds “${draft.name}”`, draft.needsUrl ? ' with no address yet' : [' at ', h('span', { class: 'mono' }, hostOf(draft.url) || draft.url)]),
        ),
        h('div', { class: 'list-meta' }, s.ports.map((p) => h('span', { class: 'pill', title: `Host port ${p.public} to container port ${p.private} (${p.protocol})` }, formatPort(p)))),
        h('div', { class: 'list-actions' }, add),
      );
    }

    function paint() {
      list.replaceChildren(...items.map(row));
      list.hidden = items.length === 0;
      empty.hidden = items.length > 0;
      if (!items.length) {
        empty.textContent = !sug
          ? "Couldn't load suggestions. Use Refresh to try again."
          : !connected || !sug.available
            ? 'Suggestions need a working Docker connection.'
            : 'No suggestions right now. Containers that publish ports and have no serverhub labels show up here.';
      }
    }

    /** @param {import('../types.js').DockerSuggestion} s */
    function remove(s) {
      const i = items.indexOf(s);
      items = items.filter((x) => x !== s);
      paint();
      // The Add button that had focus is gone: hand focus to the next row, else the previous one, else the heading.
      const buttons = list.querySelectorAll('.list-actions .btn');
      const next = /** @type {HTMLElement | undefined} */ (buttons[Math.min(i, buttons.length - 1)]);
      (next || heading).focus();
    }

    paint();
    return h('div', { class: 'docker-sub' }, heading, intro, list, empty);
  }

  /** @param {PromiseSettledResult<any>} r */
  const value = (r) => (r.status === 'fulfilled' ? r.value : null);

  async function load() {
    try {
      const [dockR, sugR, cfgR] = await Promise.allSettled([api.get('/api/docker'), api.get('/api/admin/docker/suggestions'), api.get('/api/admin/config')]);
      /** @type {import('../types.js').DockerResponse | null} */
      const dock = value(dockR);
      if (!dock) {
        const status = dockR.status === 'rejected' && dockR.reason && typeof dockR.reason === 'object' ? dockR.reason.status : 0;
        if (status === 404 || status === 403) return notConfigured();
        return loadFailed(dockR.status === 'rejected' && dockR.reason instanceof Error ? dockR.reason.message : "Couldn't load the Docker status.");
      }
      if (!dock.enabled) return notConfigured();
      /** @type {import('../types.js').DockerSuggestions | null} */
      const sug = value(sugR);
      const cfg = value(cfgR);
      const visible = cfg && typeof cfg.docker_visible_to_users === 'boolean' ? cfg.docker_visible_to_users : null;
      show(
        statusRow(dock),
        visibilitySwitch(visible),
        labelReference(),
        diagnostics('Skipped containers', 'No card was created for these labeled containers. Fix the labels and recreate them.', Array.isArray(dock.skipped) ? dock.skipped : []),
        diagnostics('Warnings', 'A card was created for these, but an invalid label value was replaced by its default.', Array.isArray(dock.warnings) ? dock.warnings : []),
        suggestionsBlock(sug, dock.available),
      );
    } catch (err) {
      loadFailed(err instanceof Error ? err.message : "Couldn't load the Docker status.");
    }
  }

  return {
    /**
     * Renders the section once the bootstrap told whether discovery is on.
     * @param {boolean | null} enabled `null` when the bootstrap could not be loaded
     */
    start(enabled) {
      if (started) return;
      started = true;
      if (enabled === null) loadFailed("Couldn't check whether Docker discovery is set up. Reload the page to try again.");
      else if (!enabled) notConfigured();
      else void load();
    },
  };
}
