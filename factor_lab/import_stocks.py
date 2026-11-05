"""
个股日线导入（应用后复权）
=========================
输入 /tmp/stocks.ndjson（由 fetch_stocks.mjs 产出），输出 stocks.db。

复权口径
--------
新浪 hfq.js 给的 f 是「后复权累计因子」：某日收盘 × 该日 f = 后复权价。
f 只在分红除权日变化，所以要先按日期 ffill 到每个交易日。

为什么必须复权：个股每年分红除权会造成 2–5% 的假跳空。ETF 的动量因子要是
用不复权价聚合，除权季会系统性误判成「成分股在跌」。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).parent
DB = OUT / 'stocks.db'
SRC = Path('/tmp/stocks.ndjson')


def main():
    if not SRC.exists():
        raise SystemExit('缺 /tmp/stocks.ndjson，先跑 fetch_stocks.mjs')

    con = sqlite3.connect(DB)
    con.executescript('''
    CREATE TABLE IF NOT EXISTS daily(
        code TEXT, date TEXT, close REAL, close_adj REAL, volume REAL,
        PRIMARY KEY(code,date));
    CREATE TABLE IF NOT EXISTS meta(code TEXT PRIMARY KEY, bars INTEGER,
        first TEXT, last TEXT, adj_events INTEGER);
    ''')
    con.commit()

    rows, meta = [], []
    n = 0
    with open(SRC) as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            code = o['code']
            bars = o.get('bars') or []
            adj = o.get('adj') or []
            if len(bars) < 30:
                continue

            # 复权因子 ffill 到交易日
            if adj:
                a = pd.DataFrame(adj, columns=['date', 'f'])
                a['date'] = pd.to_datetime(a['date'])
                a = a.drop_duplicates('date').set_index('date')['f'].sort_index()
                b = pd.DataFrame(bars, columns=['date', 'close', 'vol'])
                b['date'] = pd.to_datetime(b['date'])
                b = b.sort_values('date')
                f = a.reindex(a.index.union(b['date'])).ffill().reindex(b['date'])
                f = f.fillna(1.0)
                adjc = (b['close'].values * f.values)
            else:
                b = pd.DataFrame(bars, columns=['date', 'close', 'vol'])
                b['date'] = pd.to_datetime(b['date'])
                b = b.sort_values('date')
                adjc = b['close'].values

            for d, c, ca, v in zip(b['date'].dt.strftime('%Y-%m-%d'),
                                   b['close'].values, adjc, b['vol'].values):
                rows.append((code, d, float(c), float(ca), float(v)))
            meta.append((code, len(b),
                         b['date'].iloc[0].strftime('%Y-%m-%d'),
                         b['date'].iloc[-1].strftime('%Y-%m-%d'), len(adj)))
            n += 1

    con.executemany('INSERT OR REPLACE INTO daily VALUES (?,?,?,?,?)', rows)
    con.executemany('INSERT OR REPLACE INTO meta VALUES (?,?,?,?,?)', meta)
    con.commit()
    print(f'导入 {n} 只，{len(rows)} 条日线')

    st = pd.read_sql('SELECT * FROM meta', con)
    print(f'覆盖：{st["first"].min()} → {st["last"].max()}')
    print(f'行数分布：中位 {st.bars.median():.0f}，25% {st.bars.quantile(.25):.0f}，'
          f'75% {st.bars.quantile(.75):.0f}，最大 {st.bars.max()}')
    print(f'有复权记录的：{(st.adj_events>0).sum()}/{len(st)}')

    # 抽样验证复权是否正确：分红多的老股票，后复权价应显著高于原始价
    s = pd.read_sql("SELECT code,date,close,close_adj FROM daily WHERE code='600519' "
                    "ORDER BY date DESC LIMIT 2", con)
    if len(s):
        r = s.iloc[0]
        print(f"\n验证 600519：原始 {r['close']:.2f} → 后复权 {r['close_adj']:.2f} "
              f"(倍数 {r['close_adj']/r['close']:.2f})")


if __name__ == '__main__':
    main()
