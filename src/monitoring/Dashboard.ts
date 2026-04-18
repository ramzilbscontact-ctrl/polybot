/**
 * Dashboard.ts — Serveur HTTP de monitoring
 *
 * Endpoints :
 *   GET /          → page HTML auto-refresh (10s)
 *   GET /stats     → JSON stats en temps réel
 *   GET /health    → { ok: true, uptime }
 *
 * Port : DASHBOARD_PORT (défaut 3000)
 * Pas de dépendance externe — http natif Node.js uniquement.
 */
import * as http from 'http';
import { getLogger } from '../utils/logger';

const log = getLogger('Dashboard');

// ── Types publics ─────────────────────────────────────────────────
export interface DashboardStats {
  mode:          string;
  uptime:        string;
  startedAt:     string;
  // Polymarket
  cachedMarkets: number;
  subscriptions: number;
  wsSignals:     number;
  newsHits:      number;
  manifoldConf:  number;
  rescans:       number;
  // Paper P&L
  paperTrades:   number;
  paperResolved: number;
  paperWins:     number;
  paperLosses:   number;
  paperWinRate:  string;
  paperPnl:      number;
  paperPnlStr:   string;
  // Feeds
  binancePrices: Record<string, number>;
  // Events récents
  recentEvents:  EventEntry[];
}

export interface EventEntry {
  ts:      string;
  type:    'signal' | 'news' | 'manifold' | 'win' | 'loss' | 'system';
  message: string;
}

// ── Ring buffer d'événements ──────────────────────────────────────
export class EventLog {
  private readonly buf: EventEntry[] = [];
  private readonly max: number;

  constructor(max = 50) { this.max = max; }

  push(type: EventEntry['type'], message: string): void {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    this.buf.unshift({ ts, type, message });
    if (this.buf.length > this.max) this.buf.pop();
  }

  get entries(): EventEntry[] { return [...this.buf]; }
}

// ── Serveur Dashboard ─────────────────────────────────────────────
export class Dashboard {
  private server: http.Server | null = null;
  private readonly port: number;
  private readonly startedAt = new Date().toISOString();

  constructor() {
    this.port = parseInt(process.env.DASHBOARD_PORT ?? '3000', 10);
  }

  start(getStats: () => DashboardStats): void {
    this.server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uptime: process.uptime().toFixed(0) + 's' }));
        return;
      }

      if (url === '/stats') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(getStats(), null, 2));
        return;
      }

      if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this._html());
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.server.listen(this.port, () => {
      log.info(`Dashboard — http://localhost:${this.port}`);
    });

    this.server.on('error', (e: any) => {
      if (e.code === 'EADDRINUSE') {
        log.warn(`Dashboard — port ${this.port} déjà utilisé, dashboard désactivé`);
      } else {
        log.error('Dashboard — erreur serveur', { error: e.message });
      }
    });
  }

  stop(): void { this.server?.close(); }

  // ── Page HTML ─────────────────────────────────────────────────
  private _html(): string {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Polybot Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { darkMode: 'class' };
    document.documentElement.classList.add('dark');
  </script>
  <style>
    body { background: #0f172a; color: #e2e8f0; font-family: 'Courier New', monospace; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; }
    .pnl-pos { color: #4ade80; }
    .pnl-neg { color: #f87171; }
    .badge-signal   { background: #1d4ed8; color: #bfdbfe; }
    .badge-news     { background: #065f46; color: #a7f3d0; }
    .badge-manifold { background: #4c1d95; color: #ddd6fe; }
    .badge-win      { background: #14532d; color: #86efac; }
    .badge-loss     { background: #7f1d1d; color: #fca5a5; }
    .badge-system   { background: #1e3a5f; color: #93c5fd; }
  </style>
</head>
<body class="min-h-screen p-6">

  <div class="max-w-5xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-white">🤖 Polybot Dashboard</h1>
        <p class="text-slate-400 text-sm mt-1" id="subtitle">Chargement...</p>
      </div>
      <div class="text-right">
        <div class="text-slate-400 text-xs" id="last-update">—</div>
        <div class="w-2 h-2 rounded-full bg-green-400 inline-block ml-2 animate-pulse"></div>
      </div>
    </div>

    <!-- P&L principal -->
    <div class="card mb-4 text-center">
      <div class="text-slate-400 text-sm mb-1">Paper P&L cumulatif</div>
      <div class="text-5xl font-bold" id="pnl-main">—</div>
      <div class="text-slate-400 text-sm mt-2" id="pnl-sub">—</div>
    </div>

    <!-- Grille stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <div class="card text-center">
        <div class="text-2xl font-bold text-white" id="stat-trades">—</div>
        <div class="text-slate-400 text-xs mt-1">Trades</div>
      </div>
      <div class="card text-center">
        <div class="text-2xl font-bold text-white" id="stat-winrate">—</div>
        <div class="text-slate-400 text-xs mt-1">Win Rate</div>
      </div>
      <div class="card text-center">
        <div class="text-2xl font-bold text-white" id="stat-ws">—</div>
        <div class="text-slate-400 text-xs mt-1">Signaux WS</div>
      </div>
      <div class="card text-center">
        <div class="text-2xl font-bold text-white" id="stat-news">—</div>
        <div class="text-slate-400 text-xs mt-1">News hits</div>
      </div>
    </div>

    <!-- Feeds status -->
    <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
      <div class="card">
        <div class="text-slate-400 text-xs mb-2">Marchés en cache</div>
        <div class="text-lg font-bold" id="feed-cache">—</div>
      </div>
      <div class="card">
        <div class="text-slate-400 text-xs mb-2">Manifold confirmés</div>
        <div class="text-lg font-bold text-purple-400" id="feed-manifold">—</div>
      </div>
      <div class="card">
        <div class="text-slate-400 text-xs mb-2">Prix crypto live</div>
        <div class="text-xs text-green-400" id="feed-binance">—</div>
      </div>
    </div>

    <!-- Events récents -->
    <div class="card">
      <div class="text-slate-400 text-xs mb-3">Événements récents</div>
      <div id="events-list" class="space-y-1 text-sm max-h-80 overflow-y-auto">
        <div class="text-slate-500">Chargement...</div>
      </div>
    </div>
  </div>

  <script>
    const BADGE = {
      signal:   'badge-signal',
      news:     'badge-news',
      manifold: 'badge-manifold',
      win:      'badge-win',
      loss:     'badge-loss',
      system:   'badge-system',
    };

    async function refresh() {
      try {
        const res  = await fetch('/stats');
        const data = await res.json();

        // P&L
        const pnl    = data.paperPnl ?? 0;
        const pnlEl  = document.getElementById('pnl-main');
        pnlEl.textContent = data.paperPnlStr ?? '0.0000 USDC.e';
        pnlEl.className   = 'text-5xl font-bold ' + (pnl >= 0 ? 'pnl-pos' : 'pnl-neg');

        document.getElementById('pnl-sub').textContent =
          data.paperWins + 'W / ' + data.paperLosses + 'L — ' + data.paperWinRate;

        // Stats
        document.getElementById('stat-trades').textContent  = data.paperTrades ?? 0;
        document.getElementById('stat-winrate').textContent = data.paperWinRate ?? 'N/A';
        document.getElementById('stat-ws').textContent      = data.wsSignals ?? 0;
        document.getElementById('stat-news').textContent    = data.newsHits ?? 0;

        // Feeds
        document.getElementById('feed-cache').textContent    = (data.cachedMarkets ?? 0) + ' marchés';
        document.getElementById('feed-manifold').textContent = (data.manifoldConf ?? 0) + ' signaux';

        const prices = data.binancePrices ?? {};
        document.getElementById('feed-binance').innerHTML = Object.entries(prices)
          .map(([t, p]) => \`<span class="mr-2"><b>\${t}</b> \${Number(p).toLocaleString('en-US', {maximumFractionDigits: 2})}$</span>\`)
          .join('');

        // Header
        document.getElementById('subtitle').textContent =
          data.mode + ' · Uptime ' + data.uptime + ' · Rescans ' + data.rescans;
        document.getElementById('last-update').textContent =
          'Mise à jour ' + new Date().toLocaleTimeString('fr-FR');

        // Events
        const evEl = document.getElementById('events-list');
        if (data.recentEvents && data.recentEvents.length) {
          evEl.innerHTML = data.recentEvents.map(e =>
            \`<div class="flex items-start gap-2">
              <span class="text-slate-500 text-xs whitespace-nowrap mt-0.5">\${e.ts}</span>
              <span class="badge-\${e.type} text-xs px-1.5 py-0.5 rounded whitespace-nowrap">\${e.type}</span>
              <span class="text-slate-300 text-xs">\${e.message}</span>
            </div>\`
          ).join('');
        }
      } catch(e) {
        document.getElementById('last-update').textContent = 'Erreur connexion';
      }
    }

    refresh();
    setInterval(refresh, 10_000);
  </script>
</body>
</html>`;
  }
}
