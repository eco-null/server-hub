// @ts-check
import { createApi } from './api.js';
import { handleUnauthenticated } from './session.js';
import { notifyChanged } from './lib/sync.js';

/** The shared API client used by every page. */
export const api = createApi({
  fetchImpl: (input, init) => fetch(input, init),
  onUnauthenticated: handleUnauthenticated,
  onWrite: notifyChanged,
});
