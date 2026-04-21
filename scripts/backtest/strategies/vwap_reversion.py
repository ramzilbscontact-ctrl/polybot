"""
VWAP-deviation mean reversion (daily bars).
Long when close is >threshold% below rolling VWAP average.
"""
import pandas as pd


def vwap_reversion_signals(df: pd.DataFrame, window: int = 10,
                            threshold: float = 0.02) -> pd.Series:
    if 'vwap' not in df.columns:
        return pd.Series(0, index=df.index)

    avg_vwap = df['vwap'].rolling(window).mean()
    deviation = (df['close'] - avg_vwap) / avg_vwap
    signal = pd.Series(0, index=df.index)
    signal[deviation < -threshold] =  1   # buy dip
    signal[deviation >  threshold] = -1   # sell spike
    return signal
