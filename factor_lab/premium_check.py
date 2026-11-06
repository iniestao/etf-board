"""折溢价体检：用 PCF 原文的净值日期精确配对，按交易所标注的基金类型分组。

为什么必须读 nav_date 而不是按文件日期退固定天数：
  PCF 文件名是申赎日 T，但内容写的是「YYYY-MM-DD日 信息内容」。
  本市场 ETF 是 T-1；跨境 ETF 不一致——纳指类要等海外确认是 T-2，
  恒生类港股收盘晚于 A 股、当天可确认，仍是 T-1。退错一天就把当日涨跌
  算进了溢价，波动大的日子能差 2-3 个百分点。

用法：python premium_check.py
"""
import json
import sqlite3

import numpy as np
import pandas as pd

from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT


def load():
    con = sqlite3.connect(OUT / 'pcf.db')
    m = pd.read_sql(
        'SELECT code, date, nav, nav_date, fund_type FROM pcf_meta '
        'WHERE nav > 0 AND nav_date IS NOT NULL', con)
    con.close()
    m['pcf_day'] = pd.to_datetime(m['date'])
    m['nav_day'] = pd.to_datetime(m['nav_date'])

    con = sqlite3.connect(ROOT.parent / 'data' / 'etf.db')
    e = pd.read_sql('SELECT code, date, close FROM etf_daily', con)
    con.close()
    e['date'] = pd.to_datetime(e['date'])
    P = e.pivot_table(index='date', columns='code', values='close',
                      aggfunc='last').sort_index()
    return m, P


def main():
    m, P = load()
    px = []
    for r in m.itertuples():
        if r.nav_day in P.index and r.code in P.columns:
            px.append(P.at[r.nav_day, r.code])
        else:
            px.append(np.nan)
    m['px'] = px
    m = m.dropna(subset=['px', 'nav'])
    m['prem'] = m['px'] / m['nav'] - 1

    print(f'样本 {len(m):,} 条 | {m.code.nunique()} 只 ETF '
          f'| {m.pcf_day.nunique()} 期 | {m.pcf_day.min().date()} → {m.pcf_day.max().date()}')

    # 滞后天数分布 —— 验证「不能按固定退天数」这个结论
    m['lag'] = (m['pcf_day'] - m['nav_day']).dt.days
    print('\n===== 净值相对文件日的滞后 =====')
    print(pd.crosstab(m['fund_type'], m['lag']).to_string())

    print('\n===== 折溢价分布（%）=====')
    rows = []
    for ft, g in m.groupby('fund_type'):
        s = g['prem'] * 100
        rows.append(dict(类型=ft, 样本=len(g),
                         中位=s.median(), 均值=s.mean(), std=s.std(),
                         P10=s.quantile(.1), P90=s.quantile(.9),
                         最大=s.max(), 超1pct占比=float((s.abs() > 1).mean() * 100)))
    print(pd.DataFrame(rows).to_string(index=False, float_format=lambda v: f'{v:+.2f}'))

    # 持续性：同一只 ETF 相邻两期的溢价自相关
    print('\n===== 溢价持续性（相邻期自相关）=====')
    m = m.sort_values(['code', 'pcf_day'])
    m['next'] = m.groupby('code')['prem'].shift(-1)
    for ft, g in m.groupby('fund_type'):
        g2 = g.dropna(subset=['next'])
        if len(g2) < 50:
            continue
        print(f'  {ft:10s} rho={g2["prem"].corr(g2["next"], method="spearman"):+.3f}  n={len(g2):,}')

    # 最新一期：谁在极端溢价
    last = m[m.pcf_day == m.pcf_day.max()]
    print(f'\n===== 最新一期 {m.pcf_day.max().date()}：溢价绝对值前 10 =====')
    t = last.reindex(last['prem'].abs().sort_values(ascending=False).index).head(10)
    for r in t.itertuples():
        print(f'  {r.code}  {str(r.fund_type):10s} {r.prem*100:+7.2f}%')

    # 溢价 vs 下一期收益：低溢价/折价是否跑赢
    print('\n===== 溢价水平 → 下一期收益 =====')
    m['fwd'] = m.groupby('code')['px'].shift(-1) / m['px'] - 1
    for ft, g in m.groupby('fund_type'):
        g2 = g.dropna(subset=['fwd'])
        ics = []
        for _, gg in g2.groupby('pcf_day'):
            if len(gg) < 8:
                continue
            ics.append(gg['prem'].corr(gg['fwd'], method='spearman'))
        if len(ics) < 10:
            continue
        ics = pd.Series(ics).dropna()
        t_stat = ics.mean() / ics.std() * np.sqrt(len(ics))
        print(f'  {ft:10s} IC={ics.mean():+.4f}  t={t_stat:+.2f}  n={len(ics)}')

    m.to_csv(OUT / 'out_premium.csv', index=False)


if __name__ == '__main__':
    main()
