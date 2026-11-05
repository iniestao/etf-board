"""
主流程：训练期选因子 → 组合 → 样本外验证
=========================================
铁律：所有选择（哪些因子、什么权重、什么参数）只看 2020-2023。
2024-2026 只在最后跑一次，结果是什么就报什么，不回头调。
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from panel import load_universe
from factors import FACTORS, compute_all
from evaluate import (forward_return, smooth, group_rank, mask_valid,
                      ic_series, ic_stats, layered, perf_arith, turnover, ANN)
from portfolio import backtest, build_score, yearly, COST

TRAIN = ('2020-01-01', '2023-12-31')
TEST = ('2024-01-01', '2026-11-03')
HL = 10


def factor_stats(P, fs, fwd, start, end):
    idx = P.date
    m = (idx >= start) & (idx <= end)
    ranks, rows = {}, []
    for k, f in fs.items():
        sgn = FACTORS[k]['direction']
        fr = group_rank(mask_valid(smooth(f * sgn, HL), P), P.group)
        ranks[k] = fr
        ic_all = ic_series(fr.loc[m], fwd.loc[m])
        st = ic_stats(ic_all)
        mid = pd.Timestamp('2022-01-01')
        st['ic_h1'] = float(ic_all[ic_all.index < mid].mean())
        st['ic_h2'] = float(ic_all[ic_all.index >= mid].mean())
        lay = layered(fr.loc[m], fwd.loc[m])
        ex = perf_arith(lay['excess'])
        to = turnover(fr.loc[m])
        rows.append(dict(factor=k, family=FACTORS[k]['family'], **st,
                         ex_ann=ex['ann'], ex_ir=ex['sharpe'],
                         to=to, net=ex['ann'] - to * COST * 2))
    return ranks, pd.DataFrame(rows)


def corr_matrix(ranks, start, end):
    idx = next(iter(ranks.values())).index
    m = (idx >= start) & (idx <= end)
    names = list(ranks)
    arr = {k: v.loc[m].rank(axis=1) for k, v in ranks.items()}
    out = pd.DataFrame(np.eye(len(names)), index=names, columns=names)
    for i, a in enumerate(names):
        A = arr[a]
        for b in names[i + 1:]:
            B = arr[b]
            both = A.notna() & B.notna()
            aa = A.where(both).sub(A.where(both).mean(axis=1), axis=0)
            bb = B.where(both).sub(B.where(both).mean(axis=1), axis=0)
            den = np.sqrt((aa ** 2).sum(axis=1) * (bb ** 2).sum(axis=1))
            rho = ((aa * bb).sum(axis=1) / den.replace(0, np.nan)).dropna()
            if len(rho) < 50:
                continue
            v = float(np.tanh(np.arctanh(rho.clip(-0.999, 0.999)).mean()))
            out.loc[a, b] = out.loc[b, a] = v
    return out


def select(tab, cm, t_min=2.0, rho_max=0.6, topk=6):
    """候选池要求：训练期显著 + 两个子期 IC 同号。
    子期检验是防「只在一小段行情里有效」——这是样本外失效的头号原因。"""
    cand = tab[(tab.t > t_min) & (tab.net > 0) & (tab.ic_h1 > 0) & (tab.ic_h2 > 0)]
    cand = cand.sort_values('t', ascending=False)
    sel = []
    for _, x in cand.iterrows():
        if all(abs(cm.loc[x.factor, s]) < rho_max for s in sel):
            sel.append(x.factor)
        if len(sel) >= topk:
            break
    return sel


def main():
    P = load_universe()
    print('计算因子…', flush=True)
    fs = compute_all(P, verbose=False)
    fwd = forward_return(P)

    print('\n[训练期] 单因子统计 2020-2023', flush=True)
    ranks, tab = factor_stats(P, fs, fwd, *TRAIN)
    tab.to_csv('out_train.csv', index=False)
    cm = corr_matrix(ranks, *TRAIN)
    cm.to_csv('out_corr_train.csv')

    sel = select(tab, cm, t_min=2.0, rho_max=0.6, topk=6)
    sub = tab.set_index('factor').loc[sel]
    print('选出：')
    for k in sel:
        r = sub.loc[k]
        print(f'  {k:12} {r.family:10} IC {r.ic:+.4f} t {r.t:5.2f} 净 {r.net:+.2%} 换手 {r.to:5.1f}')

    # 两种权重
    ws = {
        'equal': {k: 1.0 for k in sel},
        'icir': {k: max(sub.loc[k, 'icir'], 0.01) for k in sel},
    }

    # 参数事前固定：10 日调仓（换手可控）、top 20%（约 30-70 只，分散够）。
    # 不做网格搜索——在 4 年训练期上搜参数，选出来的多半是过拟合。
    HOLD_FIX, TOP_FIX = 10, 0.20
    scores = {wn: build_score({k: ranks[k] for k in sel}, w) for wn, w in ws.items()}
    print(f'标的池 {P.close.shape[1]} 个指数（股票+商品，已去重）')
    gdf = pd.DataFrame([dict(weight='fixed', hold=HOLD_FIX, top=TOP_FIX)])
    gdf.to_csv('out_grid.csv', index=False)
    print(f'\n参数固定：hold={HOLD_FIX} top={TOP_FIX:.0%}')
    best_score = scores['icir']
    best_hold, best_top = HOLD_FIX, TOP_FIX

    print('\n[回测] 固定最优参数，训练/样本外', flush=True)
    res = {}
    for tag, (s, e) in [('train', TRAIN), ('test', TEST)]:
        bt = backtest(best_score, P, hold=best_hold, top_pct=best_top, start=s, end=e,
                      target_vol=0.20)
        st = bt['stat']
        print(f'  {tag:6} 年化 {st["ann"]:+.2%} 夏普 {st["sharpe"]:+.2f} '
              f'回撤 {st["mdd"]:+.1%} 胜率 {st["win"]:.1%} 换手 {bt["to"]:.1f} '
              f'持仓 {bt["holding"]:.0f}')
        res[tag] = bt

    # 基准
    bt_b = backtest(pd.DataFrame(1.0, index=P.close.index, columns=P.close.columns),
                    P, hold=5, top_pct=0.1, start=TEST[0], end=TEST[1])
    print(f'  基准(全池等权) test 年化 {bt_b["stat_bench"]["ann"]:+.2%} '
          f'夏普 {bt_b["stat_bench"]["sharpe"]:+.2f} '
          f'回撤 {bt_b["stat_bench"]["mdd"]:+.1%}')

    # 存净值
    out = {}
    for tg, bt in res.items():
        out[f'{tg}'] = bt['nav']
        out[f'{tg}_bench'] = bt['nav_bench']
    pd.DataFrame(out).to_csv('out_nav.csv')

    print('\n[分年度] 样本外')
    print(yearly(res['test']['net'], res['test']['bench']).to_string(index=False))

    summary = dict(selected=sel, weights=ws['icir'], hold=best_hold, top=best_top,
                   train=res['train']['stat'], test=res['test']['stat'],
                   bench=bt_b['stat_bench'], grid=gdf.head(5).to_dict('records'))
    json.dump(summary, open('out_result.json', 'w'), indent=2, ensure_ascii=False)


if __name__ == '__main__':
    main()
