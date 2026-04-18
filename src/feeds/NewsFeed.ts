/**
 * NewsFeed.ts — Flux RSS multi-sources pour signaux événementiels
 *
 * Rôle :
 *   Surveiller les flux d'actualités librement accessibles.
 *   Quand un titre correspond à un marché tracké → déclencher
 *   une réévaluation immédiate (contourne le debounce WS).
 *
 * Sources configurables via NEWS_RSS_FEEDS (CSV dans .env) :
 *   Par défaut :
 *     - CoinTelegraph  (crypto)
 *     - Reuters Business
 *     - BBC News
 *     - Google News Search (BTC, ETH)
 *
 * Parser RSS : aucune dépendance externe, regex sur XML/Atom.
 *
 * Events émis :
 *   'match' — NewsMatch (titre + marché lié)
 *   'error' — Error
 */
import { EventEmitter } from 'events';
import { getLogger }    from '../utils/logger';
import type { CachedMarket } from './MarketCache';

const log = getLogger('NewsFeed');

const DEFAULT_FEEDS = [
  'https://cointelegraph.com/rss',
  'https://feeds.reuters.com/reuters/businessNews',
  'https://feeds.bbci.co.uk/news/business/rss.xml',
  'https://news.google.com/rss/search?q=bitcoin+crypto&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=prediction+market+polymarket&hl=en-US&gl=US&ceid=US:en',
];

const POLL_INTERVAL_MS = parseInt(process.env.NEWS_POLL_S ?? '60', 10) * 1_000;
const REQ_TIMEOUT      = 10_000;

export interface NewsItem {
  title:   string;
  link:    string;
  pubDate: string;
  source:  string;
}

export interface NewsMatch {
  item:    NewsItem;
  market:  CachedMarket;
  score:   number;    // 0-1, proportion de mots-clés matchés
}

export class NewsFeed extends EventEmitter {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly feedUrls: string[];
  private readonly seenLinks = new Set<string>();   // évite les doublons

  constructor() {
    super();
    const envFeeds = process.env.NEWS_RSS_FEEDS;
    this.feedUrls  = envFeeds
      ? envFeeds.split(',').map(s => s.trim()).filter(Boolean)
      : DEFAULT_FEEDS;

    log.info(`NewsFeed — ${this.feedUrls.length} source(s) configurée(s)`);
  }

  // ── Démarrer / Arrêter le polling ─────────────────────────────
  start(getMarkets: () => CachedMarket[]): void {
    this._poll(getMarkets);   // premier poll immédiat
    this.pollTimer = setInterval(
      () => this._poll(getMarkets),
      POLL_INTERVAL_MS,
    );
    log.info(`NewsFeed — polling toutes les ${POLL_INTERVAL_MS / 1000}s`);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ── Cycle de polling ──────────────────────────────────────────
  private async _poll(getMarkets: () => CachedMarket[]): Promise<void> {
    const markets = getMarkets();
    if (markets.length === 0) return;

    let totalNew = 0;

    await Promise.allSettled(
      this.feedUrls.map(async url => {
        try {
          const items = await this._fetchFeed(url);
          for (const item of items) {
            if (this.seenLinks.has(item.link)) continue;
            this.seenLinks.add(item.link);
            totalNew++;

            const match = this._matchMarket(item, markets);
            if (match) {
              log.info('📰 News → marché lié', {
                source:   item.source,
                headline: item.title.substring(0, 80),
                market:   match.market.question.substring(0, 60),
                score:    (match.score * 100).toFixed(0) + '%',
              });
              this.emit('match', match);
            }
          }
        } catch (e: any) {
          log.debug(`NewsFeed — erreur source`, { url: url.substring(0, 50), err: e.message });
        }
      }),
    );

    // Purge des liens vus (garde les 5000 plus récents)
    if (this.seenLinks.size > 5_000) {
      const arr = [...this.seenLinks];
      this.seenLinks.clear();
      arr.slice(-2_000).forEach(l => this.seenLinks.add(l));
    }

    if (totalNew > 0) log.debug(`NewsFeed — ${totalNew} nouveaux item(s) analysés`);
  }

  // ── Récupération + parsing RSS ────────────────────────────────
  private async _fetchFeed(url: string): Promise<NewsItem[]> {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'polybot/2.0', 'Accept': 'application/rss+xml, application/xml, text/xml' },
      signal:  AbortSignal.timeout(REQ_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return this._parseRss(xml, url);
  }

  // Parser RSS/Atom minimal — aucune dépendance
  private _parseRss(xml: string, sourceUrl: string): NewsItem[] {
    const items: NewsItem[] = [];
    const source = new URL(sourceUrl).hostname.replace('www.', '');

    // Supporte <item> (RSS 2.0) et <entry> (Atom)
    const itemRx = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
    let   block: RegExpExecArray | null;

    while ((block = itemRx.exec(xml)) !== null) {
      const body = block[1];

      const title = this._extract(body, 'title');
      const link  = this._extract(body, 'link')
                 || this._extractAttr(body, 'link', 'href');
      const pub   = this._extract(body, 'pubDate')
                 || this._extract(body, 'published')
                 || this._extract(body, 'updated');

      if (!title || !link) continue;

      items.push({ title, link, pubDate: pub, source });
    }

    return items;
  }

  // Extrait le contenu d'un tag (gère CDATA)
  private _extract(xml: string, tag: string): string {
    const rx = new RegExp(
      `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))<\\/${tag}>`,
      'i',
    );
    const m = rx.exec(xml);
    return (m?.[1] ?? m?.[2] ?? '').trim();
  }

  // Extrait un attribut (ex: <link href="..."/>)
  private _extractAttr(xml: string, tag: string, attr: string): string {
    const rx = new RegExp(`<${tag}[^>]+${attr}="([^"]+)"`, 'i');
    return xml.match(rx)?.[1]?.trim() ?? '';
  }

  // ── Matching news ↔ marché ────────────────────────────────────
  private _matchMarket(item: NewsItem, markets: CachedMarket[]): NewsMatch | null {
    const haystack = (item.title + ' ' + item.link).toLowerCase();

    let bestMatch: NewsMatch | null = null;

    for (const market of markets) {
      const score = this._scoreMatch(haystack, market);
      if (score >= 0.35 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { item, market, score };
      }
    }
    return bestMatch;
  }

  private _scoreMatch(newsText: string, market: CachedMarket): number {
    const keywords = market.question
      .toLowerCase()
      .replace(/[^a-z0-9\s$]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w));

    if (keywords.length === 0) return 0;

    const matched = keywords.filter(w => newsText.includes(w));
    return matched.length / keywords.length;
  }
}

const STOPWORDS = new Set([
  'will', 'the', 'that', 'this', 'with', 'from', 'have', 'been',
  'than', 'more', 'some', 'when', 'what', 'which', 'there', 'their',
  'before', 'after', 'above', 'below', 'over', 'under', 'into', 'onto',
  'close', 'above', 'below', 'price', 'market', 'end', 'year', 'month',
]);
