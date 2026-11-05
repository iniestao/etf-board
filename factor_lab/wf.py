"""Walk-forward：无前视的因子组合检验。

两个关键设计
------------
1. **选择只用历史**：每个调仓日 T，只用 T 之前 36 个月的数据决定用哪些因子、
   什么方向、什么权重，然后持有到下个调仓日。2019 年之后每一段都是真样本外。

2. **用「多头超额」而不是 IC 选因子**。这是 ETF 与个股最大的区别：
   ETF 不能做空，IC 为正可能完全来自空头端（因子值低的跌得更多），
   而多头端没有超额。上一轮已经撞上这个坑——MOM_12_1 样本外 IC +0.025（t=1.9）
   看着还行，做多 top20% 却是 -4.1% 超额，因为它的收益全在空头端。
   所以这里直接用「历史上做多 top20% 相对全池的日超额」作为筛选标准，
   它衡量的就是实盘能拿到的东西。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('/workspace/etf_board')
sys.path.insert(0, str(ROOT / 'alpha'))
sys.path.insert(0, str(ROOT / 'factor_lab'))

from panel import load_universe                          # noqa: E402
from factors import FACTORS, compute_all                 # noqa: E402
from alpha101 import Alpha101                            # noqa: E402
from evaluate import (forward_return, smooth, group_rank, mask_valid,  # noqa: E402
                      ic_series, ANN)
from portfolio import backtest, yearly                   # noqa: E402

HL = 10
LOOKBACK = 756
MIN_DAYS = 200
T_MIN = 1.0          # 多头超额 t 值下限
ANN_EX_MIN = 0.01    # 年化超额下限，避免「显著但幅度太小」
TOPK = 8
RHO_MAX = 0.6
START = '2021-01-01'
END = '2026-11-03'
TOPPCT = 0.20


def load_all_factors(P) -> tuple[dict, dict]:
    fs = dict(compute_all(P, verbose=False))
    meta = {k: dict(family=v['family'], src='new') for k, v in FACTORS.items()}
    data = dict(open=P.open, high=P.high, low=P.low, close=P.close,
                volume=P.volume, amount=P.amount)
    for k, v in Alpha101(data, P.group).compute_all().items():
        fs[k] = v.astype(np.float32)
        meta[k] = dict(family='Alpha101', src='a101')
    return fs, meta


def rebal_dates(idx: pd.DatetimeIndex) -> pd.DatetimeIndex:
    s = pd.Series(idx, index=idx)
    return pd.DatetimeIndex(s.groupby([idx.year, idx.month]).last().values)


def main():
    t0 = time.time()
    P = load_universe()
    print(f'标的池 {P.close.shape[1]} 个指数，{P.date[0].date()} → {P.date[-1].date()}')

    fs, meta = load_all_factors(P)
    print(f'因子 {len(fs)} 个（Alpha101 {sum(1 for v in meta.values() if v["src"]=="a101")}）')

    tail = P.date >= P.date[-1] - pd.Timedelta(days=365)
    cov = {k: float(v.loc[tail].notna().mean().mean()) for k, v in fs.items()}
    keep = [k for k, c in cov.items() if c >= 0.60]
    print(f'覆盖率过滤：保留 {len(keep)}，剔除 {len(fs)-len(keep)}')

    print('平滑 + 组内 rank…', flush=True)
    ranks = {}
    for i, k in enumerate(keep, 1):
        ranks[k] = group_rank(mask_valid(smooth(fs[k], HL), P), P.group, min_n=4)
        if i % 50 == 0:
            print(f'  {i}/{len(keep)}', flush=True)
    del fs

    fwd = forward_return(P)

    # ---------------------------------------------------------------- 多头超额序列
    print('多头超额序列…', flush=True)
    ex, ic = {}, {}
    for k in keep:
        fr = ranks[k]
        sel = fr >= (1 - TOPPCT)
        long_r = fwd.where(sel).mean(axis=1)
        all_r = fwd.where(fr.notna()).mean(axis=1)
        ex[k] = (long_r - all_r) / 5.0
        ic[k] = ic_series(fr, fwd)
    EX = pd.DataFrame(ex)
    pd.DataFrame(ic).to_parquet('wf_ic.parquet')
    EX.to_parquet('wf_ex.parquet')
    print(f'  {EX.shape}，耗时 {time.time()-t0:.0f}s')

    # ---------------------------------------------------------------- 滚动选因子
    reb = rebal_dates(P.date)
    reb = reb[(reb >= pd.Timestamp(START)) & (reb <= pd.Timestamp(END))]
    print(f'\n调仓日 {len(reb)} 个：{reb[0].date()} → {reb[-1].date()}')

    picks = []
    for t in reb:
        hist = EX.loc[:t].iloc[-LOOKBACK:]
        n = hist.notna().sum()
        mu, sd = hist.mean(), hist.std()
        tv = (mu / sd) * np.sqrt(n)
        ann = mu * ANN
        ok = (n >= MIN_DAYS) & (tv > T_MIN) & (ann > ANN_EX_MIN)
        cand = tv[ok].sort_values(ascending=False).head(30)
        cm = hist[cand.index].corr()
        sel = []
        for k in cand.index:
            if all(abs(cm.loc[k, s]) < RHO_MAX for s in sel):
                sel.append(k)
            if len(sel) >= TOPK:
                break
        picks.append((t, sel, {k: float(tv[k]) for k in sel}))
        if len(picks) % 12 == 1:
            print(f'  {t.date()} 选中 {len(sel)} 个: {sel}', flush=True)

    print('\n各期因子数分布', pd.Series([len(s) for _, s, _ in picks]).value_counts().to_dict())

    # ---------------------------------------------------------------- 拼 score
    print('\n拼 score…', flush=True)
    score = pd.DataFrame(np.nan, index=P.date, columns=P.close.columns, dtype=np.float32)
    for i, (t, sel, w) in enumerate(picks):
        m = (P.date >= t) & (P.date <= (picks[i + 1][0] if i + 1 < len(picks) else P.date[-1]))
        if not sel:
            continue
        tot = sum(w.values())
        s = None
        for k in sel:
            v = ranks[k].loc[m] * (w[k] / tot)
            s = v if s is None else s.add(v, fill_value=0)
        score.loc[m] = s.values

    # ---------------------------------------------------------------- 回测
    print('\n[回测] hold=20 top=20% vol target 20%')
    out = {}
    for tag, s, e in [('2021-2023', '2021-01-01', '2023-12-31'),
                      ('2024-2026', '2024-01-01', END)]:
        bt = backtest(score, P, hold=20, top_pct=TOPPCT, start=s, end=e, target_vol=0.20)
        st = bt['stat']
        print(f'  {tag} 年化 {st["ann"]:+.2%} 夏普 {st["sharpe"]:+.2f} 回撤 {st["mdd"]:+.1%} '
              f'换手 {bt["to"]:.1f} 持仓 {bt["holding"]:.0f} | 基准 {bt["stat_bench"]["ann"]:+.2%}')
        out[tag] = bt

    pd.DataFrame({'a': out['2021-2023']['nav'], 'a_bench': out['2021-2023']['nav_bench'],
                  'b': out['2024-2026']['nav'], 'b_bench': out['2024-2026']['nav_bench']}
                 ).to_csv('out_nav_wf.csv')
    print('\n分年度')
    print(yearly(out['2024-2026']['net'], out['2024-2026']['bench']).to_string(index=False))

    freq = pd.Series([k for _, s, _ in picks for k in s]).value_counts()
    print('\n被选次数 top15')
    print(freq.head(15).to_string())
    freq.to_csv('out_wf_freq.csv')

    json.dump(dict(hold=20, top=TOPPCT, lookback=LOOKBACK, topk=TOPK, t_min=T_MIN,
                   n_factors=len(keep),
                   a=out['2021-2023']['stat'], b=out['2024-2026']['stat'],
                   bench_b=out['2024-2026']['stat_bench'],
                   picks=[(str(t.date()), s) for t, s, _ in picks]),
              open('out_wf.json', 'w'), indent=2, ensure_ascii=False)
    print(f'\n总耗时 {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
