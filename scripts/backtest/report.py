"""
Auto-generates Markdown performance reports after each backtest run.
"""
import os
from datetime import datetime
from typing import List
from engine import BacktestResult

REPORTS_DIR = os.path.join(os.path.dirname(__file__), 'reports')


def _pct(v: float) -> str:
    return f"{v * 100:+.2f}%"

def _f2(v: float) -> str:
    return f"{v:.2f}"


def generate_report(results: List[BacktestResult], run_label: str = '') -> str:
    """Write a .md report and return its path."""
    os.makedirs(REPORTS_DIR, exist_ok=True)
    ts = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    label = run_label.replace(' ', '_') if run_label else 'backtest'
    path = os.path.join(REPORTS_DIR, f"{ts}_{label}.md")

    lines = [
        f"# Backtest Report — {run_label or 'all strategies'}",
        f"*Generated {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}*",
        "",
    ]

    if not results:
        lines.append("*No results.*")
    else:
        # Summary table
        lines += [
            "## Summary",
            "",
            "| Symbol | Strategy | Params | Total Return | Ann. Return | Sharpe | Max DD | Win Rate | Profit Factor | Trades |",
            "|--------|----------|--------|-------------|-------------|--------|--------|----------|---------------|--------|",
        ]
        for r in sorted(results, key=lambda x: x.sharpe, reverse=True):
            p_str = ', '.join(f"{k}={v}" for k, v in r.params.items())
            lines.append(
                f"| {r.symbol} | {r.strategy} | {p_str} "
                f"| {_pct(r.total_return)} | {_pct(r.annual_return)} "
                f"| {_f2(r.sharpe)} | {_pct(r.max_drawdown)} "
                f"| {r.win_rate*100:.1f}% | {_f2(r.profit_factor)} | {r.total_trades} |"
            )

        # Best per symbol
        lines += ["", "## Best Strategy per Symbol", ""]
        by_symbol: dict = {}
        for r in results:
            if r.symbol not in by_symbol or r.sharpe > by_symbol[r.symbol].sharpe:
                by_symbol[r.symbol] = r

        for sym, r in sorted(by_symbol.items()):
            lines += [
                f"### {sym} — {r.strategy} ({', '.join(f'{k}={v}' for k,v in r.params.items())})",
                "",
                f"- **Period**: {r.start_date} → {r.end_date} ({r.bars} bars)",
                f"- **Total return**: {_pct(r.total_return)}",
                f"- **Annualised return**: {_pct(r.annual_return)}",
                f"- **Sharpe ratio**: {_f2(r.sharpe)}",
                f"- **Max drawdown**: {_pct(r.max_drawdown)}",
                f"- **Win rate**: {r.win_rate*100:.1f}%  |  **Profit factor**: {_f2(r.profit_factor)}",
                f"- **Total trades**: {r.total_trades}  |  **Avg trade**: {_pct(r.avg_trade_pct)}",
                "",
            ]
            if len(r.trades) > 0:
                top = r.trades.sort_values('pct', ascending=False).head(5)
                lines += ["  **Top 5 trades:**", ""]
                lines.append("  | Entry | Exit | Dir | Entry px | Exit px | Pct |")
                lines.append("  |-------|------|-----|----------|---------|-----|")
                for _, t in top.iterrows():
                    lines.append(
                        f"  | {str(t['entry_date'])[:10]} | {str(t['exit_date'])[:10]} "
                        f"| {t['direction']} | {t['entry']:.2f} | {t['exit']:.2f} "
                        f"| {_pct(t['pct'])} |"
                    )
                lines.append("")

    content = '\n'.join(lines)
    with open(path, 'w') as f:
        f.write(content)

    return path
