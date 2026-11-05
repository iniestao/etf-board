"""最终对照：样本内选因子 → 样本外验证。

三个候选策略，同一标的池、同一交易假设：
  A  单因子 PE（路径效率），100 个新因子里唯一两期都强的
  B  多因子组合：Alpha101 + 100 新因子合并候选，按样本内 t 值排序、IC 去重
  C  基准：标的池等权

选择规则全部只看 2020-2023。2024-2026 只跑一次。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path('/workspace/etf_board')
sys.path.insert(0, str(ROOT / 'alpha'))
sys.path.insert(0, str(ROOT / 'factor_lab'))

from panel import load_universe                          # noqa: E402
from factors import FACTORS, compute_all                 # noqa: E402
from alpha101 import Alpha101                            # noqa: E402
from evaluate import smooth, group_rank, mask_valid      # noqa: E402
from portfolio import backtest, yearly                   # noqa: E402

HOLD, TOP = 20, 0.20
TRAIN = ('2020-01-01', '2023-12-31')
SEGS = [('2021-2023', '2021-01-01', '2023-12-31'),
        ('2024-2026', '2024-01-01', '2026-11-03')]


def build(P):
    fs = dict(compute_all(P, verbose=False))
    data = dict(open=P.open, high=P.high, low=P.low, close=P.close,
                volume=P.volume, amount=P.amount)
    fs.update({k: v.astype(np.float32) for k, v in Alpha101(data, P.group).compute_all().items()})
    # 全局 rank：指数级池已经去掉同质化，组内强制配额反而变成主动超配小类
    ranks = {k: mask_valid(smooth(v, 10), P).rank(axis=1, pct=True)
             for k, v in fs.items()}
    return fs, ranks


def run(score, P, tag):
    out = {}
    for seg, s, e in SEGS:
        bt = backtest(score, P, hold=HOLD, top_pct=TOP, start=s, end=e)
        st = bt['stat']
        out[seg] = bt
        print(f'  {tag:10} {seg}  年化 {st["ann"]:+7.2%}  夏普 {st["sharpe"]:+5.2f}  '
              f'回撤 {st["mdd"]:+6.1%}  波动 {st["vol"]:5.1%}  换手 {bt["to"]:5.1f}  '
              f'持仓 {bt["holding"]:.0f}  基准 {bt["stat_bench"]["ann"]:+7.2%}')
    return out


def main():
    P = load_universe()
    print(f'标的池 {P.close.shape[1]} 个指数')
    fs, ranks = build(P)

    # ---- 样本内统计（含 Alpha101），用于策略 B 选因子
    from evaluate import evaluate as ev
    # 新因子的方向事先给定（来自文献假设）；Alpha101 没有先验方向，
    # 用训练期 IC 符号定向——这一步只用了 2020-2023，合法。
    dirs = {k: (FACTORS[k]['direction'] if k in FACTORS else 1) for k in fs}
    raw = ev(fs, P, dirs, *TRAIN, halflife=10).set_index('factor')
    dirs = {k: (dirs[k] if k in FACTORS else (1 if raw.loc[k, 'ic'] >= 0 else -1)) for k in fs}
    a0 = ev(fs, P, dirs, *TRAIN, halflife=10)
    a0['family'] = a0.factor.map(lambda k: FACTORS[k]['family'] if k in FACTORS else 'Alpha101')
    a0.to_csv('out_final_train.csv', index=False)

    cand = a0[(a0.t > 2.0) & (a0.net > 0)].sort_values('t', ascending=False)
    print(f'\n样本内候选 {len(cand)} 个（新 {sum(cand.family != "Alpha101")}，'
          f'Alpha101 {sum(cand.family == "Alpha101")}）')

    # IC 相关去重（训练期）
    ic = pd.read_parquet('wf_ic.parquet') if Path('wf_ic.parquet').exists() else None
    ic_tr = ic.loc[TRAIN[0]:TRAIN[1]] if ic is not None else None
    if ic is not None:
        # 覆盖率不足被 wf 剔除的因子，本来就不在候选里
        cand = cand[cand.factor.isin(ic_tr.columns)]
        cm = ic_tr[cand.factor.tolist()].corr()
    else:
        cm = None

    sel = []
    for k in cand.factor:
        if cm is None or all(abs(cm.loc[k, s]) < 0.6 for s in sel):
            sel.append(k)
        if len(sel) >= 6:
            break
    print('策略B 选中:', sel)

    # ---- 策略 A：单因子 PE
    print('\n[回测]')
    A = run(ranks['PE'], P, 'A:PE')

    # ---- 策略 B：多因子等权
    w = {k: 1.0 for k in sel}
    tot = sum(w.values())
    sb = None
    for k in sel:
        v = ranks[k] * (w[k] / tot)
        sb = v if sb is None else sb.add(v, fill_value=0)
    B = run(sb, P, 'B:组合')

    # ---- 基准
    one = pd.DataFrame(1.0, index=P.close.index, columns=P.close.columns)
    C = run(one, P, 'C:基准')

    # ---- 存净值与指标
    nav = {}
    for nm, obj in (('A', A), ('B', B)):
        for seg, bt in obj.items():
            nav[f'{nm}_{seg}'] = bt['nav']
            nav[f'{nm}_{seg}_bench'] = bt['nav_bench']
    pd.DataFrame(nav).dropna(how='all').to_csv('out_nav_final.csv')

    print('\n分年度（2024-2026，策略 A）')
    print(yearly(A['2024-2026']['net'], A['2024-2026']['bench']).to_string(index=False))
    print('\n分年度（2024-2026，策略 B）')
    print(yearly(B['2024-2026']['net'], B['2024-2026']['bench']).to_string(index=False))

    json.dump(dict(hold=HOLD, top=TOP, selected=sel,
                   A={k: v['stat'] for k, v in A.items()},
                   B={k: v['stat'] for k, v in B.items()},
                   bench={k: v['stat_bench'] for k, v in A.items()},
                   to_A={k: v['to'] for k, v in A.items()},
                   to_B={k: v['to'] for k, v in B.items()}),
              open('out_final.json', 'w'), indent=2, ensure_ascii=False)
    print('\n完成')


if __name__ == '__main__':
    main()
