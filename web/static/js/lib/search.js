// @ts-check
import { hostOf, safeUrl } from './url.js';
import { resolveCategory } from '../categorize.js';

export const SEARCH_PROVIDERS = Object.freeze({
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
  startpage: { label: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' },
  searxng: { label: 'SearXNG (your own instance)', url: '' },
});

/**
 * Builds the web-search URL for the configured provider.
 * An invalid SearXNG URL falls back to Google.
 * @param {{ provider?: string, searxngUrl?: string } | undefined} search
 * @param {string} query
 * @returns {string}
 */
export function buildSearchUrl(search, query) {
  const q = encodeURIComponent(query);
  const provider = search && search.provider;
  if (provider === 'searxng') {
    const base = safeUrl(search && search.searxngUrl);
    if (base) {
      const u = new URL(base);
      const path = u.pathname.replace(/\/+$/, '');
      u.pathname = (path.endsWith('/search') ? path : path + '/search') || '/search';
      u.hash = '';
      u.searchParams.set('q', query);
      return u.href;
    }
  } else if (typeof provider === 'string' && Object.hasOwn(SEARCH_PROVIDERS, provider)) {
    const prefix = SEARCH_PROVIDERS[/** @type {keyof typeof SEARCH_PROVIDERS} */ (provider)].url;
    if (prefix) return prefix + q;
  }
  return SEARCH_PROVIDERS.google.url + q;
}

/**
 * Ranks services against a free-text query. Every query word must occur in
 * the name, description, host or category; name matches rank first.
 * @template {{ name: string, description?: string, url: string, category?: string | null }} S
 * @param {S[]} services
 * @param {string} query
 * @param {number} [limit]
 * @returns {S[]}
 */
export function rankServices(services, query, limit = 8) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return services.slice(0, limit);
  /** @type {Array<{ s: S, score: number }>} */
  const scored = [];
  for (const s of services) {
    const name = s.name.toLowerCase();
    const rest = [s.description || '', hostOf(s.url), resolveCategory(s)].join(' ').toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (name.startsWith(w)) score += 4;
      else if (name.split(/[^a-z0-9]+/).some((t) => t.startsWith(w))) score += 3;
      else if (name.includes(w)) score += 2;
      else if (rest.includes(w)) score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map((x) => x.s);
}
