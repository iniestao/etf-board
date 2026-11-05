"""
成分股聚合因子：IC 检验
=======================
三个问题：
1. 横截面 —— 同一天 90+ 只 ETF，结构更健康的未来是不是跑得更好？
2. 时序   —— 全市场平均宽度能不能判断整体该减仓？
3. 正交   —— 和 ETF 自身动量是不是同一套信息？

IC 用 Spearman rank，t 值用 Newey-West（滞后 = 持有期−1），
因为 5/20 日收益重叠会高估显著性。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('/workspace/etf_board')
OUT = Path(__file__).parent

FACTORS = ['BREADTH', 'BREADTH5', 'CS_UP', 'CS_MOM20', 'CS_MOM5',
           'CS_DISP', 'WIDE', 'CONC', 'TOP10', 'TRACK', 'TRACK20',
           'PREM_IOPV', 'PREM_NAV']
HOLDS = [1, 5, 20]


def load_etf_px():
    con = sqlite3.connect(ROOT / 'data' / 'etf.db')
    d = pd.read_sql('SELECT code, date, close, adj_factor FROM etf_daily', con)
    con.close()
    d['date'] = pd.to_datetime(d['date'])
    d['px'] = d['close'] * d['adj_factor']
    return d.pivot_table(index='date', columns='code', values='px', aggfunc='last').sort_index()


def nw_t(x: np.ndarray, lag: int) -> tuple[float, float]:
    """Newey-West 修正的 t 值（重叠收益导致的序列相关）。"""
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 10:
        return np.nan, np.nan
    mu = x.mean()
    e = x - mu
    g0 = (e ** 2).sum() / n
    var = g0
    for l in range(1, min(lag, n - 1) + 1):
        gl = (e[l:] * e[:-l]).sum() / n
        var += 2 * (1 - l / (lag + 1)) * gl
    se = np.sqrt(max(var, 1e-12) / n)
    return mu, mu / se


def cross_section_ic(F: pd.DataFrame, E: pd.DataFrame, h: int) -> pd.DataFrame:
    """每日横截面 rank IC。"""
    fwd = E.shift(-h) / E - 1
    out = []
    for d, g in F.groupby('date'):
        if d not in fwd.index:
            continue
        r = fwd.loc[d]
        sub = g.set_index('code')
        rec = {'date': d, 'n': 0}
        ids = [c for c in sub.index if c in r.index and np.isfinite(r.get(c, np.nan))]
        if len(ids) < 20:
            continue
        rr = r.reindex(ids)
        rec['n'] = len(ids)
        for f in FACTORS:
            if f not in sub:
                rec[f] = np.nan
                continue
            v = sub[f].reindex(ids)
            ok = v.notna() & rr.notna()
            rec[f] = (v[ok].corr(rr[ok], method='spearman')
                      if ok.sum() >= 20 else np.nan)
        out.append(rec)
    return pd.DataFrame(out).set_index('date')


def main():
    # code 必须按字符串读：CSV 会把 510300 推成 int，跟价格矩阵的列名（字符串）对不上
    F = pd.read_csv(OUT / 'out_pcf_daily.csv', parse_dates=['date', 'pcf_day'],
                    dtype={'code': str})
    E = load_etf_px()
    print(f'因子面板 {F.shape} | {F.code.nunique()} 只 ETF | {F.date.nunique()} 天')

    # ============================================================ 1. 横截面 IC
    all_rows = []
    for h in HOLDS:
        ic = cross_section_ic(F, E, h)
        for f in FACTORS:
            if f not in ic:
                continue
            x = ic[f].dropna()
            if len(x) < 50:
                continue
            mu, t = nw_t(x.values, lag=max(h - 1, 0))
            all_rows.append(dict(
                factor=f, hold=h, n_days=len(x),
                IC=mu, t=t, ICIR=mu / x.std() if x.std() > 0 else np.nan,
                pos=(x > 0).mean(),
                ic_1d_mean=x.mean()))
        print(f'  持有 {h} 日完成', flush=True)

    R = pd.DataFrame(all_rows)
    R.to_csv(OUT / 'out_pcf_ic.csv', index=False)

    print('\n===== 横截面 IC（Newey-West t）=====')
    for h in HOLDS:
        sub = R[R.hold == h].sort_values('IC', key=abs, ascending=False)
        print(f'\n--- 持有 {h} 日 ---')
        print(sub[['factor', 'n_days', 'IC', 't', 'ICIR', 'pos']]
              .to_string(index=False, float_format=lambda v: f'{v:+.4f}'))

    # ============================================================ 2. 时序择时
    print('\n\n===== 时序：全市场平均宽度 → 未来收益 =====')
    mkt = F.groupby('date').agg(
        BREADTH=('BREADTH', 'mean'),
        CS_UP=('CS_UP', 'mean'),
        CS_DISP=('CS_DISP', 'mean'),
        PREM=('PREM_IOPV', 'median'),
        n=('code', 'size'))
    ew = (E.pct_change(fill_method=None).mean(axis=1))
    nav = (1 + ew.fillna(0)).cumprod()

    for h in HOLDS:
        fwd = nav.shift(-h) / nav - 1
        sub = pd.concat([mkt, fwd.rename('fwd')], axis=1).dropna(subset=['fwd'])
        print(f'\n--- 未来 {h} 日 ---')
        for f in ['BREADTH', 'CS_UP', 'CS_DISP', 'PREM']:
            x = sub[[f, 'fwd']].dropna()
            if len(x) < 200:
                continue
            # 5 日平滑，避免单日噪声
            s = x[f].rolling(5).mean()
            d = pd.concat([s, x['fwd']], axis=1).dropna()
            d.columns = ['s', 'r']
            rho = d['s'].corr(d['r'], method='spearman')
            # 重叠收益让有效样本只剩 n/h，t 按 sqrt(n/h) 保守折算
            ne = len(d) / max(h, 1)
            t = rho * np.sqrt(max(ne - 2, 1) / max(1 - rho ** 2, 1e-9))
            q = pd.qcut(d['s'].rank(method='first'), 3, labels=False)
            g = d['r'].groupby(q).mean()
            print(f'  {f:10s} rho={rho:+.4f} t={t:+.2f} | '
                  f'低组 {g.get(0, np.nan)*100:+.2f}% 高组 {g.get(2, np.nan)*100:+.2f}%')

    # ============================================================ 3. 正交性
    print('\n\n===== 正交性：与 ETF 自身动量的相关 =====')
    R1 = E.pct_change(fill_method=None)
    R20 = E.pct_change(20, fill_method=None)
    R60 = E.pct_change(60, fill_method=None)
    rev5 = E / E.shift(5) - 1

    rows = []
    for f in FACTORS:
        cs = []
        for d, g in F.groupby('date'):
            if d not in R20.index:
                continue
            sub = g.set_index('code')[f]
            ok = sub.notna() & R20.loc[d].reindex(sub.index).notna()
            if ok.sum() < 20:
                continue
            cs.append((sub[ok].corr(R20.loc[d].reindex(sub.index)[ok], method='spearman'),
                       sub[ok].corr(R60.loc[d].reindex(sub.index)[ok], method='spearman')
                       if d in R60.index else np.nan,
                       sub[ok].corr(rev5.loc[d].reindex(sub.index)[ok], method='spearman')
                       if d in rev5.index else np.nan))
        a = np.array(cs, dtype=float)
        rows.append(dict(factor=f,
                         corr_mom20=np.nanmedian(a[:, 0]),
                         corr_mom60=np.nanmedian(a[:, 1]),
                         corr_rev5=np.nanmedian(a[:, 2]),
                         max_abs=np.nanmax(np.abs(np.nanmedian(a, axis=0)))))
    print(pd.DataFrame(rows).to_string(index=False, float_format=lambda v: f'{v:+.3f}'))

    # ============================================================ 4. 折溢价专项
    print('\n\n===== 折溢价专项 =====')
    p = F.dropna(subset=['PREM_IOPV'])
    if len(p):
        print(f'IOPV 口径样本 {len(p):,} 行 / {p.date.nunique()} 天')
        print((p['PREM_IOPV'] * 100).describe().round(4).to_string())
        print(f'\n异常值(|PREM|>2%)占比 {(p["PREM_IOPV"].abs() > 0.02).mean():.2%}')

    pn = F.dropna(subset=['PREM_NAV'])
    if len(pn):
        print(f'\n官方净值口径样本 {len(pn):,} 行 / {pn.pcf_day.nunique()} 期')
        print((pn['PREM_NAV'] * 100).describe().round(4).to_string())


if __name__ == '__main__':
    main()
