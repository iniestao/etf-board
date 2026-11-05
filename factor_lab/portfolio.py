"""
组合回测（修正版）
==================
上一版的致命错误：用「H 日收益 / H」当日收益，把波动压低了 √H 倍，
持有 20 日时夏普被高估 4.5 倍，年化 7% 的组合能显示成夏普 1.6。

正确做法：追踪权重。
    w_t    = 每日选中的 top 集合，等权
    w_avg  = 过去 H 天的平均权重（= 每天只调 1/H 仓位的稳态）
    r_t    = Σ w_avg,{t-1} × ret_{i,t}      真实日频收益

这样 H 只影响换手（H 越大换手越低），不影响收益的量级和波动。

成交时点：T 日收盘算因子 → T+1 开盘建仓。回测用 w_{t-1} 乘 T 日 close-to-close
收益，等价于 T-1 日收盘建仓，比实盘乐观半天，属于可接受的保守近似。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from panel import Panel
from evaluate import ANN

COST = 0.0005


def build_score(ranks: dict[str, pd.DataFrame], weights: dict[str, float]) -> pd.DataFrame:
    tot = sum(weights.values())
    out = None
    for k, w in weights.items():
        v = ranks[k] * (w / tot)
        out = v if out is None else out.add(v, fill_value=0)
    return out


def backtest(score: pd.DataFrame, P: Panel, hold: int = 5, top_pct: float = 0.1,
             min_amt: float = 5e7, cost: float = COST,
             start: str | None = None, end: str | None = None,
             universe: pd.Series | None = None,
             target_vol: float | None = None) -> dict:
    ret = P.close.pct_change(fill_method=None)
    valid = score.notna() & P.close.notna() & (P.amount > min_amt)
    if getattr(P, 'tradable', None) is not None:
        valid = valid & P.tradable
    if universe is not None:
        u = universe.reindex(score.columns).fillna(False).astype(bool)
        valid = valid & u

    r = score.where(valid).rank(axis=1, pct=True)
    sel = (r >= (1 - top_pct)) & valid

    # 每日目标权重（等权）
    n = sel.sum(axis=1)
    w = sel.astype(np.float64).div(n.replace(0, np.nan), axis=0)

    # 稳态权重：过去 hold 天目标的平均（= 每天调 1/hold）
    w_avg = w.rolling(hold, min_periods=1).mean()

    # 真实日收益：必须按「有效权重」归一化。
    # 当日停牌/无价格的标的会让权重和 < 1，不除回去就等于系统性做空了一部分仓位。
    wl = w_avg.shift(1)
    has = ret.notna().astype(np.float64)
    num = (wl * ret).sum(axis=1, min_count=1)
    den = (wl * has).sum(axis=1, min_count=1)
    r_port = num / den.replace(0, np.nan)

    # 当日换手：权重变化绝对值之和的一半（买入额）
    to_daily = (w_avg - w_avg.shift(1)).abs().sum(axis=1) / 2

    # 波动率目标：只在实测波动高于目标时降仓，不加杠杆。
    # 仓位由 t-1 日收盘可得的实测波动决定，不引入前视。
    if target_vol:
        rv = r_port.rolling(20, min_periods=10).std() * np.sqrt(ANN)
        scale = (target_vol / rv.replace(0, np.nan)).clip(upper=1.0).shift(1).fillna(1.0)
        r_port = r_port * scale
        to_daily = to_daily * scale

    net = r_port - to_daily * 2 * cost

    # 基准必须用「昨日」的池子。用当日 valid 等于提前知道谁今天放量，
    # 而放量当天往往大涨——这会让基准凭空多出十几个点年化。
    bench = ret.where(valid.shift(1).fillna(False)).mean(axis=1)

    m = pd.Series(True, index=score.index)
    if start:
        m &= score.index >= pd.Timestamp(start)
    if end:
        m &= score.index <= pd.Timestamp(end)

    def stat(s: pd.Series) -> dict:
        s = s.dropna()
        if len(s) < 30:
            return dict(ann=np.nan, vol=np.nan, sharpe=np.nan, mdd=np.nan, win=np.nan, n=len(s))
        nav = (1 + s).cumprod()
        yrs = len(s) / ANN
        return dict(ann=float(nav.iloc[-1] ** (1 / yrs) - 1),
                    vol=float(s.std() * np.sqrt(ANN)),
                    sharpe=float(s.mean() / s.std() * np.sqrt(ANN)) if s.std() > 0 else np.nan,
                    mdd=float((nav / nav.cummax() - 1).min()),
                    win=float((s > 0).mean()), n=len(s))

    return dict(net=net[m], gross=r_port[m], bench=bench[m],
                to=float(to_daily[m].sum() * ANN / max(m.sum(), 1)),
                stat=stat(net[m]), stat_gross=stat(r_port[m]), stat_bench=stat(bench[m]),
                nav=(1 + net[m].fillna(0)).cumprod(),
                nav_bench=(1 + bench[m].fillna(0)).cumprod(),
                holding=float(sel[m].sum(axis=1).mean()),
                w_avg=w_avg[m])


def yearly(net: pd.Series, bench: pd.Series) -> pd.DataFrame:
    df = pd.DataFrame({'strategy': net, 'benchmark': bench})
    df['y'] = df.index.year
    out = []
    for y, g in df.groupby('y'):
        s, b = g['strategy'].dropna(), g['benchmark'].dropna()
        if len(s) < 20:
            continue
        nav = (1 + s).cumprod()
        out.append(dict(year=y,
                        ret=float(nav.iloc[-1] - 1),
                        bench=float((1 + b).prod() - 1),
                        excess=float(nav.iloc[-1] - 1) - float((1 + b).prod() - 1),
                        sharpe=float(s.mean() / s.std() * np.sqrt(ANN)),
                        mdd=float((nav / nav.cummax() - 1).min())))
    return pd.DataFrame(out)
