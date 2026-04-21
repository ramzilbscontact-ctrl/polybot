"""
Walk-forward analysis : rolling IS/OOS windows.
Détecte l'overfitting en comparant la perfo out-of-sample vs in-sample.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/backtest')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dataclasses import dataclass
from typing import Callable, Dict, List, Any
from datetime import timedelta
import pandas as pd
from metrics import compute_metrics, PerformanceMetrics
from engine import run_backtest


@dataclass
class WalkForwardResult:
    window_num: int
    is_start: str
    is_end: str
    oos_start: str
    oos_end: str
    best_params: dict
    is_sharpe: float
    oos_sharpe: float
    oos_return: float
    oos_max_dd: float


def walk_forward(df: pd.DataFrame,
                 signal_fn: Callable,
                 param_grid: Dict[str, List[Any]],
                 is_days: int = 180,
                 oos_days: int = 60,
                 step_days: int = 30,
                 symbol: str = '',
                 strategy: str = '') -> List[WalkForwardResult]:
    """
    Rolling window IS (in-sample) pour trouver best params → test OOS (out-of-sample).
    Retourne liste de résultats par window + résumé final.
    """
    import itertools
    results = []

    start = df.index.min()
    end = df.index.max()

    keys = list(param_grid.keys())
    values = list(param_grid.values())
    combos = list(itertools.product(*values))

    window_num = 0
    current_is_start = start

    while True:
        current_is_end = current_is_start + pd.Timedelta(days=is_days)
        current_oos_end = current_is_end + pd.Timedelta(days=oos_days)
        if current_oos_end > end:
            break

        window_num += 1
        is_df = df[(df.index >= current_is_start) & (df.index < current_is_end)]
        oos_df = df[(df.index >= current_is_end) & (df.index < current_oos_end)]

        # Find best params on IS
        best_sharpe = -float('inf')
        best_params = None
        for combo in combos:
            params = dict(zip(keys, combo))
            try:
                signals = signal_fn(is_df, **params)
                bt = run_backtest(is_df, signals, symbol, strategy, params)
                if bt.sharpe > best_sharpe:
                    best_sharpe = bt.sharpe
                    best_params = params
            except Exception:
                continue

        if best_params is None:
            current_is_start += pd.Timedelta(days=step_days)
            continue

        # Test best params on OOS
        try:
            oos_signals = signal_fn(oos_df, **best_params)
            oos_bt = run_backtest(oos_df, oos_signals, symbol, strategy, best_params)
            oos_metrics = compute_metrics(oos_bt.equity, oos_bt.trades)

            results.append(WalkForwardResult(
                window_num=window_num,
                is_start=str(current_is_start.date()),
                is_end=str(current_is_end.date()),
                oos_start=str(current_is_end.date()),
                oos_end=str(current_oos_end.date()),
                best_params=best_params,
                is_sharpe=best_sharpe,
                oos_sharpe=oos_metrics.sharpe,
                oos_return=oos_metrics.total_return,
                oos_max_dd=oos_metrics.max_drawdown,
            ))
        except Exception as e:
            print(f"  Window {window_num} OOS failed: {e}")

        current_is_start += pd.Timedelta(days=step_days)

    return results


def summarize_walk_forward(results: List[WalkForwardResult]) -> dict:
    if not results:
        return {'walk_forward_ratio': 0, 'oos_sharpe_mean': 0, 'oos_sharpe_std': 0,
                'oos_consistency': 0, 'pass': False}

    is_sharpes = [r.is_sharpe for r in results]
    oos_sharpes = [r.oos_sharpe for r in results]
    oos_returns = [r.oos_return for r in results]

    is_mean = sum(is_sharpes) / len(is_sharpes)
    oos_mean = sum(oos_sharpes) / len(oos_sharpes)
    # Avoid division by tiny or negative IS sharpe
    wf_ratio = oos_mean / is_mean if is_mean > 0.1 else (1.0 if oos_mean > 0.5 else 0.0)

    # Consistency : % of OOS windows with positive Sharpe
    oos_pos = sum(1 for s in oos_sharpes if s > 0) / len(oos_sharpes)

    # Std for robustness
    import statistics
    oos_std = statistics.stdev(oos_sharpes) if len(oos_sharpes) > 1 else 0

    # Pass criteria
    pass_wf = (wf_ratio > 0.5 and oos_mean > 0.5 and oos_pos > 0.6)

    return {
        'num_windows': len(results),
        'is_sharpe_mean': is_mean,
        'oos_sharpe_mean': oos_mean,
        'oos_sharpe_std': oos_std,
        'walk_forward_ratio': wf_ratio,
        'oos_consistency': oos_pos,
        'oos_return_avg': sum(oos_returns) / len(oos_returns),
        'pass': pass_wf,
    }


def print_walk_forward_report(results: List[WalkForwardResult], summary: dict):
    print("\n" + "="*80)
    print("  WALK-FORWARD ANALYSIS REPORT")
    print("="*80)
    print(f"\n  Windows analyzed   : {summary.get('num_windows', 0)}")
    print(f"  IS Sharpe (mean)   : {summary.get('is_sharpe_mean', 0):.2f}")
    print(f"  OOS Sharpe (mean)  : {summary.get('oos_sharpe_mean', 0):.2f}")
    print(f"  OOS Sharpe (std)   : {summary.get('oos_sharpe_std', 0):.2f}")
    print(f"  Walk-forward ratio : {summary.get('walk_forward_ratio', 0):.2f}  (target > 0.5)")
    print(f"  OOS consistency    : {summary.get('oos_consistency', 0)*100:.0f}%  (target > 60%)")
    print(f"  OOS avg return     : {summary.get('oos_return_avg', 0)*100:+.1f}%")
    print(f"\n  Pass Go/No-Go      : {'✅ GO' if summary.get('pass') else '❌ NO-GO'}")
    print()

    if results:
        print("  Per-window detail :")
        print(f"  {'Window':<8}{'IS Period':<25}{'OOS Period':<25}{'IS Shpe':>10}{'OOS Shpe':>10}")
        for r in results[:15]:
            print(f"  {r.window_num:<8}{r.is_start+'-'+r.is_end:<25}"
                  f"{r.oos_start+'-'+r.oos_end:<25}{r.is_sharpe:>10.2f}{r.oos_sharpe:>10.2f}")
