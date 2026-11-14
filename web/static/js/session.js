// @ts-check
/** Session lifecycle: 401 handling and logout. */

import { clearUserData } from './storage.js';

/**
 * Drops every cached user value and sends the browser to the login page.
 * Used for any 401 from the API.
 */
export function handleUnauthenticated() {
  clearUserData();
  if (!location.pathname.startsWith('/login')) location.assign('/login?expired=1');
}

/**
 * Ends the session on the server, clears the local cache and leaves the app.
 * @param {import('./api.js').Api} api
 */
export async function logout(api) {
  try {
    await api.post('/api/auth/logout', undefined, { silent401: true });
  } catch {
    /* even if the request failed we still leave: the cookie is HttpOnly and expires server-side */
  }
  clearUserData();
  location.assign('/login');
}
