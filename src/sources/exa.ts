import type { Check } from '../case/types.js';

/** A live source found by Exa. It only SUPPORTS a curated check; it never changes the action text. */
export interface LiveSource {
  url: string;
  title: string;
  publishedDate: string | null;
  highlight: string;
  fetchedAt: string;
  startedFromPartial: boolean;
}
export interface LiveEntry {
  status: 'pending' | 'live' | 'unavailable';
  results: LiveSource[];
  ms?: number;
  startedFromPartial: boolean;
  at: number;
}

const QUERIES: Record<string, string> = {
  'android-credential-sync': 'Home Assistant Thread sync credentials Android Companion app',
  'ios-credential-sync': 'Home Assistant Thread credentials iPhone Companion app',
  'retry-pairing-once': 'Home Assistant Matter add device commissioning troubleshooting',
  'confirm-border-router': 'Home Assistant Thread border router integration',
  'apple-tv-3gen-wifi-only': 'Apple TV 4K third generation Thread Wi-Fi Ethernet model',
};

const cache = new Map<string, LiveEntry>();
const TTL = 10 * 60_000;
let inFlight = 0;

export function liveFor(checkId: string): LiveEntry | null {
  return cache.get(checkId) ?? null;
}

/** Fire-and-forget refresh for a check. Safe to call often: cached 10 min, at most 2 in flight, 4 s timeout. */
export function warm(check: Check, startedFromPartial = false): void {
  const key = process.env.EXA_API_KEY;
  if (!key) return;
  const hit = cache.get(check.id);
  if (hit && (hit.status === 'pending' || Date.now() - hit.at < TTL)) return;
  if (inFlight >= 2) return;
  const domains = [...new Set(check.sources.map((s) => new URL(s.url).hostname))];
  const entry: LiveEntry = { status: 'pending', results: [], startedFromPartial, at: Date.now() };
  cache.set(check.id, entry);
  inFlight += 1;
  const t0 = performance.now();
  const query = QUERIES[check.id] ?? check.actionText.slice(0, 120);
  const call = (withFreshness: boolean) =>
    fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({
        query,
        numResults: 3,
        includeDomains: domains,
        contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 }, ...(withFreshness ? { maxAgeHours: 24 } : {}) },
      }),
    });
  (async () => {
    let r = await call(true);
    if (r.status === 400) r = await call(false);
    if (!r.ok) throw new Error(`exa ${r.status}`);
    const j = (await r.json()) as { results?: Array<{ url?: string; title?: string; publishedDate?: string; highlights?: string[]; text?: string }> };
    const fetchedAt = new Date().toISOString();
    entry.results = (j.results ?? [])
      .filter((x) => x.url && domains.includes(new URL(x.url).hostname)) // off-domain results are dropped
      .map((x) => ({
        url: x.url!,
        title: x.title || x.url!,
        publishedDate: x.publishedDate ?? null, // never inferred from fetch time
        highlight: (x.highlights?.[0] ?? x.text ?? '').replace(/\s+/g, ' ').slice(0, 240),
        fetchedAt,
        startedFromPartial,
      }))
      .filter((x) => x.highlight);
    entry.status = entry.results.length ? 'live' : 'unavailable';
  })()
    .catch(() => {
      entry.status = 'unavailable';
    })
    .finally(() => {
      entry.ms = Math.round(performance.now() - t0);
      entry.at = Date.now();
      inFlight -= 1;
    });
}
