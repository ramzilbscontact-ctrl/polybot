from .sma_cross import sma_cross_signals
from .rsi_mean_reversion import rsi_signals
from .momentum import momentum_signals
from .vwap_reversion import vwap_reversion_signals

STRATEGIES = {
    'sma_cross':       sma_cross_signals,
    'rsi':             rsi_signals,
    'momentum':        momentum_signals,
    'vwap_reversion':  vwap_reversion_signals,
}
