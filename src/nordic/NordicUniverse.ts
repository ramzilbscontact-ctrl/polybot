/**
 * NordicUniverse.ts — Univers des actions nordiques suivies
 *
 * Marchés couverts :
 *   Nasdaq Helsinki (SFB) — avantage géographique maximal depuis Helsinki
 *   Nasdaq Stockholm (NSQ) — 3-5ms depuis Helsinki
 *
 * Beta : sensibilité de l'action aux mouvements de l'index de référence.
 *   Beta = 1.2 → l'action monte 1.2% quand l'index monte 1%
 *   Utilisé par StatArbStrategy pour calculer le retour attendu.
 *
 * ConIDs IBKR : identifiant unique du contrat (contract ID).
 *   Vérifier/mettre à jour via GET /v1/api/iserver/secdef/search?symbol=NOK1V
 */

export interface NordicStock {
  symbol:    string;   // Ticker sur le marché local
  name:      string;
  exchange:  string;   // Code échange IBKR
  currency:  string;
  conid:     number;   // IBKR Contract ID (vérifier via API search)
  beta:      number;   // Beta vs index de référence (estimé 12 mois)
  index:     'OMXH25' | 'OMXS30';  // Index de référence
  sector:    string;
  keywords:  string[]; // Mots-clés pour matching news
}

// ── Index de référence ─────────────────────────────────────────────
export const INDICES = {
  OMXH25: { symbol: 'OMXH25', name: 'OMX Helsinki 25', conid: 34454687, exchange: 'SFB' },
  OMXS30: { symbol: 'OMXS30', name: 'OMX Stockholm 30', conid: 34454,   exchange: 'NSQ' },
} as const;

// ── Actions Helsinki (avantage latence maximal) ───────────────────
export const HELSINKI_STOCKS: NordicStock[] = [
  {
    symbol: 'NOK1V', name: 'Nokia',    exchange: 'SFB', currency: 'EUR',
    conid: 38708077,  beta: 0.85,  index: 'OMXH25',
    sector: 'Technology',
    keywords: ['nokia', 'network', '5g', 'telecom', 'infrastructure'],
  },
  {
    symbol: 'KNEBV', name: 'KONE',     exchange: 'SFB', currency: 'EUR',
    conid: 38708123,  beta: 0.72,  index: 'OMXH25',
    sector: 'Industrials',
    keywords: ['kone', 'elevator', 'escalator', 'building', 'ascenseur'],
  },
  {
    symbol: 'NESTE',  name: 'Neste',   exchange: 'SFB', currency: 'EUR',
    conid: 199267894, beta: 0.90,  index: 'OMXH25',
    sector: 'Energy',
    keywords: ['neste', 'renewable', 'fuel', 'oil', 'biofuel', 'saf'],
  },
  {
    symbol: 'SAMPO',  name: 'Sampo',   exchange: 'SFB', currency: 'EUR',
    conid: 38708201,  beta: 0.78,  index: 'OMXH25',
    sector: 'Financials',
    keywords: ['sampo', 'insurance', 'if', 'topdanmark', 'hastings'],
  },
  {
    symbol: 'UPM',    name: 'UPM-Kymmene', exchange: 'SFB', currency: 'EUR',
    conid: 38708244,  beta: 0.82,  index: 'OMXH25',
    sector: 'Materials',
    keywords: ['upm', 'paper', 'pulp', 'forest', 'biomaterials'],
  },
  {
    symbol: 'STERV',  name: 'Stora Enso', exchange: 'SFB', currency: 'EUR',
    conid: 38708456,  beta: 0.76,  index: 'OMXH25',
    sector: 'Materials',
    keywords: ['stora', 'enso', 'packaging', 'paper', 'forest'],
  },
  {
    symbol: 'WRT1V',  name: 'Wärtsilä', exchange: 'SFB', currency: 'EUR',
    conid: 38708512,  beta: 0.95,  index: 'OMXH25',
    sector: 'Industrials',
    keywords: ['wartsila', 'wärtsilä', 'marine', 'engine', 'energy'],
  },
];

// ── Actions Stockholm ────────────────────────────────────────────
export const STOCKHOLM_STOCKS: NordicStock[] = [
  {
    symbol: 'ERIC B', name: 'Ericsson',  exchange: 'NSQ', currency: 'SEK',
    conid: 10820,     beta: 1.05,  index: 'OMXS30',
    sector: 'Technology',
    keywords: ['ericsson', '5g', 'network', 'telecom', 'radio'],
  },
  {
    symbol: 'VOLV B', name: 'Volvo',     exchange: 'NSQ', currency: 'SEK',
    conid: 13528,     beta: 1.10,  index: 'OMXS30',
    sector: 'Industrials',
    keywords: ['volvo', 'truck', 'bus', 'construction', 'vehicles'],
  },
  {
    symbol: 'NDA SE', name: 'Nordea',    exchange: 'NSQ', currency: 'SEK',
    conid: 259118,    beta: 0.98,  index: 'OMXS30',
    sector: 'Financials',
    keywords: ['nordea', 'bank', 'banking', 'financial', 'nordic'],
  },
  {
    symbol: 'HM B',   name: 'H&M',       exchange: 'NSQ', currency: 'SEK',
    conid: 9695,      beta: 0.88,  index: 'OMXS30',
    sector: 'Consumer',
    keywords: ['h&m', 'hennes', 'mauritz', 'fashion', 'retail', 'clothing'],
  },
  {
    symbol: 'ATCO A', name: 'Atlas Copco', exchange: 'NSQ', currency: 'SEK',
    conid: 11870,     beta: 1.15,  index: 'OMXS30',
    sector: 'Industrials',
    keywords: ['atlas', 'copco', 'compressor', 'industrial', 'tools'],
  },
];

export const ALL_STOCKS = [...HELSINKI_STOCKS, ...STOCKHOLM_STOCKS];

// ── Lookup rapide ─────────────────────────────────────────────────
export const stockByConid = new Map<number, NordicStock>(
  ALL_STOCKS.map(s => [s.conid, s]),
);
export const stockBySymbol = new Map<string, NordicStock>(
  ALL_STOCKS.map(s => [s.symbol, s]),
);
