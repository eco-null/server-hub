// @ts-check

/**
 * Runs `fn` every `intervalMs` while the tab is visible. Calls never overlap,
 * errors are swallowed (callers handle their own), and a tab that becomes
 * visible again refreshes immediately.
 * @param {() => Promise<void> | void} fn
 * @param {number} intervalMs
 * @param {{ isEnabled?: () => boolean }} [opts]
 */
export function createPoller(fn, intervalMs, opts = {}) {
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let inflight = false;

  async function tick() {
    if (document.hidden || inflight) return;
    if (opts.isEnabled && !opts.isEnabled()) return;
    inflight = true;
    try {
      await fn();
    } catch {
      /* the caller reports its own errors */
    } finally {
      inflight = false;
    }
  }

  const onVisible = () => {
    if (!document.hidden && timer) void tick();
  };

  return {
    start() {
      if (timer) return;
      document.addEventListener('visibilitychange', onVisible);
      timer = setInterval(tick, intervalMs);
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    },
    /** Runs once now (respects visibility, enabled and overlap rules). */
    refresh: tick,
  };
}
