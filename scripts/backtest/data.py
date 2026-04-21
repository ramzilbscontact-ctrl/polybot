"""
Alpaca historical data fetcher — replaces yfinance (cloud IP blocked by Yahoo).
"""
import os, json, time
import urllib.request
import urllib.parse
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import pandas as pd

ALPACA_KEY    = os.getenv('ALPACA_KEY_ID',     'PKVDZO7MNOQ2WBHMB4IM2CMNLQ')
ALPACA_SECRET = os.getenv('ALPACA_SECRET_KEY', 'B5DeZoCYdMEuSY22bH1fY3SRBJtv6ggf5CrXNUvUUGkH')
DATA_BASE     = 'https://data.alpaca.markets'

HEADERS = {
    'APCA-API-KEY-ID':     ALPACA_KEY,
    'APCA-API-SECRET-KEY': ALPACA_SECRET,
    'Content-Type':        'application/json',
}

def _get(url: str, retries: int = 3) -> dict:
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            if i == retries - 1:
                raise
            time.sleep(2 ** i)

def fetch_bars(symbol: str, timeframe: str = '1Day',
               start: str = '2023-01-01', end: Optional[str] = None,
               limit: int = 10000) -> pd.DataFrame:
    """Fetch OHLCV bars from Alpaca. Returns DataFrame with datetime index."""
    if end is None:
        # Use yesterday — Alpaca returns 403 if end >= today with no data yet
        end = (datetime.utcnow() - timedelta(days=1)).strftime('%Y-%m-%d')

    bars = []
    token = None
    while True:
        params = {
            'timeframe': timeframe,
            'start':     start,
            'end':       end,
            'limit':     min(limit, 10000),
        }
        if token:
            params['page_token'] = token

        url = f"{DATA_BASE}/v2/stocks/{symbol}/bars?{urllib.parse.urlencode(params)}"
        data = _get(url)
        bars.extend(data.get('bars', []))
        token = data.get('next_page_token')
        if not token or len(bars) >= limit:
            break

    if not bars:
        return pd.DataFrame()

    df = pd.DataFrame(bars)
    df['t'] = pd.to_datetime(df['t'])
    df = df.set_index('t').rename(columns={
        'o': 'open', 'h': 'high', 'l': 'low',
        'c': 'close', 'v': 'volume', 'vw': 'vwap'
    })
    df.index.name = 'date'
    df = df[['open', 'high', 'low', 'close', 'volume', 'vwap']].sort_index()
    return df

def fetch_multi(symbols: List[str], timeframe: str = '1Day',
                start: str = '2023-01-01', end: Optional[str] = None) -> Dict[str, pd.DataFrame]:
    """Fetch bars for multiple symbols."""
    result = {}
    for sym in symbols:
        try:
            result[sym] = fetch_bars(sym, timeframe, start, end)
            print(f"  {sym}: {len(result[sym])} bars")
        except Exception as e:
            print(f"  {sym}: ERROR — {e}")
    return result
