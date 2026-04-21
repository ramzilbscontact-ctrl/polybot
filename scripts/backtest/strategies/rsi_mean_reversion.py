"""RSI mean-reversion: long when oversold, short when overbought."""
import pandas as pd
import numpy as np


def _rsi(series: pd.Series, period: int) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def rsi_signals(df: pd.DataFrame, period: int = 14,
                oversold: int = 30, overbought: int = 70) -> pd.Series:
    rsi = _rsi(df['close'], period)
    signal = pd.Series(0, index=df.index)
    signal[rsi < oversold]  =  1
    signal[rsi > overbought] = -1
    return signal
