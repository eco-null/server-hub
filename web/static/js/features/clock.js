// @ts-check
/** Live clock, date and greeting. Paused while the tab is hidden. */

import { formatClock, greetingFor } from '../lib/format.js';
import { createPoller } from '../poller.js';

/**
 * @param {{
 *   clock: HTMLElement, date: HTMLElement, greeting: HTMLElement,
 *   getUserName: () => string,
 *   isEnabled: () => boolean,
 * }} o
 */
export function createClock(o) {
  const long = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
  let lastDay = '';
  let lastGreet = '';

  function tick() {
    const d = new Date();
    o.clock.textContent = formatClock(d);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (day !== lastDay) {
      lastDay = day;
      o.date.textContent = long.format(d);
    }
    const name = o.getUserName();
    const key = `${day}-${d.getHours()}-${name}`;
    if (key !== lastGreet) {
      lastGreet = key;
      o.greeting.textContent = `${greetingFor(d.getHours())}${name ? ', ' + name : ''}`;
    }
  }

  const poller = createPoller(tick, 1000, { isEnabled: o.isEnabled });
  return {
    start() {
      tick();
      poller.start();
    },
    /** Forces a redraw (e.g. after the name changed). */
    refresh() {
      lastGreet = '';
      tick();
    },
  };
}
