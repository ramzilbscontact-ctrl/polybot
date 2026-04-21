"""
Vectorized backtest engine.
Computes signals → positions → equity curve → metrics.
"""
from dataclasses import dataclass, field
from typing import Optional
import pandas as pd
import numpy as np


@dataclass
class BacktestResult:
    symbol:       str
    strategy:     str
    params:       dict
    equity:       pd.Series       # cumulative equity curve
    trades:       pd.DataFrame    # individual trade log
    total_return: float
    annual_return: float
    sharpe:       float
    max_drawdown: float
    win_rate:     float
    profit_factor: float
    total_trades: int
    avg_trade_pct: float
    start_date:   str
    end_date:     str
    bars:         int


def run_backtest(df: pd.DataFrame, signals: pd.Series,
                 symbol: str, strategy: str, params: dict,
                 initial_capital: float = 10_000,
                 commission: float = 0.001) -> BacktestResult:
    """
    signals: +1 = long, -1 = short, 0 = flat.
    Assumes next-bar-open execution (avoids lookahead bias).
    """
    df = df.copy()
    df['signal'] = signals.reindex(df.index).fillna(0)
    df['position'] = df['signal'].shift(1).fillna(0)  # execute next bar open

    # Entry/exit price = next bar open
    df['entry_price'] = df['open'].shift(-1)
    df['exit_price']  = df['open']

    # Daily returns from position
    df['ret'] = df['close'].pct_change()
    df['strat_ret'] = df['position'] * df['ret']

    # Commission on position changes
    df['pos_change'] = df['position'].diff().fillna(0).abs()
    df['strat_ret'] -= df['pos_change'] * commission

    # Equity curve
    equity = (1 + df['strat_ret']).cumprod() * initial_capital
    equity = equity.dropna()

    # Trade log
    trades = _extract_trades(df)

    # Metrics
    total_return   = float(equity.iloc[-1] / initial_capital - 1) if len(equity) else 0
    n_years        = max((equity.index[-1] - equity.index[0]).days / 365.25, 1/365) if len(equity) > 1 else 1
    annual_return  = float((1 + total_return) ** (1 / n_years) - 1)
    sharpe         = _sharpe(df['strat_ret'])
    max_dd         = _max_drawdown(equity)
    win_rate       = float(len(trades[trades['pnl'] > 0]) / len(trades)) if len(trades) else 0
    gross_profit   = float(trades[trades['pnl'] > 0]['pnl'].sum()) if len(trades) else 0
    gross_loss     = abs(float(trades[trades['pnl'] < 0]['pnl'].sum())) if len(trades) else 1
    profit_factor  = gross_profit / gross_loss if gross_loss > 0 else float('inf')
    avg_trade_pct  = float(trades['pct'].mean()) if len(trades) else 0

    return BacktestResult(
        symbol=symbol, strategy=strategy, params=params,
        equity=equity, trades=trades,
        total_return=total_return, annual_return=annual_return,
        sharpe=sharpe, max_drawdown=max_dd,
        win_rate=win_rate, profit_factor=profit_factor,
        total_trades=len(trades), avg_trade_pct=avg_trade_pct,
        start_date=str(df.index[0].date()) if len(df) else '',
        end_date=str(df.index[-1].date()) if len(df) else '',
        bars=len(df),
    )


def _extract_trades(df: pd.DataFrame) -> pd.DataFrame:
    trades = []
    pos = 0
    entry_price = 0.0
    entry_date  = None

    for ts, row in df.iterrows():
        new_pos = row['position']
        if pos == 0 and new_pos != 0:
            pos = new_pos
            entry_price = row['open']
            entry_date  = ts
        elif pos != 0 and (new_pos == 0 or new_pos != pos):
            exit_price = row['open']
            pnl_pct = pos * (exit_price / entry_price - 1)
            trades.append({
                'entry_date': entry_date,
                'exit_date':  ts,
                'direction':  'long' if pos > 0 else 'short',
                'entry':      entry_price,
                'exit':       exit_price,
                'pct':        pnl_pct,
                'pnl':        pnl_pct,
            })
            pos = new_pos
            if new_pos != 0:
                entry_price = row['open']
                entry_date  = ts

    return pd.DataFrame(trades)


def _sharpe(returns: pd.Series, rf: float = 0.0, periods: int = 252) -> float:
    r = returns.dropna()
    if len(r) < 5 or r.std() < 1e-6:
        return 0.0
    s = float((r.mean() - rf / periods) / r.std() * np.sqrt(periods))
    # Cap extreme values (numerical artefacts)
    if abs(s) > 10:
        return 0.0
    return s


def _max_drawdown(equity: pd.Series) -> float:
    roll_max = equity.cummax()
    dd = (equity - roll_max) / roll_max
    return float(dd.min())
