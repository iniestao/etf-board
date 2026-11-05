"""
同指数 ETF 价差回归
===================
同一指数的多只 ETF 长期收益几乎相同，短期价差应回归 —— ETF 独有、且不依赖
外部数据的套利结构。沪深300 有 29 只、中证A500 有 40 只，样本足够。

信号（全部组内 demean，剔除指数本身的涨跌）：
    rel_i  = 日对数收益 − 组内等权收益
    dev_i  = rel_i 的 60 日累计
    z_i    = (dev − 过去 250 日均值) / 标准差

z 高 = 相对同门贵了 → 预期跑输（负向 IC）。

关键：结论必须按流动性分层复核。ETF 报价精度 0.001 元，对 1–3 元的净值
就是 3–10bp，低流动性 ETF 的收盘价黏滞会凭空造出"价差回归"。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('/workspace/etf_board')
OUT = Path(__file__).parent
HOLDS = [1, 5, 20, 60]
WIN, BASE = 60, 250


def load_etf():
    con = sqlite3.connect(ROOT / 'data' / 'etf.db')
    d = pd.read_sql('SELECT code, date, close, adj_factor, amount FROM etf_daily', con)
    con.close()
    d['date'] = pd.to_datetime(d['date'])
    d['px'] = d['close'] * d['adj_factor']
    E = d.pivot_table(index='date', columns='code', values='px', aggfunc='last').sort_index()
    A = d.pivot_table(index='date', columns='code', values='amount', aggfunc='last').sort_index()
    return E, A


def main():
    groups = json.load(open(OUT / 'idx_groups.json'))
    E, A = load_etf()
    print(f'ETF 面板 {E.shape} | {E.index[0].date()} → {E.index[-1].date()}')

    # 代码 → 指数（一只 ETF 若被列在多组，取第一组）
    idx_of = {}
    for k, cs in groups.items():
        for c in cs:
            idx_of.setdefault(c, k)
    cols = [c for c in idx_of if c in E.columns]
    print(f'分组 {len(groups)} 组 | 可匹配 {len(cols)} 只 ETF')

    # 只保留成员 >= 3 的组
    vc = pd.Series([idx_of[c] for c in cols]).value_counts()
    keep = set(vc[vc >= 3].index)
    cols = [c for c in cols if idx_of[c] in keep]
    print(f'成员>=3 的组 {len(keep)} 个 | 保留 {len(cols)} 只 ETF')

    R = np.log(E[cols].where(E[cols] > 0)).diff()
    tag = pd.Series({c: idx_of[c] for c in cols})

    # 组内等权基准（一次 transform，不做 247 次循环）
    print('组内 demean…', flush=True)
    gm = R.T.groupby(tag).transform('mean').T
    rel = R - gm

    dev = rel.rolling(WIN, min_periods=int(WIN * 0.8)).sum()
    mu = dev.rolling(BASE, min_periods=int(BASE * 0.6)).mean()
    sd = dev.rolling(BASE, min_periods=int(BASE * 0.6)).std()
    z = (dev - mu) / sd.replace(0, np.nan)
    print(f'z 面板 {z.shape}，非空 {z.notna().sum().sum():,}')

    # 长表化：只保留 z 和 4 个 forward
    print('转长表…', flush=True)
    recs = {'z': z}
    for h in HOLDS:
        recs[f'f{h}'] = rel.rolling(h, min_periods=max(1, h - 1)).sum().shift(-h)
    L = pd.concat({k: v.stack() for k, v in recs.items()}, axis=1)
    L.index.names = ['date', 'code']
    L = L.reset_index()
    L['idx'] = L['code'].map(tag)
    L = L.dropna(subset=['z'])
    print(f'长表 {L.shape}，{L.date.nunique()} 天，{L.code.nunique()} 只')

    adv = A.rolling(20, min_periods=10).mean()
    # 组内 rank，一次性
    print('组内 rank…', flush=True)
    by = ['date', 'idx']
    L['pz'] = L.groupby(by)['z'].rank(pct=True)
    for h in HOLDS:
        L[f'p{h}'] = L.groupby(by)[f'f{h}'].rank(pct=True)

    # ------------------------------------------------------------ 1. IC
    print('\n===== 组内价差回归 IC（组内 rank）=====')
    summ = []
    for h in HOLDS:
        d = L.dropna(subset=[f'p{h}'])
        # 每组每天成员数
        cnt = d.groupby(by)['code'].transform('size')
        d = d[cnt >= 4]
        if not len(d):
            continue
        per = d.groupby('date').apply(
            lambda g: g['pz'].corr(g[f'p{h}'], method='pearson'), include_groups=False)
        x = per.dropna()
        ne = len(x) / max(h, 1)
        t = x.mean() / (x.std() / np.sqrt(ne)) if x.std() > 0 else np.nan
        summ.append(dict(hold=h, n_days=len(x), IC=x.mean(), t=t,
                         ICIR=x.mean() / x.std() if x.std() > 0 else np.nan,
                         pos=(x > 0).mean()))
        print(f'  持有 {h:2d} 日: IC={x.mean():+.4f} t={t:+.2f} '
              f'ICIR={summ[-1]["ICIR"]:+.3f} 胜率={100*(x>0).mean():.0f}%')
    pd.DataFrame(summ).to_csv(OUT / 'out_pair_ic.csv', index=False)

    # ------------------------------------------------------------ 2. 分组收益
    print('\n===== 按 z 分五组的未来相对收益（%）=====')
    for h in HOLDS:
        d = L.dropna(subset=[f'f{h}']).copy()
        d['q'] = d.groupby(by)['z'].transform(
            lambda s: pd.qcut(s.rank(method='first'), 5, labels=False) if len(s) >= 5 else np.nan)
        d = d.dropna(subset=['q'])
        m = d.groupby('q')[f'f{h}'].mean() * 100
        print(f'  持有 {h:2d} 日: ' + '  '.join(f'Q{int(k)}={v:+.2f}' for k, v in m.items())
              + f'  |  Q0−Q4={m.get(0, np.nan)-m.get(4, np.nan):+.2f}%')

    # ------------------------------------------------------------ 3. 流动性分层
    print('\n===== 关键复核：按 ETF 流动性分层看 IC（5 日）=====')
    d5 = L.dropna(subset=['p5']).copy()
    d5['adv'] = [adv.at[dt, c] if (dt in adv.index and c in adv.columns) else np.nan
                 for dt, c in zip(d5.date, d5.code)]
    for thr in [0, 5000, 20000, 50000]:
        sub = d5[d5['adv'] > thr * 1e4]
        cnt = sub.groupby(by)['code'].transform('size')
        sub = sub[cnt >= 4]
        if sub.empty:
            print(f'  日均额>{thr/10000:.1f}亿: 样本不足')
            continue
        per = sub.groupby('date').apply(
            lambda g: g['pz'].corr(g['p5'], method='pearson'), include_groups=False).dropna()
        if len(per) < 30:
            print(f'  日均额>{thr/10000:.1f}亿: 有效天数仅 {len(per)}')
            continue
        t = per.mean() / (per.std() / np.sqrt(len(per) / 5))
        print(f'  日均额>{thr/10000:.1f}亿: IC={per.mean():+.4f} t={t:+.2f} '
              f'n_days={len(per)} 平均组内 {cnt[sub.index].median():.0f} 只')

    # ------------------------------------------------------------ 4. 当前截面
    print('\n===== 当前最便宜 / 最贵（相对同指数）=====')
    last = L['date'].max()
    cur = L[L['date'] == last].dropna(subset=['z'])
    print(f'日期 {last.date()}，覆盖 {len(cur)} 只 / {cur.idx.nunique()} 组')
    rows = []
    for idx, g in cur.groupby('idx'):
        if len(g) < 3:
            continue
        g = g.sort_values('z')
        rows.append((idx, len(g), g.iloc[0]['code'], g.iloc[0]['z'],
                     g.iloc[-1]['code'], g.iloc[-1]['z']))
    rows.sort(key=lambda r: -r[3] + r[5])
    print(f'{"指数":22s} {"只数":>4s}  {"最便宜":>8s} {"z":>7s}   {"最贵":>8s} {"z":>7s}')
    for r in rows[:25]:
        print(f'{r[0][:20]:22s} {r[1]:4d}  {r[2]:>8s} {r[3]:+7.2f}   {r[4]:>8s} {r[5]:+7.2f}')


if __name__ == '__main__':
    main()
