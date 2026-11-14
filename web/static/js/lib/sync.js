// @ts-check
/**
 * Tells the other open tabs of this browser that data changed, so a dashboard
 * that is open next to the settings page does not keep showing stale data.
 */

const NAME = 'serverhub:changes';

/** @type {BroadcastChannel | null} */
let channel = null;
try {
  if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel(NAME);
} catch {
  channel = null;
}

/** Call after a successful write. Other tabs get the event; this one does not. */
export function notifyChanged() {
  try {
    if (channel) channel.postMessage('changed');
  } catch {
    /* closed channel: nothing to tell */
  }
}

/** @param {() => void} callback runs when another tab reported a change */
export function onChanged(callback) {
  if (channel) channel.addEventListener('message', () => callback());
}
