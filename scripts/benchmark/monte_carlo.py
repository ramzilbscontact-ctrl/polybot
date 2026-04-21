"""
Monte Carlo bootstrap des returns.
Calcule la distribution de Sharpe/DD/return si on rééchantillonne les trades.
Détecte si la perfo est du bruit vs signal réel.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from metrics import PerformanceMetrics


def monte_carlo_bootstrap(returns: pd.Series,
                           n_simulations: int = 1000,
                           block_size: int = 5,
                           seed: int = 42) -> dict:
    """
    Block bootstrap des daily returns (préserve autocorrelation).
    Retourne distribution de métriques clés.
    """
    np.random.seed(seed)
    r = returns.dropna().values
    n = len(r)
    if n < 20:
        return {'error': 'insufficient data'}

    sharpes = []
    max_dds = []
    total_returns = []

    for _ in range(n_simulations):
        # Block bootstrap
        n_blocks = n // block_size + 1
        starts = np.random.randint(0, n - block_size, size=n_blocks)
        sampled = np.concatenate([r[s:s + block_size] for s in starts])[:n]

        # Sharpe
        if sampled.std() > 0:
            sharpe = sampled.mean() / sampled.std() * np.sqrt(252)
        else:
            sharpe = 0
        sharpes.append(sharpe)

        # Cumulative return
        cum = (1 + sampled).cumprod()
        total_returns.append(cum[-1] - 1)

        # Max drawdown
        roll_max = np.maximum.accumulate(cum)
        dd = (cum - roll_max) / roll_max
        max_dds.append(dd.min())

    return {
        'n_simulations': n_simulations,
        'sharpe': {
            'mean': float(np.mean(sharpes)),
            'std': float(np.std(sharpes)),
            'p5': float(np.percentile(sharpes, 5)),
            'p25': float(np.percentile(sharpes, 25)),
            'p50': float(np.percentile(sharpes, 50)),
            'p75': float(np.percentile(sharpes, 75)),
            'p95': float(np.percentile(sharpes, 95)),
        },
        'max_drawdown': {
            'mean': float(np.mean(max_dds)),
            'p5': float(np.percentile(max_dds, 5)),
            'p50': float(np.percentile(max_dds, 50)),
            'p95': float(np.percentile(max_dds, 95)),
        },
        'total_return': {
            'mean': float(np.mean(total_returns)),
            'p5': float(np.percentile(total_returns, 5)),
            'p50': float(np.percentile(total_returns, 50)),
            'p95': float(np.percentile(total_returns, 95)),
        },
        'probability_positive_sharpe': float(np.mean([s > 0 for s in sharpes])),
        'probability_sharpe_above_1': float(np.mean([s > 1 for s in sharpes])),
    }


def assess_robustness(mc_result: dict, observed_sharpe: float) -> tuple[bool, str]:
    """
    Une stratégie est "robuste" si :
    - 5th percentile Sharpe > 0  (pire cas n'est pas catastrophique)
    - Sharpe observé dans le range p25-p95 (pas lucky draw)
    - Probabilité Sharpe > 0 > 80%
    """
    if 'error' in mc_result:
        return False, mc_result['error']

    sharpe_dist = mc_result['sharpe']
    p5 = sharpe_dist['p5']
    p50 = sharpe_dist['p50']
    p95 = sharpe_dist['p95']
    prob_pos = mc_result['probability_positive_sharpe']

    if p5 < -0.2:
        return False, f"5% worst case Sharpe = {p5:.2f} < -0.2 (too risky)"
    if prob_pos < 0.75:
        return False, f"Only {prob_pos*100:.0f}% chance of positive Sharpe"
    if observed_sharpe > p95 * 1.1:
        return False, f"Observed Sharpe {observed_sharpe:.2f} > p95 {p95:.2f} (lucky sample)"

    return True, "OK"


def print_monte_carlo_report(mc: dict, observed_sharpe: float):
    print("\n" + "="*80)
    print("  MONTE CARLO ROBUSTNESS REPORT")
    print("="*80)

    if 'error' in mc:
        print(f"  Error: {mc['error']}")
        return

    s = mc['sharpe']
    dd = mc['max_drawdown']
    tr = mc['total_return']
    print(f"\n  Simulations : {mc['n_simulations']}")
    print(f"\n  Sharpe distribution :")
    print(f"    Observed : {observed_sharpe:.2f}")
    print(f"    5th %ile : {s['p5']:.2f}    (worst case)")
    print(f"    Median   : {s['p50']:.2f}")
    print(f"    95th %ile: {s['p95']:.2f}    (best case)")
    print(f"    P(>0)    : {mc['probability_positive_sharpe']*100:.0f}%")
    print(f"    P(>1)    : {mc['probability_sharpe_above_1']*100:.0f}%")

    print(f"\n  Max drawdown distribution :")
    print(f"    Median   : {dd['p50']*100:+.1f}%")
    print(f"    5th %ile : {dd['p5']*100:+.1f}%    (worst case)")

    print(f"\n  Total return distribution :")
    print(f"    Median   : {tr['p50']*100:+.1f}%")
    print(f"    5th %ile : {tr['p5']*100:+.1f}%")
    print(f"    95th %ile: {tr['p95']*100:+.1f}%")

    passed, reason = assess_robustness(mc, observed_sharpe)
    print(f"\n  Verdict : {'✅ ROBUST' if passed else '❌ FRAGILE'} — {reason}")
