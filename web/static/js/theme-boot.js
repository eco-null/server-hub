/* Runs in <head> before first paint so there is no theme flash.
   Reads the device-level preference written by theme.js; plain script (not a
   module) so it blocks rendering for the few microseconds it needs. */
(function () {
  try {
    var ui = JSON.parse(localStorage.getItem('serverhub:ui') || '{}');
    var mode = ui.theme;
    var dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.classList.add(dark ? 'dark' : 'light');
    var vars = ui.vars;
    if (vars) {
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k) && /^--accent/.test(k) && /^[#a-z0-9(),.\s]+$/i.test(String(vars[k]))) {
          root.style.setProperty(k, vars[k]);
        }
      }
    }
  } catch (e) {
    /* storage unavailable: CSS defaults (dark) apply */
  }
})();
