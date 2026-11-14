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

/** Match tiers, best first. A service must match every query word; word scores add up. */
const TIER = Object.freeze({ namePrefix: 100, nameWord: 80, nameSub: 60, hostWord: 45, descWord: 40, hostSub: 30, descSub: 20, category: 10 });

/**
 * The part of a host that identifies the service: its labels without the
 * domain suffix, so "nextcloud.home.arpa" gives ["nextcloud"] and a query
 * never matches the shared suffix ("arpa", "example", "com"). IP addresses and
 * single-label hosts are kept whole.
 * @param {string} host host with an optional port
 * @returns {string[]}
 */
export function hostLabels(host) {
  const bare = host.toLowerCase().replace(/:\d+$/, '');
  if (!bare) return [];
  if (/^[\d.]+$/.test(bare) || bare.includes(':') || !bare.includes('.')) return [bare];
  const labels = bare.split('.').filter(Boolean);
  return labels.slice(0, labels.length >= 3 ? labels.length - 2 : labels.length - 1);
}

/** @param {string} text @param {string} word */
function hasWordStart(text, word) {
  return text.split(/[^\p{L}\p{N}]+/u).some((t) => t.startsWith(word));
}

/**
 * Score of one query word against one service, or 0 for no match.
 * Order: name prefix > name word start > name substring > host label start
 * and description word start > host / description substring > category.
 * There is no fuzzy or subsequence matching.
 * @param {{ name: string, desc: string, labels: string[], category: string }} f lower-cased fields
 * @param {string} w lower-cased query word
 */
function scoreWord(f, w) {
  if (f.name.startsWith(w)) return TIER.namePrefix;
  if (hasWordStart(f.name, w)) return TIER.nameWord;
  if (f.name.includes(w)) return TIER.nameSub;
  if (f.labels.some((l) => hasWordStart(l, w))) return TIER.hostWord;
  if (hasWordStart(f.desc, w)) return TIER.descWord;
  if (f.labels.some((l) => l.includes(w))) return TIER.hostSub;
  if (f.desc.includes(w)) return TIER.descSub;
  // Category only by prefix and from 4 letters, so "pro" does not pull in every "Productivity" service.
  if (w.length >= 4 && f.category.startsWith(w)) return TIER.category;
  return 0;
}

/**
 * Ranks services against a free-text query. Every query word must match the
 * name, description, host or category (see scoreWord); name matches rank first.
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
    const f = { name: s.name.toLowerCase(), desc: (s.description || '').toLowerCase(), labels: hostLabels(hostOf(s.url)), category: resolveCategory(s).toLowerCase() };
    let score = 0;
    for (const w of words) {
      const part = scoreWord(f, w);
      if (!part) {
        score = 0;
        break;
      }
      score += part;
    }
    if (score) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map((x) => x.s);
}
