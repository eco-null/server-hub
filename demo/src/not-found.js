/* 404 page of the demo (GitHub Pages serves it for unknown paths). Sends the
   visitor to the matching demo page, keeping the query and hash for
   "settings" and "login", and to the dashboard for anything else. */
(function () {
  var script = document.currentScript;
  var base = script ? new URL('../../', script.src).pathname : '/';
  var rest = location.pathname.indexOf(base) === 0 ? location.pathname.slice(base.length) : '';
  var page = rest.replace(/\/+$/, '').replace(/\.html$/, '');
  var target = base;
  if (page === 'settings' || page === 'login') target = base + page + '.html' + location.search + location.hash;
  location.replace(target);
})();
