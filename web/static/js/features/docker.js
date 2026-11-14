// @ts-check
/**
 * Discovered Docker services come from the server (GET /api/docker), which
 * reads the host's containers through a read-only socket proxy. Polled while
 * the feature is on for this user and the tab is visible, like the status
 * checks.
 */

import { createPoller } from '../poller.js';

const POLL_MS = 30000;

/**
 * @param {{
 *   api: import('../api.js').Api,
 *   isEnabled: () => boolean,
 *   onResponse: (res: unknown) => void,
 * }} o `onResponse` gets the parsed body, or null when the request failed.
 */
export function createDockerPoller({ api, isEnabled, onResponse }) {
  return createPoller(
    async () => {
      /** @type {unknown} */
      let res = null;
      try {
        res = await api.get('/api/docker');
      } catch (err) {
        // The feature is gone (older server, or this user may no longer see it): behave as disabled.
        if (err && typeof err === 'object' && 'status' in err && (err.status === 403 || err.status === 404)) res = { enabled: false };
      }
      onResponse(res);
    },
    POLL_MS,
    { isEnabled },
  );
}
