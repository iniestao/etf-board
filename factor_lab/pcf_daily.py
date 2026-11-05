"""
成分股聚合因子（日频化）
========================
96 期月度 PCF 截面太少，做不了时序 IC。但月度内成分股「股数」几乎不变
（调样半年一次），所以可以用 as-of 最近一期 PCF 的 qty，铺到区间内每个
交易日，只重算价格权重 —— 样本从 96 期扩到 1900 天。

look-ahead 安全：PCF 在交易日 08:30 前公布，当日可用，所以 as-of <= d。

因子
----
BREADTH   站上 MA20 的成分股加权比例
BREADTH5  站上 MA5 的加权比例
CS_UP     当日上涨成分股加权比例
CS_MOM20  成分股加权 20 日动量
CS_MOM5   成分股加权 5 日动量
CS_DISP   20 日收益的截面标准差（等权，分化度）
WIDE      加权动量 − 等权动量（>0 表示大市值股更强）
CONC      权重集中度 HHI（慢变量，衡量指数结构）
TOP10     前 10 大权重合计
TRACK     ETF 20 日收益 − 成分股加权 20 日收益（跟踪偏离）
PREM_NAV  收盘价 / PCF 官方净值 − 1（仅 PCF 当日，官方口径）
PREM_IOPV 收盘价 / 用当日价重算的 IOPV − 1（可日频，含权重漂移误差）
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('/workspace/etf_board')
OUT = Path(__file__).parent


def load_pcf():
    con = sqlite3.connect(OUT / 'pcf.db')
    h = pd.read_sql('SELECT code, date, stock, qty FROM pcf_hold', con)
    m = pd.read_sql('SELECT code, date, nav, idx_code, min_unit, unit_nav FROM pcf_meta', con)
    con.close()
    h['date'] = pd.to_datetime(h['date'])
    m['date'] = pd.to_datetime(m['date'])
    h = h.drop_duplicates(['code', 'date', 'stock'])
    h = h[h['qty'] > 0]
    return h, m


def load_px():
    """返回两个面板：复权价（算收益）与原始价（算市值/权重/IOPV）。

    必须分开：后复权价是「今日价 × 累计分红因子」，茅台 8.88 倍。
    用它算市值，权重会被高分红股系统性放大，IOPV 也会虚高数倍。
    """
    con = sqlite3.connect(OUT / 'stocks.db')
    d = pd.read_sql('SELECT code, date, close, close_adj FROM daily', con)
    con.close()
    d['date'] = pd.to_datetime(d['date'])
    adj = d.pivot_table(index='date', columns='code', values='close_adj', aggfunc='last')
    raw = d.pivot_table(index='date', columns='code', values='close', aggfunc='last')
    return adj.sort_index(), raw.sort_index()


def load_etf():
    """同样返回复权价与原始价两套。"""
    con = sqlite3.connect(ROOT / 'data' / 'etf.db')
    d = pd.read_sql('SELECT code, date, close, adj_factor FROM etf_daily', con)
    con.close()
    d['date'] = pd.to_datetime(d['date'])
    d['px'] = d['close'] * d['adj_factor']
    adj = d.pivot_table(index='date', columns='code', values='px', aggfunc='last')
    raw = d.pivot_table(index='date', columns='code', values='close', aggfunc='last')
    return adj.sort_index(), raw.sort_index()


def main():
    h, meta = load_pcf()
    P, P_raw = load_px()
    E, E_raw = load_etf()

    # 个股面板只保留 2018 年以后，省内存
    P = P[P.index >= '2018-01-01']
    P_raw = P_raw[P_raw.index >= '2018-01-01']
    print(f'PCF {len(h):,} 条 | {h.code.nunique()} 只 ETF | {h.date.nunique()} 期')
    print(f'个股面板 {P.shape} | ETF 面板 {E.shape}')

    # 个股因子矩阵（date × stock），预先算好，逐日取行
    print('计算个股因子…', flush=True)
    R1 = P.pct_change(1, fill_method=None)
    R5 = P.pct_change(5, fill_method=None)
    R20 = P.pct_change(20, fill_method=None)
    MA5 = P / P.rolling(5, min_periods=4).mean() - 1
    MA20 = P / P.rolling(20, min_periods=15).mean() - 1
    UP = (R1 > 0).astype(float).where(R1.notna())
    AB5 = (MA5 > 0).astype(float).where(MA5.notna())
    AB20 = (MA20 > 0).astype(float).where(MA20.notna())
    # ETF 日收益（复权），用于日频跟踪偏离
    E_R1 = E.pct_change(1, fill_method=None)
    # 期初价格：算「过去 20 日收益」必须用 20 日前的权重，
    # 用当日权重会把涨得多的股票权重抬高，凭空造出正收益（前视偏差）。
    P_raw_0 = P_raw.shift(20)

    # as-of 期：把每个 PCF 期映射到后续交易日
    pdays = np.array(sorted(h['date'].unique()))
    tdays = E.index[E.index >= pd.Timestamp(pdays[0])]
    print(f'铺开到 {len(tdays)} 个交易日（{tdays[0].date()} → {tdays[-1].date()}）')

    # 每期快照 + 该期的申赎单位参数，预切好
    snaps = {pd.Timestamp(d): g[['code', 'stock', 'qty']].copy()
             for d, g in h.groupby('date')}
    unit = {(r.code, pd.Timestamp(r.date)): (r.min_unit, r.unit_nav)
            for r in meta.itertuples()}

    rows = []
    for k, day in enumerate(tdays, 1):
        pos = np.searchsorted(pdays, np.datetime64(day), side='right') - 1
        if pos < 0:
            continue
        sday = pd.Timestamp(pdays[pos])
        snap = snaps.get(sday)
        if snap is None or snap.empty:
            continue

        # 当日个股因子（以 stock 为 key 的 Series）
        def col(df):
            return df.loc[day] if day in df.index else pd.Series(dtype=float)

        c_r1, c_r5, c_r20 = col(R1), col(R5), col(R20)
        c_ab5, c_ab20, c_up = col(AB5), col(AB20), col(UP)
        c_price = col(P_raw)          # 市值与权重必须用原始价
        c_price0 = col(P_raw_0)       # 20 日前的原始价（期初权重）

        # ETF 当日价（复权价算收益，原始价算折溢价）
        e_row = E.loc[day] if day in E.index else pd.Series(dtype=float)
        er_row = E_raw.loc[day] if day in E_raw.index else pd.Series(dtype=float)
        er1_row = E_R1.loc[day] if day in E_R1.index else pd.Series(dtype=float)

        # 同一只个股在一个 ETF 里只保留一行（防止重复成分行）
        g = snap.copy()
        g['px'] = g['stock'].map(c_price)
        g['px0'] = g['stock'].map(c_price0)
        g['r1'] = g['stock'].map(c_r1)
        g['r5'] = g['stock'].map(c_r5)
        g['r20'] = g['stock'].map(c_r20)
        g['ab5'] = g['stock'].map(c_ab5)
        g['ab20'] = g['stock'].map(c_ab20)
        g['up'] = g['stock'].map(c_up)
        g = g[np.isfinite(g['px']) & (g['px'] > 0)]
        if g.empty:
            continue
        g['mv'] = g['qty'] * g['px']
        g['mv0'] = g['qty'] * g['px0']

        for etf, sub in g.groupby('code'):
            if len(sub) < 10:
                continue
            mv = sub['mv'].values.astype(float)
            w = mv / mv.sum()                       # 当日权重：状态类因子用
            mv0 = sub['mv0'].values.astype(float)
            # 不要求全部有效：新股没有 20 日前价格，用 nansum 归一，wavg 内部再剔除
            w0 = (mv0 / np.nansum(mv0)) if np.isfinite(mv0).any() and np.nansum(mv0) > 0 else None

            def wavg(c, wts=None):
                v = sub[c].values.astype(float)
                m = np.isfinite(v)
                if not m.any():
                    return np.nan
                ww = (w if wts is None else wts)[m]
                ww = ww[np.isfinite(ww)]
                if not len(ww) or ww.sum() <= 0:
                    return np.nan
                vv = v[m][np.isfinite((w if wts is None else wts)[m])]
                return float(np.sum(ww * vv) / np.sum(ww))

            def eavg(c):
                v = sub[c].values.astype(float)
                return float(np.nanmean(v)) if np.isfinite(v).any() else np.nan

            r20v = sub['r20'].values.astype(float)
            ok20 = np.isfinite(r20v)
            disp = float(np.nanstd(r20v[ok20])) if ok20.sum() > 5 else np.nan

            # 20 日收益：用期初权重，避免「当日权重 × 过去收益」的前视偏差
            wmom = wavg('r20', w0) if w0 is not None else np.nan
            emom = eavg('r20')
            etf_r20 = np.nan
            if etf in e_row.index and np.isfinite(e_row.get(etf, np.nan)):
                s = E[etf].loc[:day].dropna()
                if len(s) > 21:
                    etf_r20 = float(s.iloc[-1] / s.iloc[-21] - 1)
            # 日频成分股加权收益，用于构造日频跟踪偏离
            cs_r1 = wavg('r1')
            etf_r1 = er1_row.get(etf, np.nan) if day in E_R1.index else np.nan
            if not np.isfinite(etf_r1):
                etf_r1 = e_row.get(etf, np.nan) / E[etf].shift(1).get(day, np.nan) - 1 \
                    if etf in e_row.index and etf in E.columns else np.nan

            # IOPV：Σqty*原始价 就是「最小申赎单位」的资产净值
            # 覆盖率闸门：成分股缺失（跨市场 ETF 的港股抓不到）时 mv.sum() 会偏低，
            # 直接算会造出假溢价。用官方 unit_nav 做分母校准，偏离 10% 就丢弃。
            mu, unav = unit.get((etf, sday), (None, None))
            iopv = np.nan
            if mu and unav and unav > 0:
                cov = mv.sum() / unav
                if 0.9 <= cov <= 1.1:
                    iopv = mv.sum() / mu
            epx = er_row.get(etf, np.nan)

            rows.append(dict(
                code=etf, date=day, pcf_day=sday, n_stock=len(sub),
                BREADTH=wavg('ab20'), BREADTH5=wavg('ab5'), CS_UP=wavg('up'),
                CS_MOM20=wmom, CS_MOM5=wavg('r5'),
                CS_DISP=disp, WIDE=(wmom - emom) if np.isfinite(emom) else np.nan,
                CONC=float(np.sum(w ** 2)), TOP10=float(np.sort(w)[-10:].sum()),
                CS_R1=cs_r1, ETF_R1=etf_r1,
                TRACK20=(etf_r20 - wmom) if np.isfinite(etf_r20) and np.isfinite(wmom) else np.nan,
                PREM_IOPV=(epx / iopv - 1) if np.isfinite(iopv) and iopv > 0 else np.nan,
            ))
        if k % 200 == 0:
            print(f'  {k}/{len(tdays)} 天，累计 {len(rows):,} 行', flush=True)

    F = pd.DataFrame(rows)
    print(f'\n日频面板 {F.shape}，{F.code.nunique()} 只 ETF')

    # 日频跟踪偏离：每天算「ETF 收益 − 成分股加权收益」，再累计 20 日。
    # 比「期末权重 × 20 日收益」干净：每日权重误差不累积。
    F = F.sort_values(['code', 'date'])
    F['TRACK_D'] = F['ETF_R1'] - F['CS_R1']
    F['TRACK'] = F.groupby('code')['TRACK_D'].transform(
        lambda s: s.rolling(20, min_periods=15).sum())

    # PREM_NAV：PCF 文件名的日期是 T（申赎日），但里面的 net value 是 T−1 收盘净值。
    # 已在原文核对：PCF 20261103 的 nav=2.4748 ↔ ETF 11-02 收盘 2.473。
    # 所以必须配前一交易日的原始收盘价，否则混进一天的涨跌，出现过 ±979% 的假折溢价。
    cal = E_raw.index

    def prev_td(d):
        i = cal.searchsorted(d, side='left')
        return cal[i - 1] if i > 0 else pd.NaT

    mm = meta.dropna(subset=['nav'])
    mm = mm[mm['nav'] > 0]
    nav_map = {(r.code, pd.Timestamp(r.date)): r.nav for r in mm.itertuples()}
    prems = []
    for c, d in zip(F['code'], F['pcf_day']):
        nav = nav_map.get((c, d))
        if nav is None or nav <= 0:
            prems.append(np.nan)
            continue
        pday = prev_td(d)
        if pday is pd.NaT or pday not in E_raw.index or c not in E_raw.columns:
            prems.append(np.nan)
            continue
        p = E_raw.at[pday, c]
        prems.append(float(p / nav - 1) if np.isfinite(p) else np.nan)
    F['PREM_NAV'] = prems

    F.to_csv(OUT / 'out_pcf_daily.csv', index=False)

    cols = ['BREADTH', 'BREADTH5', 'CS_UP', 'CS_MOM20', 'CS_MOM5', 'CS_DISP',
            'WIDE', 'CONC', 'TOP10', 'TRACK', 'TRACK20', 'CS_R1', 'ETF_R1',
            'PREM_IOPV', 'PREM_NAV']
    print('\n===== 描述统计 =====')
    print(F[cols].describe().T.to_string(float_format=lambda v: f'{v:+.4f}'))
    print(f'\n每日截面 ETF 数：中位 {F.groupby("date").size().median():.0f}，'
          f'min {F.groupby("date").size().min()}，max {F.groupby("date").size().max()}')
    print(f'有效天数 {F.date.nunique()}')
    print(f'PREM_NAV 覆盖 {F.PREM_NAV.notna().sum():,} 行 / {F[F.PREM_NAV.notna()].date.nunique()} 期')


if __name__ == '__main__':
    main()
