#!/usr/bin/env python3
"""
Polybot backtester — main entry point.

Usage:
  python run.py                          # all strategies, default symbols
  python run.py --symbols AAPL MSFT SPY  # specific symbols
  python run.py --strategy sma_cross     # single strategy
  python run.py --start 2022-01-01       # custom date range
  python run.py --optimize               # grid-search best params
  python run.py --timeframe 1Hour        # intraday (uses last 30 days)

Output: scripts/backtest/reports/<timestamp>_<label>.md
"""
import sys, os, argparse
sys.path.insert(0, os.path.dirname(__file__))

import pandas as pd
from data       import fetch_multi
from engine     import run_backtest
from report     import generate_report
from optimize   import grid_search
from strategies import STRATEGIES

# ── Default universe ──────────────────────────────────────────────────────────
DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA']

# ── Parameter grids for optimization ─────────────────────────────────────────
PARAM_GRIDS = {
    'sma_cross':      {'fast': [10, 20, 50], 'slow': [50, 100, 200]},
    'rsi':            {'period': [10, 14, 21], 'oversold': [25, 30], 'overbought': [70, 75]},
    'momentum':       {'lookback': [10, 20, 40, 60], 'long_only': [True, False]},
    'vwap_reversion': {'window': [5, 10, 20], 'threshold': [0.01, 0.02, 0.03]},
}

# ── Default params (best known) ───────────────────────────────────────────────
DEFAULT_PARAMS = {
    'sma_cross':      {'fast': 20, 'slow': 50},
    'rsi':            {'period': 14, 'oversold': 30, 'overbought': 70},
    'momentum':       {'lookback': 20, 'long_only': True},
    'vwap_reversion': {'window': 10, 'threshold': 0.02},
}


def main():
    parser = argparse.ArgumentParser(description='Polybot backtester')
    parser.add_argument('--symbols',   nargs='+', default=DEFAULT_SYMBOLS)
    parser.add_argument('--strategy',  default=None, help='single strategy name')
    parser.add_argument('--start',     default='2022-01-01')
    parser.add_argument('--end',       default=None)
    parser.add_argument('--timeframe', default='1Day')
    parser.add_argument('--capital',   type=float, default=10_000)
    parser.add_argument('--optimize',  action='store_true')
    args = parser.parse_args()

    strategies = {args.strategy: STRATEGIES[args.strategy]} if args.strategy else STRATEGIES

    print(f"\n{'='*60}")
    print(f"  Polybot Backtester")
    print(f"  Symbols   : {', '.join(args.symbols)}")
    print(f"  Strategies: {', '.join(strategies.keys())}")
    print(f"  Period    : {args.start} → {args.end or 'today'}")
    print(f"  Optimize  : {args.optimize}")
    print(f"{'='*60}\n")

    # Fetch data
    print("Fetching market data from Alpaca...")
    data = fetch_multi(args.symbols, args.timeframe, args.start, args.end)
    print()

    all_results = []

    for sym, df in data.items():
        if df.empty:
            print(f"  {sym}: no data, skipping")
            continue

        print(f"\n── {sym} ({len(df)} bars) ──")

        for strat_name, signal_fn in strategies.items():
            if args.optimize:
                grid = PARAM_GRIDS.get(strat_name, {})
                if not grid:
                    print(f"  {strat_name}: no param grid defined")
                    continue
                results = grid_search(df, sym, strat_name, signal_fn, grid,
                                      args.capital)
                if results:
                    best = results[0]
                    all_results.append(best)
                    print(f"  {strat_name} best: Sharpe={best.sharpe:.2f} "
                          f"Ann={best.annual_return*100:.1f}% "
                          f"params={best.params}")
            else:
                params = DEFAULT_PARAMS.get(strat_name, {})
                try:
                    signals = signal_fn(df, **params)
                    result  = run_backtest(df, signals, sym, strat_name, params,
                                           args.capital)
                    all_results.append(result)
                    print(f"  {strat_name}: Sharpe={result.sharpe:.2f} "
                          f"Ann={result.annual_return*100:.1f}% "
                          f"MaxDD={result.max_drawdown*100:.1f}%")
                except Exception as e:
                    print(f"  {strat_name}: ERROR — {e}")

    if not all_results:
        print("\nNo results generated.")
        return

    # Generate report
    label = (args.strategy or 'all_strategies') + ('_optimized' if args.optimize else '')
    path  = generate_report(all_results, label)
    print(f"\n{'='*60}")
    print(f"  Report saved: {path}")
    print(f"{'='*60}\n")


if __name__ == '__main__':
    main()
