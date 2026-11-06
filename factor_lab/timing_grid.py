"""
趋势择时的参数稳健性
====================
分解结果是：波动目标单独用等于白做（夏普 0.27 vs 持有 0.31），贡献全部来自
「mom60 < 0 时砍半仓」。那就把这一条单独拎出来，换窗口、换档位、换标的反复试，
看它是真规律还是恰好拟合了 2018 和 2022 两个大熊市。

如果换哪个窗口都有效，说明是趋势本身的效应；如果只有 60 日行、50 日就不行，
那就是过拟合。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent


def stats(r: pd.Series, w: pd.Series, cost: float = 0.0005) -> dict:
    # 仓位必须滞后一期：t 日收盘算出的信号，只能吃到 t+1 的收益。
    # 写成 w * r 就是用当日涨跌决定当日是否持仓，短窗口动量能把夏普做到 2 以上，
    # 那不是策略，那是预知。
    w_eff = w.shift(1).fillna(0.0)
    turn = (w - w_eff).abs()
    rs = w_eff * r - turn * cost
    nav = (1 + rs).cumprod()
    yrs = len(rs) / 242
    ann = nav.iloc[-1] ** (1 / yrs) - 1
    vol = rs.std() * np.sqrt(242)
    dd = float((nav / nav.cummax() - 1).min())
    return {'年化': ann * 100, '波动': vol * 100, '夏普': ann / vol if vol > 0 else np.nan,
            '回撤': dd * 100, '换手': turn.sum() / yrs}


def load_px(con, code):
    df = pd.read_sql('select date, close, adj_factor from etf_daily where code=? order by date',
                     con, params=(code,), parse_dates=['date'])
    df['p'] = df['close'] * df['adj_factor'].fillna(1)
    return df.set_index('date')['p']


def main() -> None:
    db = '/workspace/etf_board/data/etf.db'
    con = sqlite3.connect(db)
    px = load_px(con, '510300')
    r = px.pct_change()
    con.close()

    print('标的 510300，%s ~ %s，%d 个交易日' % (r.index.min().date(), r.index.max().date(), len(r)))
    print()
    print('=== 1) 动量窗口 × 弱势仓位（夏普） ===')
    print('仓位档位：动量<0 时持有多少（1.0 = 不做择时）')
    print('%-10s %8s %8s %8s %8s %8s' % ('窗口', 'w=1.0', 'w=0.7', 'w=0.5', 'w=0.3', 'w=0.0'))
    best = None
    for win in (20, 40, 60, 90, 120, 150, 200):
        mom = (1 + r).rolling(win, min_periods=int(win * 0.7)).apply(np.prod, raw=True) - 1
        vals = []
        for wk in (1.0, 0.7, 0.5, 0.3, 0.0):
            w = pd.Series(1.0, index=r.index).where(mom >= 0, wk).fillna(1.0)
            vals.append(stats(r.fillna(0), w)['夏普'])
        print('%-10s %8.2f %8.2f %8.2f %8.2f %8.2f'
              % ('%d日' % win, *vals))
        if win == 60:
            best = vals

    print()
    print('=== 2) 分年度：60 日动量 / 弱势半仓 vs 买入持有（%） ===')
    mom = (1 + r).rolling(60, min_periods=40).apply(np.prod, raw=True) - 1
    w = pd.Series(1.0, index=r.index).where(mom >= 0, 0.5).fillna(1.0)
    w_eff = w.shift(1).fillna(0.0)
    print('%-6s %10s %10s %10s %10s' % ('年份', '买入持有', '择时', '差', '择时仓位均值'))
    for y in sorted(r.index.year.unique()):
        m = r.index.year == y
        if m.sum() < 100:
            continue
        a = (1 + r[m].fillna(0)).prod() - 1
        rr = (w_eff * r.fillna(0) - (w - w_eff).abs() * 0.0005)[m]
        b = (1 + rr).prod() - 1
        print('%d %+9.1f%% %+9.1f%% %+9.1f%% %9.2f' % (y, a * 100, b * 100, (b - a) * 100, w[m].mean()))

    print()
    print('=== 3) 多标的稳健性：60 日动量 / 半仓 ===')
    con = sqlite3.connect(db)
    print('%-16s %8s %8s %8s %8s' % ('标的', '择时夏普', '持有夏普', '择时回撤', '持有回撤'))
    rows = []
    for code, nm in (('510300', '沪深300'), ('510500', '中证500'), ('510050', '上证50'),
                     ('159915', '创业板'), ('588000', '科创50'), ('512880', '证券'),
                     ('512480', '半导体'), ('515030', '新能车'), ('159928', '消费'),
                     ('513100', '纳指100')):
        try:
            p = load_px(con, code)
        except Exception:
            continue
        if len(p) < 500:
            continue
        rr = p.pct_change()
        mm = (1 + rr).rolling(60, min_periods=40).apply(np.prod, raw=True) - 1
        ww = pd.Series(1.0, index=rr.index).where(mm >= 0, 0.5).fillna(1.0)
        d1 = stats(rr.fillna(0), ww)
        d0 = stats(rr.fillna(0), pd.Series(1.0, index=rr.index))
        rows.append((nm, d1['夏普'], d0['夏普']))
        print('%-16s %8.2f %8.2f %7.1f%% %7.1f%%'
              % (nm, d1['夏普'], d0['夏普'], d1['回撤'], d0['回撤']))
    con.close()
    if rows:
        arr = np.array([(a, b) for _, a, b in rows])
        print()
        print('  择时胜出: %d/%d 只  |  平均夏普 %.2f → %.2f'
              % (int((arr[:, 0] > arr[:, 1]).sum()), len(arr), arr[:, 1].mean(), arr[:, 0].mean()))


if __name__ == '__main__':
    main()
