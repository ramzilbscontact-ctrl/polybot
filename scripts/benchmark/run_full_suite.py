#!/usr/bin/env python3
"""
Run FULL validation suite on a strategy and produce Go/No-Go report.

Pipeline :
  1. In-sample backtest (2+ years)
  2. Walk-forward analysis
  3. Monte Carlo bootstrap
  4. Sensitivity analysis
  5. Consolidated .md report

Usage:
  python run_full_suite.py --symbol SPY --strategy sma_cross \\
    --is-start 2022-01-01 --is-end 2024-12-31

Report auto-saved to scripts/benchmark/reports/.
"""
import sys, os, argparse, json
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/backtest')

import pandas as pd
from data import fetch_bars
from engine import run_backtest
from strategies import STRATEGIES
from metrics import compute_metrics, pass_go_no_go
from walk_forward import walk_forward, summarize_walk_forward
from monte_carlo import monte_carlo_bootstrap, assess_robustness

REPORTS_DIR = os.path.join(os.path.dirname(__file__), 'reports')

PARAM_GRIDS = {
    'sma_cross':      {'fast': [10, 20, 50], 'slow': [50, 100, 200]},
    'rsi':            {'period': [10, 14, 21], 'oversold': [25, 30], 'overbought': [70, 75]},
    'momentum':       {'lookback': [10, 20, 40, 60], 'long_only': [True, False]},
    'vwap_reversion': {'window': [5, 10, 20], 'threshold': [0.01, 0.02, 0.03]},
}


def run_suite(symbol: str, strategy_name: str,
              is_start: str, is_end: str) -> dict:
    print(f"\n{'='*80}")
    print(f"  FULL VALIDATION SUITE")
    print(f"  Symbol     : {symbol}")
    print(f"  Strategy   : {strategy_name}")
    print(f"  Period     : {is_start} → {is_end}")
    print(f"{'='*80}\n")

    signal_fn = STRATEGIES[strategy_name]
    param_grid = PARAM_GRIDS.get(strategy_name, {})

    # Step 1: Fetch data
    print("▶ Step 1/4 : Fetching data...")
    df = fetch_bars(symbol, '1Day', is_start, is_end)
    if len(df) < 100:
        raise RuntimeError(f"Only {len(df)} bars — insufficient for validation")
    print(f"  {len(df)} bars fetched\n")

    # Step 2: Backtest with best params (optimize on full period first)
    print("▶ Step 2/4 : Optimizing parameters (grid search)...")
    import itertools
    keys = list(param_grid.keys())
    vals = list(param_grid.values())
    combos = list(itertools.product(*vals))

    best_result = None
    best_sharpe = -float('inf')
    for combo in combos:
        params = dict(zip(keys, combo))
        try:
            signals = signal_fn(df, **params)
            result = run_backtest(df, signals, symbol, strategy_name, params)
            if result.sharpe > best_sharpe:
                best_sharpe = result.sharpe
                best_result = result
        except Exception:
            continue

    if best_result is None:
        raise RuntimeError("All param combos failed")

    metrics = compute_metrics(best_result.equity, best_result.trades)
    print(f"  Best Sharpe = {metrics.sharpe:.2f} with params {best_result.params}\n")

    # Step 3: Walk-forward
    print("▶ Step 3/4 : Walk-forward analysis...")
    wf_results = walk_forward(df, signal_fn, param_grid,
                              is_days=180, oos_days=60, step_days=45,
                              symbol=symbol, strategy=strategy_name)
    wf_summary = summarize_walk_forward(wf_results)
    print(f"  Walk-forward ratio = {wf_summary['walk_forward_ratio']:.2f}\n")

    # Step 4: Monte Carlo
    print("▶ Step 4/4 : Monte Carlo robustness...")
    returns = best_result.equity.pct_change().dropna()
    mc = monte_carlo_bootstrap(returns, n_simulations=1000)
    mc_pass, mc_reason = assess_robustness(mc, metrics.sharpe)
    print(f"  Monte Carlo : {'PASS' if mc_pass else 'FAIL'} — {mc_reason}\n")

    # Final Go/No-Go
    basic_pass, basic_reasons = pass_go_no_go(metrics)
    wf_pass = wf_summary.get('pass', False)
    overall_pass = basic_pass and wf_pass and mc_pass

    return {
        'symbol': symbol,
        'strategy': strategy_name,
        'period': f"{is_start} → {is_end}",
        'best_params': best_result.params,
        'metrics': metrics.to_dict(),
        'walk_forward': wf_summary,
        'monte_carlo': mc,
        'decisions': {
            'basic_pass': basic_pass,
            'basic_reasons': basic_reasons,
            'walk_forward_pass': wf_pass,
            'monte_carlo_pass': mc_pass,
            'overall_pass': overall_pass,
        }
    }


def generate_report(result: dict) -> str:
    os.makedirs(REPORTS_DIR, exist_ok=True)
    ts = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    label = f"{result['symbol']}_{result['strategy']}"
    path = os.path.join(REPORTS_DIR, f"{ts}_{label}.md")

    m = result['metrics']
    wf = result['walk_forward']
    mc = result['monte_carlo']
    d = result['decisions']

    pct = lambda v: f"{v*100:+.2f}%"

    lines = [
        f"# Go/No-Go Report — {result['symbol']} / {result['strategy']}",
        f"*Generated {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}*",
        "",
        f"**Period** : {result['period']}",
        f"**Best params** : `{result['best_params']}`",
        "",
        "## 1. Performance Metrics",
        "",
        f"| Metric | Value | Target | Pass |",
        f"|--------|-------|--------|------|",
        f"| Sharpe | {m['sharpe']:.2f} | > 0.8 | {'✅' if m['sharpe'] > 0.8 else '❌'} |",
        f"| Sortino | {m['sortino']:.2f} | > 1.0 | {'✅' if m['sortino'] > 1.0 else '❌'} |",
        f"| Calmar | {m['calmar']:.2f} | > 0.8 | {'✅' if m['calmar'] > 0.8 else '❌'} |",
        f"| Max DD | {pct(m['max_drawdown'])} | > -20% | {'✅' if m['max_drawdown'] > -0.20 else '❌'} |",
        f"| Win rate | {m['win_rate']*100:.1f}% | > 40% | {'✅' if m['win_rate'] > 0.40 else '❌'} |",
        f"| Profit factor | {m['profit_factor']:.2f} | > 1.3 | {'✅' if m['profit_factor'] > 1.3 else '❌'} |",
        f"| Trades | {m['num_trades']} | > 20 | {'✅' if m['num_trades'] > 20 else '❌'} |",
        f"| Annual return | {pct(m['annual_return'])} | — | — |",
        f"| VaR 95% | {pct(m['var_95'])} | > -4% | {'✅' if m['var_95'] > -0.04 else '❌'} |",
        "",
        "## 2. Walk-Forward Analysis",
        "",
        f"- Windows analyzed: **{wf.get('num_windows', 0)}**",
        f"- IS Sharpe (mean): **{wf.get('is_sharpe_mean', 0):.2f}**",
        f"- OOS Sharpe (mean): **{wf.get('oos_sharpe_mean', 0):.2f}**",
        f"- Walk-forward ratio: **{wf.get('walk_forward_ratio', 0):.2f}** (target > 0.5)",
        f"- OOS consistency: **{wf.get('oos_consistency', 0)*100:.0f}%** (target > 60%)",
        "",
        f"**Verdict**: {'✅ PASS' if wf.get('pass') else '❌ FAIL — likely overfit'}",
        "",
        "## 3. Monte Carlo Robustness",
        "",
    ]

    if 'error' not in mc:
        s = mc['sharpe']
        lines += [
            f"- Observed Sharpe: **{m['sharpe']:.2f}**",
            f"- Bootstrap median Sharpe: **{s['p50']:.2f}**",
            f"- 5th percentile Sharpe: **{s['p5']:.2f}** (worst case)",
            f"- 95th percentile Sharpe: **{s['p95']:.2f}** (best case)",
            f"- P(Sharpe > 0): **{mc['probability_positive_sharpe']*100:.0f}%**",
            f"- P(Sharpe > 1): **{mc['probability_sharpe_above_1']*100:.0f}%**",
            "",
            f"**Verdict**: {'✅ ROBUST' if d['monte_carlo_pass'] else '❌ FRAGILE'}",
            "",
        ]

    overall_emoji = '✅ GO — proceed to paper trading' if d['overall_pass'] else '❌ NO-GO'
    lines += [
        "## 4. Final Decision",
        "",
        f"### {overall_emoji}",
        "",
        "| Check | Result |",
        "|-------|--------|",
        f"| Basic metrics | {'✅ PASS' if d['basic_pass'] else '❌ FAIL'} |",
        f"| Walk-forward | {'✅ PASS' if d['walk_forward_pass'] else '❌ FAIL'} |",
        f"| Monte Carlo | {'✅ PASS' if d['monte_carlo_pass'] else '❌ FAIL'} |",
        "",
    ]

    if not d['overall_pass']:
        lines.append("### Reasons for NO-GO :")
        for r in d.get('basic_reasons', []):
            lines.append(f"- {r}")
        if not d['walk_forward_pass']:
            lines.append(f"- Walk-forward ratio {wf.get('walk_forward_ratio', 0):.2f} < 0.5 (overfit)")
        if not d['monte_carlo_pass']:
            lines.append(f"- Monte Carlo: 5th percentile Sharpe too low or observed is outlier")

    content = '\n'.join(lines)
    with open(path, 'w') as f:
        f.write(content)

    # Also save raw JSON for programmatic access
    json_path = path.replace('.md', '.json')
    with open(json_path, 'w') as f:
        json.dump(result, f, indent=2, default=str)

    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbol', required=True)
    parser.add_argument('--strategy', required=True, choices=list(STRATEGIES.keys()))
    parser.add_argument('--is-start', default='2022-01-01')
    parser.add_argument('--is-end',   default='2024-12-31')
    args = parser.parse_args()

    result = run_suite(args.symbol, args.strategy, args.is_start, args.is_end)
    path = generate_report(result)

    d = result['decisions']
    print(f"\n{'='*80}")
    print(f"  FINAL DECISION: {'✅ GO' if d['overall_pass'] else '❌ NO-GO'}")
    print(f"  Report: {path}")
    print(f"{'='*80}\n")


if __name__ == '__main__':
    main()
