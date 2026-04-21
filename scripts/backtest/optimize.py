"""
Grid-search parameter optimizer.
Runs backtest for all param combinations and ranks by Sharpe ratio.
"""
import itertools
from typing import Callable, Dict, List, Any
import pandas as pd
from engine import BacktestResult, run_backtest


def grid_search(df: pd.DataFrame, symbol: str, strategy_name: str,
                signal_fn: Callable, param_grid: Dict[str, List[Any]],
                initial_capital: float = 10_000,
                commission: float = 0.001) -> List[BacktestResult]:
    """Run all param combinations, return sorted list (best Sharpe first)."""
    keys   = list(param_grid.keys())
    values = list(param_grid.values())
    results = []

    combos = list(itertools.product(*values))
    print(f"  Grid search {strategy_name} on {symbol}: {len(combos)} combinations")

    for combo in combos:
        params = dict(zip(keys, combo))
        try:
            signals = signal_fn(df, **params)
            result  = run_backtest(df, signals, symbol, strategy_name, params,
                                   initial_capital, commission)
            results.append(result)
        except Exception as e:
            print(f"    skip {params}: {e}")

    results.sort(key=lambda r: r.sharpe, reverse=True)
    return results


def best_params(results: List[BacktestResult]) -> BacktestResult:
    """Return result with highest Sharpe (already sorted)."""
    if not results:
        raise ValueError("No results")
    return results[0]
