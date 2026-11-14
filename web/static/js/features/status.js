// @ts-check
/**
 * Service status comes from the server (GET /api/status). The browser never
 * contacts the services itself. Polled only while the feature is on and the
 * tab is visible.
 */

import { createPoller } from '../poller.js';

const POLL_MS = 30000;

/**
 * @param {{
 *   api: import('../api.js').Api,
 *   isEnabled: () => boolean,
 *   onStatuses: (s: Record<string, import('../types.js').ServiceStatus>) => void,
 * }} o
 */
export function createStatusPoller({ api, isEnabled, onStatuses }) {
  return createPoller(
    async () => {
      const res = await api.get('/api/status');
      onStatuses(res && res.statuses && typeof res.statuses === 'object' ? res.statuses : {});
    },
    POLL_MS,
    { isEnabled },
  );
}
