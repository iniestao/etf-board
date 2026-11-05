"""
把因子实验室的结果导出成前端可内嵌的 lab_data.js。
=====================================================
页面上的「因子研究」原本只有 Alpha101 一套（个股口径、1717 只 ETF）。
这一份补上指数去重后的第二批：100 个新因子 + Alpha101 同池对照 + PE 单因子策略。

输入：out_cross.csv（新因子）、out_alpha_cross.csv（Alpha101）、out_single_abs.csv
输出：worker/src/lab_data.js、factor_lab/lab_data.json
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from panel import load_universe
from factors import compute_all
from evaluate import smooth, mask_valid
from portfolio import backtest, yearly

HERE = Path(__file__).parent
ROOT = HERE.parent
OUT_JS = ROOT / 'worker' / 'src' / 'lab_data.js'
OUT_JSON = HERE / 'lab_data.json'

START, END = '2019-06-01', '2026-11-03'
HOLD, TOP = 20, 0.20


def main() -> None:
    P = load_universe()
    n_idx = P.close.shape[1]

    # ---------------- PE 策略：全段 + 分年度 + 净值 ----------------
    print('[1/3] 计算 PE 因子并跑全段回测', flush=True)
    pe = compute_all(P, verbose=False, names=['PE'])['PE']
    score = mask_valid(smooth(pe, 10), P).rank(axis=1, pct=True)
    bt = backtest(score, P, hold=HOLD, top_pct=TOP, start=START, end=END)

    st, sb = bt['stat'], bt['stat_bench']
    pe_all = dict(ann=st['ann'], vol=st['vol'], sharpe=st['sharpe'], mdd=st['mdd'],
                  win=st['win'], n=st['n'], to=bt['to'], holding=bt['holding'],
                  b_ann=sb['ann'], b_vol=sb['vol'], b_sharpe=sb['sharpe'],
                  b_mdd=sb['mdd'], b_win=sb['win'], b_n=sb['n'])

    ye = yearly(bt['net'], bt['bench'])
    yearly_rows = [[int(r.year), float(r.ret), float(r.bench), float(r.excess)]
                   for r in ye.itertuples()]

    # 净值抽月末点：日频 1800 个点内嵌进页面太重，画曲线 80 个点已足够。
    # 不用 resample('ME')——它会把 11 月那格标成 11-30，而实际最后一天是 11-03。
    nav = pd.DataFrame({'s': bt['nav'], 'b': bt['nav_bench']}).dropna(how='all')
    mo = nav.groupby([nav.index.year, nav.index.month]).tail(1)
    mo = pd.concat([nav.iloc[[0]], mo]).drop_duplicates()
    nav_rows = [[d.strftime('%Y-%m-%d'), round(float(r.s), 4), round(float(r.b), 4)]
                for d, r in mo.iterrows() if np.isfinite(r.s)]

    # ---------------- 201 个因子的两期统计 ----------------
    print('[2/3] 合并因子统计', flush=True)
    new = pd.read_csv(HERE / 'out_cross.csv')
    alp = pd.read_csv(HERE / 'out_alpha_cross.csv')
    alp['family'] = 'Alpha101'
    both = pd.concat([new, alp], ignore_index=True)

    from factors import FACTORS

    def f(v):
        return None if v is None or not np.isfinite(v) else round(float(v), 4)

    # desc 一并带过去：201 行表格里只有代码名，读起来像天书。
    # Alpha101 的中文名在页面的 alpha_meta.js 里有，这里留空。
    desc = {k: (v.get('desc') or '')[:46] for k, v in FACTORS.items()}
    cross = [[r.factor, r.family, f(r.ic_in), f(r.t_in), f(r.net_in),
              f(r.ic_out), f(r.t_out), f(r.net_out), desc.get(r.factor, '')]
             for r in both.itertuples()]

    sig = (both.t_in > 2) & (both.net_in > 0)
    ok = (both.t_out > 1.5) & (both.net_out > 0)
    counts = dict(
        n_new=int((both.family != 'Alpha101').sum()),
        n_alpha=int((both.family == 'Alpha101').sum()),
        sig_in=int(sig.sum()), alive=int((sig & ok).sum()),
        only_out=int((ok & ~sig).sum()),
        alive_list=[r.factor for r in both[sig & ok].itertuples()],
        # 分家族：两期都显著的数量
        fam_alive={k: int(v) for k, v in both[sig & ok].family.value_counts().items()},
        # 多头超额为正的比例（更贴近实盘）
        pos_out_new=int((new.net_out > 0).sum()),
        pos_out_alpha=int((alp.net_out > 0).sum()),
    )

    # ---------------- 敏感性（PE 窗口） ----------------
    print('[3/3] 读入敏感性网格', flush=True)
    sens = []
    p = HERE / 'out_pe_sens.csv'
    if p.exists():
        s = pd.read_csv(p)
        # 45 组全带上，页面自己按 hold/top 过滤出要展示的那一片。
        # 列名带减号（ann_21-23），itertuples 会改名，用 iterrows 稳妥。
        for _, r in s.iterrows():
            sens.append([int(r['win']), int(r['hold']), float(r['top']),
                         round(float(r['ex_21-23']), 4), round(float(r['ex_24-26']), 4)])

    data = dict(
        generated_at=datetime.now().strftime('%Y-%m-%dT%H:%M:%S'),
        universe=dict(n_idx=n_idx, n_etf=1617),
        window=[START, END],
        param=dict(hold=HOLD, top=TOP, cost=0.0005),
        pe=dict(all=pe_all, yearly=yearly_rows, nav=nav_rows),
        counts=counts,
        cross=cross,
        sens=sens,
    )

    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    body = ('// 由 factor_lab/export_lab.py 生成，勿手改\n'
            + 'export const LAB = ' + json.dumps(data, ensure_ascii=False,
                                               separators=(',', ':')) + ';\n')
    OUT_JS.write_text(body, encoding='utf-8')

    print(f'已生成 {OUT_JS}  {len(body)/1024:.1f} KB')
    print(f'  {n_idx} 个指数 / {len(cross)} 个因子 / PE 年化 {pe_all["ann"]:+.2%}'
          f' / 基准 {pe_all["b_ann"]:+.2%}')
    print(f'  两期都显著 {counts["alive"]} 个：{counts["alive_list"]}')


if __name__ == '__main__':
    main()
