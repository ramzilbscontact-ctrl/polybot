"""
Métriques de performance standard pour tout backtest.
Utilisées par tous les scripts de benchmark.
"""
from dataclasses import dataclass, asdict
from typing import Optional
import numpy as np
import pandas as pd


@dataclass
class PerformanceMetrics:
    # Performance
    total_return: float
    annual_return: float
    sharpe: float
    sortino: float
    calmar: float

    # Risk
    max_drawdown: float
    max_dd_duration_days: int
    var_95: float
    cvar_95: float

    # Trade stats
    win_rate: float
    profit_factor: float
    avg_r: float
    num_trades: int
    avg_trade_pct: float
    largest_win: float
    largest_loss: float

    # Time
    exposure_time: float
    start_date: str
    end_date: str

    def to_dict(self) -> dict:
        return asdict(self)

    def summary_markdown(self) -> str:
        return (
            f"| Sharpe | {self.sharpe:.2f} | Calmar | {self.calmar:.2f} |\n"
            f"| Sortino | {self.sortino:.2f} | Max DD | {self.max_drawdown*100:+.1f}% |\n"
            f"| Win rate | {self.win_rate*100:.1f}% | Profit factor | {self.profit_factor:.2f} |\n"
            f"| Total return | {self.total_return*100:+.1f}% | Annual | {self.annual_return*100:+.1f}% |\n"
            f"| Trades | {self.num_trades} | Avg R | {self.avg_r:.2f} |\n"
        )


def compute_metrics(equity: pd.Series,
                    trades: pd.DataFrame,
                    rf_annual: float = 0.04,
                    periods: int = 252) -> PerformanceMetrics:
    """
    equity: pd.Series — courbe d'équité indexée par datetime
    trades: DataFrame avec colonnes 'pct' (R-multiple), 'entry_date', 'exit_date'
    """
    if len(equity) < 2:
        return _empty_metrics()

    returns = equity.pct_change().dropna()
    n_years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1/365)

    # Returns
    total_return = float(equity.iloc[-1] / equity.iloc[0] - 1)
    annual_return = float((1 + total_return) ** (1 / n_years) - 1)

    # Sharpe / Sortino
    excess = returns - rf_annual / periods
    sharpe = float(excess.mean() / excess.std() * np.sqrt(periods)) if excess.std() > 1e-6 and len(excess) >= 5 else 0.0
    if abs(sharpe) > 10: sharpe = 0.0

    downside = returns[returns < 0]
    sortino = (float(excess.mean() / downside.std() * np.sqrt(periods))
               if len(downside) > 2 and downside.std() > 1e-6 else 0.0)
    if abs(sortino) > 10: sortino = 0.0

    # Drawdown
    roll_max = equity.cummax()
    dd_series = (equity - roll_max) / roll_max
    max_dd = float(dd_series.min())

    # Drawdown duration
    in_dd = dd_series < 0
    max_dd_dur = 0
    cur = 0
    for val in in_dd:
        cur = cur + 1 if val else 0
        max_dd_dur = max(max_dd_dur, cur)

    calmar = annual_return / abs(max_dd) if max_dd < 0 else 0.0

    # VaR / CVaR
    var_95 = float(returns.quantile(0.05))
    cvar_95 = float(returns[returns <= var_95].mean()) if (returns <= var_95).any() else var_95

    # Trades
    if len(trades) > 0:
        pct = trades['pct'] if 'pct' in trades.columns else pd.Series([0])
        wins = pct[pct > 0]
        losses = pct[pct < 0]
        win_rate = float(len(wins) / len(pct))
        profit_factor = (float(wins.sum() / abs(losses.sum()))
                         if len(losses) > 0 and losses.sum() != 0 else float('inf'))
        avg_win = float(wins.mean()) if len(wins) > 0 else 0
        avg_loss = float(losses.mean()) if len(losses) > 0 else 0
        avg_r = abs(avg_win / avg_loss) if avg_loss != 0 else 0
        largest_win = float(pct.max())
        largest_loss = float(pct.min())
        avg_trade = float(pct.mean())
    else:
        win_rate = profit_factor = avg_r = 0
        largest_win = largest_loss = avg_trade = 0

    # Exposure time (placeholder — estimation simpliste)
    exposure = min(1.0, len(trades) * 5 / len(equity)) if len(equity) > 0 else 0

    return PerformanceMetrics(
        total_return=total_return,
        annual_return=annual_return,
        sharpe=sharpe,
        sortino=sortino,
        calmar=calmar,
        max_drawdown=max_dd,
        max_dd_duration_days=max_dd_dur,
        var_95=var_95,
        cvar_95=cvar_95,
        win_rate=win_rate,
        profit_factor=profit_factor,
        avg_r=avg_r,
        num_trades=len(trades),
        avg_trade_pct=avg_trade,
        largest_win=largest_win,
        largest_loss=largest_loss,
        exposure_time=exposure,
        start_date=str(equity.index[0].date()) if len(equity) > 0 else '',
        end_date=str(equity.index[-1].date()) if len(equity) > 0 else '',
    )


def _empty_metrics() -> PerformanceMetrics:
    return PerformanceMetrics(
        total_return=0, annual_return=0, sharpe=0, sortino=0, calmar=0,
        max_drawdown=0, max_dd_duration_days=0, var_95=0, cvar_95=0,
        win_rate=0, profit_factor=0, avg_r=0, num_trades=0,
        avg_trade_pct=0, largest_win=0, largest_loss=0,
        exposure_time=0, start_date='', end_date='',
    )


def pass_go_no_go(m: PerformanceMetrics) -> tuple[bool, list[str]]:
    """Décision automatique Go/No-Go sur base des critères minimum."""
    reasons = []
    if m.sharpe < 0.8:
        reasons.append(f"Sharpe {m.sharpe:.2f} < 0.8")
    if m.max_drawdown < -0.20:
        reasons.append(f"Max DD {m.max_drawdown*100:.1f}% < -20%")
    if m.win_rate < 0.40 and m.num_trades > 30:
        reasons.append(f"Win rate {m.win_rate*100:.1f}% < 40%")
    if m.profit_factor < 1.3 and m.num_trades > 30:
        reasons.append(f"Profit factor {m.profit_factor:.2f} < 1.3")
    if m.num_trades < 20:
        reasons.append(f"Only {m.num_trades} trades (need 20+)")

    # Red flags
    if m.sharpe > 3.0:
        reasons.append(f"⚠️  Sharpe {m.sharpe:.2f} > 3.0 — possible overfit")
    if m.win_rate > 0.95:
        reasons.append(f"⚠️  Win rate {m.win_rate*100:.1f}% > 95% — suspicious")

    return (len(reasons) == 0), reasons
