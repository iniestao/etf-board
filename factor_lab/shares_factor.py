"""
份额申赎因子
============
这是唯一一个不来自价格的信息维度。

为什么 ETF 的成交量不能替代份额
------------------------------
ETF 可以随时申赎，成交量主要来自做市商对冲和套利盘。一只 ETF 今天成交 10 亿，
可能只是套利者在分批建仓又平掉，投资者的净配置是 0。份额变动才是净额：
份额从 100 亿涨到 130 亿，说明真有人拿着钱进来买了 30 亿，且没有卖出。

已有 257 个因子里约 60 个依赖 volume，README 已经记录「经济含义弱于股票」。
份额是给这一类因子换一个干净的分母。

数据说明
--------
shares.db 是天天基金 F10「份额变动」，但披露频率不统一：
老基金按季度，新基金/上市初期按日。所以先归一到季度：
每个 (code, 季度) 取该季度最后一条记录。

前视控制
--------
季报不是季末当天公布的，法定披露期限是季度结束后 15 个工作日内。
这里统一按「季末 + 45 自然日」才视为可用，宁可晚用，不能早用。
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from panel import load_universe  # noqa: E402

OUT = Path(__file__).parent
LAG_DAYS = 45
FWD_DAYS = 60          # 约一个季度交易日
MIN_N = 30


def load_quarterly() -> pd.DataFrame:
    con = sqlite3.connect(OUT / 'shares.db')
    d = pd.read_sql('SELECT idx, code, date, sub, red, total_share, net_asset FROM shares', con)
    con.close()
    d['date'] = pd.to_datetime(d['date'])
    d['q'] = d['date'].dt.to_period('Q')
    d['qend'] = d['q'].dt.end_time.dt.normalize()

    # 每 (code, 季度) 取最后一条
    d = d.sort_values('date').groupby(['code', 'q'], as_index=False).last()
    d['avail'] = d['qend'] + pd.Timedelta(days=LAG_DAYS)

    # 份额优先用 total_share；缺了用 net_asset/净值 估不出来，直接丢
    piv = d.pivot_table(index='qend', columns='idx', values='total_share', aggfunc='last')
    nets = d.pivot_table(index='qend', columns='idx', values='net_asset', aggfunc='last')
    avail = d.pivot_table(index='qend', columns='idx', values='avail', aggfunc='last')
    return piv.sort_index(), nets.sort_index(), avail.sort_index()


def zrank(df: pd.DataFrame) -> pd.DataFrame:
    return df.rank(axis=1, pct=True)


def ic_series(sig: pd.DataFrame, fwd: pd.DataFrame, min_n: int = MIN_N) -> pd.Series:
    a = zrank(sig).where(fwd.notna())
    b = zrank(fwd).where(fwd.notna())
    a = a.sub(a.mean(axis=1), axis=0)
    b = b.sub(b.mean(axis=1), axis=0)
    num = (a * b).sum(axis=1, min_count=1)
    den = np.sqrt((a ** 2).sum(axis=1, min_count=1) * (b ** 2).sum(axis=1, min_count=1))
    return (num / den.replace(0, np.nan)).where(fwd.notna().sum(axis=1) >= min_n)


def main():
    P = load_universe()
    sh, nets, avail = load_quarterly()
    print(f'季度份额面板 {sh.shape}  {sh.index.min().date()} → {sh.index.max().date()}')

    # 只保留池内指数
    common = [c for c in sh.columns if c in P.close.columns]
    print(f'与指数池交集 {len(common)} 个')
    sh, nets, avail = sh[common], nets[common], avail[common]

    # ---------------------------------------------------------------- 因子构造
    chg = sh.pct_change(fill_method=None)                 # 季度份额变动率
    chg2 = sh.pct_change(2, fill_method=None)             # 两季累计
    chg4 = sh.pct_change(4, fill_method=None)             # 同比
    sub_rate = (sh.pct_change(fill_method=None))          # 同 chg，保留占位

    # 从净资产的变动里剥离价格效应：净资产变动 ≈ 份额变动 × 净值变动
    net_chg = nets.pct_change(fill_method=None)

    # 上一季度价格收益（对齐到季末）
    px_q = P.close.resample('QE').last()
    px_q.index = px_q.index.to_period('Q').to_timestamp('Q').normalize() + pd.Timedelta(days=0)
    # 用真实季末日期对齐
    px_q = P.close.groupby(P.close.index.to_period('Q')).last()
    px_q.index = px_q.index.to_timestamp('Q').normalize()

    ret_q = px_q.pct_change(fill_method=None).reindex(chg.index)

    # 背离：份额增而价格没涨（越跌越买），或份额减而价格在涨（撤退）
    diverg = zrank(chg) - zrank(ret_q)

    factors = {
        'SH_CHG': chg,
        'SH_CHG2': chg2,
        'SH_CHG_YOY': chg4,
        'SH_CHG_NET': net_chg,       # 净资产变动，含价格效应，作为对照
        'SH_DIVERG': diverg,         # 份额 vs 价格背离
    }

    # ---------------------------------------------------------------- 前瞻收益
    # 在 avail 日之后 FWD_DAYS 个交易日的收益
    close = P.close
    dates = close.index
    fwd = pd.DataFrame(index=chg.index, columns=common, dtype=float)
    valid_rows = []
    for qe in chg.index:
        # 可用日：所有标的中最晚的那个（保守）
        av = avail.loc[qe].max()
        if pd.isna(av):
            continue
        pos = dates.searchsorted(av)
        if pos >= len(dates) - FWD_DAYS - 1:
            continue
        t0, t1 = dates[pos], dates[pos + FWD_DAYS]
        fwd.loc[qe] = (close.loc[t1] / close.loc[t0] - 1).reindex(common)
        valid_rows.append((qe, t0, t1))

    print(f'可用截面 {len(valid_rows)} 个：{valid_rows[0][1].date()} → {valid_rows[-1][2].date()}')

    # ---------------------------------------------------------------- IC
    rows = []
    for name, f in factors.items():
        f = f.reindex(chg.index)
        ic = ic_series(f, fwd).dropna()
        if len(ic) < 8:
            print(f'{name}: 截面太少（{len(ic)}），跳过')
            continue
        mu, sd = ic.mean(), ic.std()
        rows.append(dict(factor=name, n_periods=len(ic), ic=mu,
                         ir=mu / sd if sd else np.nan,
                         t=mu / sd * np.sqrt(len(ic)) if sd else np.nan,
                         win=(ic > 0).mean()))
        print(f'{name}: IC {mu:+.4f}  t {rows[-1]["t"]:+.2f}  期数 {len(ic)}')

    T = pd.DataFrame(rows)
    T.to_csv(OUT / 'out_share_ic.csv', index=False)
    if len(T):
        print('\n===== 汇总 =====')
        print(T.to_string(index=False, float_format=lambda v: f'{v:+.4f}'))

    # ---------------------------------------------------------------- 分组
    print('\n===== 分组（每期按因子值分 5 组，下一季度平均收益）=====')
    for name in ['SH_CHG', 'SH_DIVERG']:
        f = factors[name].reindex(chg.index)
        out = []
        for qe in chg.index:
            r = f.loc[qe].dropna()
            y = fwd.loc[qe].dropna()
            both = r.index.intersection(y.index)
            if len(both) < MIN_N:
                continue
            q = pd.qcut(r[both].rank(method='first'), 5, labels=False)
            out.append(y[both].groupby(q).mean())
        if not out:
            continue
        G = pd.DataFrame(out)
        print(f'\n{name}（{len(G)} 期）')
        print((G.mean() * 100).round(2).to_string())
        print(f'  多空（Q4−Q0）年化 {(G[4].mean() - G[0].mean()) * 4 * 100:+.2f}%  '
              f'胜率 {((G[4] - G[0]) > 0).mean():.0%}')

    # ---------------------------------------------------------------- 与量价因子的相关性
    print('\n===== 份额因子与已有因子的截面相关（验证是否正交）=====')
    try:
        WF = pd.read_parquet(OUT / 'wf_ic.parquet')
        # 用时间序列相关：份额 IC 与量价因子 IC 的相关性
        for name in ['SH_CHG', 'SH_DIVERG']:
            if name not in factors:
                continue
            ic = ic_series(factors[name].reindex(chg.index), fwd)
            # 把季度 IC 摊到日频再比
            daily = ic.reindex(WF.index, method='ffill')
            c = WF.corrwith(daily, axis=0).abs().sort_values(ascending=False)
            print(f'\n{name} 与量价因子 IC 相关性 top5：')
            print(c.head(5).to_string(float_format=lambda v: f'{v:.3f}'))
            print(f'  中位 {c.median():.3f}')
    except Exception as e:
        print('  跳过：', e)


if __name__ == '__main__':
    main()
