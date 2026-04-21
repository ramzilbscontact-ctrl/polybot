"""Momentum / trend-following: long on positive N-day return, flat/short otherwise."""
import pandas as pd


def momentum_signals(df: pd.DataFrame, lookback: int = 20,
                     long_only: bool = True) -> pd.Series:
    ret = df['close'].pct_change(lookback)
    signal = pd.Series(0, index=df.index)
    signal[ret > 0]  =  1
    if not long_only:
        signal[ret < 0] = -1
    return signal
