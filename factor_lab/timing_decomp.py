"""
分解与敏感性
============
C 策略（波动目标 × 趋势过滤）夏普 0.91，看起来比买入持有 0.50 好很多。但在相信它
之前得回答四个问题：

1) 是谁在贡献？波动目标和趋势过滤各自值多少，还是必须两个一起才有效？
2) 参数敏感吗？目标波动取 10%/15%/20%、趋势阈值取 0/±5%，结果会不会翻脸？
3) 成本吃掉多少？现在按 5bp、年换手 8 次算，提到 20bp 还活不活得下来？
4) 换成真能买的标的还成立吗？"1717 只 ETF 等权"是个理论组合，实盘买不到。
   必须换成 510300 / 510500 这种单只宽基 ETF 再看一遍。
"""
from __future__ import annotations

import itertools
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
S = pd.read_parquet(HERE / 'state.parquet').dropna(subset=['mkt'])
COST = 0.0005


def stats(r: pd.Series, w: pd.Series, yrs: float) -> dict:
    # 仓位滞后一期：t 日收盘的信号只能吃 t+1 的收益
    w_eff = w.shift(1).fillna(0.0)
    turn = (w - w_eff).abs()
    rs = w_eff * r - turn * COST
    nav = (1 + rs).cumprod()
    ann = nav.iloc[-1] ** (1 / yrs) - 1
    vol = rs.std() * np.sqrt(242)
    dd = float((nav / nav.cummax() - 1).min())
    return {'年化': ann * 100, '波动': vol * 100, '夏普': ann / vol if vol > 0 else np.nan,
            '回撤': dd * 100, '换手': turn.sum() / yrs}


def build(sub: pd.DataFrame, tgt: float, thr: float, use_vol: bool, use_trend: bool) -> pd.Series:
    w = pd.Series(1.0, index=sub.index)
    if use_vol:
        w = w * (tgt / sub['vol20']).clip(upper=1.0).fillna(0)
    if use_trend:
        w = w.where(sub['mom60'] >= thr, w * 0.5)
    return w.fillna(0)


def main() -> None:
    yrs = len(S) / 242
    print('=== 1) 组件分解（全样本 %.1f 年） ===' % yrs)
    print('%-28s %8s %8s %8s %8s %8s' % ('组合', '年化%', '波动%', '夏普', '回撤%', '换手'))
    combos = [
        ('仅波动目标 15%', True, False),
        ('仅趋势过滤', False, True),
        ('波动 + 趋势', True, True),
    ]
    for lab, uv, ut in combos:
        w = build(S, 0.15, 0.0, uv, ut)
        d = stats(S['mkt'], w, yrs)
        print('%-28s %8.1f %8.1f %8.2f %8.1f %8.2f'
              % (lab, d['年化'], d['波动'], d['夏普'], d['回撤'], d['换手']))
    d = stats(S['mkt'], pd.Series(1.0, index=S.index), yrs)
    print('%-28s %8.1f %8.1f %8.2f %8.1f %8.2f'
          % ('买入持有', d['年化'], d['波动'], d['夏普'], d['回撤'], d['换手']))

    print()
    print('=== 2) 参数网格：目标波动 × 趋势阈值（夏普） ===')
    tgts = [0.10, 0.12, 0.15, 0.18, 0.20]
    thrs = [-0.05, 0.0, 0.05]
    print('%-10s' % '' + ''.join('%9s' % ('thr%+.0f%%' % (t * 100)) for t in thrs))
    for g in tgts:
        vals = []
        for t in thrs:
            w = build(S, g, t, True, True)
            vals.append(stats(S['mkt'], w, yrs)['夏普'])
        print('tgt %2.0f%%  ' % (g * 100) + ''.join('%9.2f' % v for v in vals))

    print()
    print('=== 3) 成本敏感性（波动 15% + 趋势 0，全样本） ===')
    w = build(S, 0.15, 0.0, True, True)
    for c in (0.0005, 0.001, 0.002, 0.003):
        w_eff = w.shift(1).fillna(0.0)
        turn = (w - w_eff).abs()
        rs = w_eff * S['mkt'] - turn * c
        ann = (1 + rs).cumprod().iloc[-1] ** (1 / yrs) - 1
        vol = rs.std() * np.sqrt(242)
        print('  单边 %4.1f bp: 年化 %+6.2f%%  夏普 %5.2f' % (c * 1e4, ann * 100, ann / vol))

    print()
    print('=== 4) 换成可交易标的 ===')
    db = '/workspace/etf_board/data/etf.db'
    con = sqlite3.connect(db)
    print('%-14s %8s %8s %8s %8s %8s' % ('标的', '年化%', '波动%', '夏普', '回撤%', '换手'))
    for code, nm in (('510300', '沪深300ETF'), ('510500', '中证500ETF'),
                     ('159915', '创业板ETF'), ('588000', '科创50ETF')):
        try:
            df = pd.read_sql('select date, close, adj_factor from etf_daily where code=? order by date',
                             con, params=(code,), parse_dates=['date'])
        except Exception as e:
            print('  %s 读取失败 %s' % (code, e))
            continue
        if not len(df):
            print('  %s 无数据' % code)
            continue
        df['p'] = df['close'] * df['adj_factor'].fillna(1)
        px = df.set_index('date')['p']
        r = px.pct_change()
        vol = r.rolling(20, min_periods=15).std() * np.sqrt(242)
        mom60 = (1 + r).rolling(60, min_periods=40).apply(np.prod, raw=True) - 1
        w = (0.15 / vol).clip(upper=1.0).fillna(0)
        w = w.where(mom60 >= 0, w * 0.5).fillna(0)
        idx = r.index.intersection(S.index)          # 与状态面板对齐，省得各算各的
        rr, ww = r.reindex(idx), w.reindex(idx)
        y = len(rr) / 242
        d1 = stats(rr.fillna(0), ww, y)
        d0 = stats(rr.fillna(0), pd.Series(1.0, index=idx), y)
        print('%-14s %8.1f %8.1f %8.2f %8.1f %8.2f   (持有: 夏普 %.2f)'
              % (nm, d1['年化'], d1['波动'], d1['夏普'], d1['回撤'], d1['换手'], d0['夏普']))
    con.close()


if __name__ == '__main__':
    main()
