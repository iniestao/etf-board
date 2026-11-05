"""
因子检验 v2
===========
上一版的三个问题，这一版全部修掉：

1. **多空复利失真**：`(1+ls).cumprod()` 在日波动 3% 的多空组合上会被波动拖累
   吃掉十几个点，导致「分层单调递增但多空年化为负」的荒谬结果。
   改成算术年化（mean×244），并把**只多 Q5 相对全池等权的超额**作为主指标——
   ETF 不能做空，能交易的只有这一条。

2. **换手不可行**：日频技术位置类因子年换手 3000%+，5bp 单边成本要吃掉 16%/年。
   加 EMA 平滑（半衰期可调），换手降一个量级再看 IC 还剩多少。

3. **评价维度单一**：同时给 IC（因子纯度）、超额 IR（可交易性）、净收益（扣成本）。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from panel import Panel, load_universe

HOLD = 5
COST = 0.0005      # 单边，ETF 佣金万 0.5 + 冲击
ANN = 244


# ------------------------------------------------------------------ 标签
def forward_return(P: Panel, hold: int = HOLD) -> pd.DataFrame:
    return P.open.shift(-(hold + 1)) / P.open.shift(-1) - 1


# ------------------------------------------------------------------ 预处理
def smooth(f: pd.DataFrame, halflife: float) -> pd.DataFrame:
    """时间序列 EMA 平滑。halflife<=1 视为不平滑。"""
    if halflife <= 1:
        return f
    return f.ewm(halflife=halflife, min_periods=3).mean()


def group_rank(f: pd.DataFrame, group: pd.Series, min_n: int = 8) -> pd.DataFrame:
    g = group.reindex(f.columns)
    out = pd.DataFrame(np.nan, index=f.index, columns=f.columns, dtype=np.float64)
    for _, codes in f.columns.to_series().groupby(g):
        cols = list(codes.values)
        sub = f[cols]
        cnt = sub.notna().sum(axis=1)
        out.loc[:, cols] = sub.rank(axis=1, pct=True).where(cnt >= min_n, np.nan).values
    return out.astype(np.float32)


def mask_valid(f: pd.DataFrame, P: Panel, min_amount: float = 5e6) -> pd.DataFrame:
    ok = P.close.notna() & (P.amount > min_amount)
    if getattr(P, 'tradable', None) is not None:
        ok = ok & P.tradable
    return f.where(ok)


# ------------------------------------------------------------------ IC
def ic_series(fr: pd.DataFrame, fwd: pd.DataFrame, min_n: int = 20) -> pd.Series:
    rr = fwd.rank(axis=1, pct=True)
    both = fr.notna() & rr.notna()
    aa = fr.where(both)
    bb = rr.where(both)
    a = aa.sub(aa.mean(axis=1), axis=0)
    b = bb.sub(bb.mean(axis=1), axis=0)
    num = (a * b).sum(axis=1, min_count=1)
    den = np.sqrt((a ** 2).sum(axis=1, min_count=1) * (b ** 2).sum(axis=1, min_count=1))
    n = both.sum(axis=1)
    return (num / den.replace(0, np.nan)).where(n >= min_n)


def ic_stats(ic: pd.Series) -> dict:
    s = ic.dropna()
    if len(s) < 20:
        return dict(n=len(s), ic=np.nan, icir=np.nan, t=np.nan, pos=np.nan)
    m, sd = s.mean(), s.std()
    icir = m / sd if sd > 0 else np.nan
    return dict(n=len(s), ic=float(m), icir=float(icir),
                t=float(icir * np.sqrt(len(s))), pos=float((s > 0).mean()))


# ------------------------------------------------------------------ 分层
def layered(fr: pd.DataFrame, fwd: pd.DataFrame, nq: int = 5) -> dict:
    """返回各层日收益（重叠 5 日组合，已除以 HOLD），以及多空、多头超额。"""
    q = np.ceil(fr * nq).clip(1, nq)
    col = {}
    for k in range(1, nq + 1):
        w = (q == k) & fr.notna() & fwd.notna()
        col[k] = fwd.where(w).mean(axis=1) / HOLD
    df = pd.DataFrame(col)
    allr = fwd.where(fr.notna() & fwd.notna()).mean(axis=1) / HOLD
    return dict(layers=df, ls=df[nq] - df[1], long=df[nq], excess=df[nq] - allr, allr=allr)


def perf_arith(r: pd.Series) -> dict:
    """算术年化口径，避开复利波动拖累。"""
    s = r.dropna()
    if len(s) < 30:
        return dict(ann=np.nan, vol=np.nan, sharpe=np.nan, mdd=np.nan, win=np.nan)
    ann_r = s.mean() * ANN
    vol = s.std() * np.sqrt(ANN)
    sharpe = ann_r / vol if vol > 0 else np.nan
    nav = (1 + s).cumprod()
    mdd = float((nav / nav.cummax() - 1).min())
    return dict(ann=float(ann_r), vol=float(vol), sharpe=float(sharpe),
                mdd=mdd, win=float((s > 0).mean()))


def turnover(fr: pd.DataFrame, nq: int = 5) -> float:
    """年化单边换手：每次换仓的成员变动比例 × (244/HOLD)。"""
    q = np.ceil(fr * nq).clip(1, nq)
    sel = (q == nq)
    prev = sel.shift(HOLD).fillna(False)
    changed = (sel != prev) & sel.notna()
    chg = changed.sum(axis=1) / sel.sum(axis=1).replace(0, np.nan)
    return float(chg.mean()) * (ANN / HOLD)


# ------------------------------------------------------------------ 主流程
def evaluate(factors: dict[str, pd.DataFrame], P: Panel, direction: dict[str, int],
             start: str, end: str | None = None, halflife: float = 1,
             min_n: int = 20) -> pd.DataFrame:
    fwd = forward_return(P)
    idx = P.date
    m = idx >= pd.Timestamp(start)
    if end:
        m &= idx <= pd.Timestamp(end)
    rows = []
    for name, f in factors.items():
        sgn = direction.get(name, 1)
        fs = smooth(f * sgn, halflife)
        fr = group_rank(mask_valid(fs, P), P.group).loc[m]
        fw = fwd.loc[m]
        st = ic_stats(ic_series(fr, fw, min_n))
        lay = layered(fr, fw)
        ex = perf_arith(lay['excess'])
        ls = perf_arith(lay['ls'])
        to = turnover(fr)
        rows.append(dict(factor=name, **st,
                         ex_ann=ex['ann'], ex_vol=ex['vol'], ex_ir=ex['sharpe'],
                         ex_mdd=ex['mdd'],
                         ls_ann=ls['ann'], ls_sharpe=ls['sharpe'],
                         to=to, net=ex['ann'] - to * COST * 2))
    return pd.DataFrame(rows).sort_values('icir', ascending=False)


if __name__ == '__main__':
    import time
    from factors import FACTORS, compute_all

    t0 = time.time()
    P = load_universe()
    fs = compute_all(P, verbose=False)
    dirs = {k: v['direction'] for k, v in FACTORS.items()}
    for hl, tag in [(1, '不平滑'), (5, 'EMA5'), (10, 'EMA10')]:
        r = evaluate(fs, P, dirs, '2020-01-01', '2023-12-31', halflife=hl)
        r.to_csv(f'out_in_hl{hl}.csv', index=False)
        print(f'\n===== 样本内 2020-2023，{tag} =====')
        print(f'{"因子":14}{"IC":>8}{"ICIR":>8}{"t":>7}{"超额年化":>9}{"超额IR":>8}{"换手":>7}{"净":>8}')
        for _, x in r.head(12).iterrows():
            print(f'{x.factor:14}{x.ic:8.4f}{x.icir:8.3f}{x.t:7.2f}{x.ex_ann:9.2%}'
                  f'{x.ex_ir:8.2f}{x.to:7.1f}{x.net:8.2%}')
    print(f'\n耗时 {time.time()-t0:.0f}s')
