"""SMA crossover: long when fast > slow, flat otherwise."""
import pandas as pd


def sma_cross_signals(df: pd.DataFrame, fast: int = 20, slow: int = 50) -> pd.Series:
    sma_fast = df['close'].rolling(fast).mean()
    sma_slow = df['close'].rolling(slow).mean()
    signal = pd.Series(0, index=df.index)
    signal[sma_fast > sma_slow] = 1
    return signal
