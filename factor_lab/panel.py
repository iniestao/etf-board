"""
数据面板
========
从 etf.db 读出宽表（index=交易日, columns=ETF 代码），全部价格做后复权。

为什么只取 2019 年起
--------------------
ETF 池的横截面在 2018 年前不足 150 只，rank 出来的分位数没有意义；
2019 年才有 200 只以上，2022 年 700 只，2024 年破千。
样本从 2019-01 开始，横截面的统计性质才站得住。

复权口径
--------
adj_factor 是后复权乘子，close*adj 才是可比价格序列。
volume 和 amount 不复权（成交额本身不含价格调整）。
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

import numpy as np
import pandas as pd

DB = '/workspace/etf_board/data/etf.db'
START = '2018-06-01'   # 留 6 个月给 250 日窗口预热，实际检验从 2019-01 开始


@dataclass
class Panel:
    open: pd.DataFrame
    high: pd.DataFrame
    low: pd.DataFrame
    close: pd.DataFrame
    volume: pd.DataFrame
    amount: pd.DataFrame
    meta: pd.DataFrame
    group: pd.Series          # code -> 资产类别
    idx_map: pd.Series        # code -> 跟踪指数名（用于同类比较）
    tradable: pd.DataFrame = None   # 当日是否达到流动性门槛

    @property
    def date(self) -> pd.DatetimeIndex:
        return self.close.index

    @property
    def code(self) -> pd.Index:
        return self.close.columns

    def ret(self, n: int = 1) -> pd.DataFrame:
        return self.close.pct_change(n, fill_method=None)


def _classify(name: str) -> str:
    """按名称给 ETF 粗分类。ETF 没有行业分类标准，名称关键词是最稳的口径。"""
    n = str(name)
    if any(k in n for k in ('货币', '现金', '理财', '保证金')):
        return 'money'
    if any(k in n for k in ('债', '国债', '政金', '金融债', '信用债', '城投')):
        return 'bond'
    if any(k in n for k in ('黄金', '白银', '豆粕', '有色', '原油', '能源化工', '商品')):
        return 'commodity'
    if any(k in n for k in ('恒生', '港股', '纳斯达克', '标普', '道琼斯', '德国', '法国',
                            '日经', '东京', '东南亚', '沙特', '越南', '亚太', '中概',
                            '海外', '全球', '美国', '日本')):
        return 'cross_border'
    broad = ('沪深300', '中证500', '中证1000', '中证2000', '上证50', '创业板', '科创50',
             '科创板50', '中证A500', '中证A50', '中证100', '深证100', '上证180',
             '中证800', 'MSCI', '全指', '综指', '大盘', '中小盘', '红利', '价值', '成长',
             '等权', '基本面')
    if any(k in n for k in broad):
        return 'broad'
    return 'sector'


def load_panel(start: str = START, min_amount: float = 5e6) -> Panel:
    """读库 → 宽表。

    min_amount：20 日均成交额下限（元）。低于它的标的当天不参与横截面，
    否则冷门 ETF 的一笔申赎就能把因子打成极端值。
    """
    con = sqlite3.connect(DB)
    meta = pd.read_sql(
        'SELECT code, name, exchange, first_date, last_date, bars FROM etf_meta', con)
    df = pd.read_sql(
        f"SELECT code, date, open, high, low, close, volume, amount, adj_factor "
        f"FROM etf_daily WHERE date >= '{start}' ORDER BY date", con)
    con.close()

    df['date'] = pd.to_datetime(df['date'])
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c] * df['adj_factor']

    def wide(col: str) -> pd.DataFrame:
        w = df.pivot(index='date', columns='code', values=col)
        return w.sort_index()

    P = Panel(
        open=wide('open'), high=wide('high'), low=wide('low'), close=wide('close'),
        volume=wide('volume'), amount=wide('amount'),
        meta=meta.set_index('code'),
        group=meta.set_index('code')['name'].map(_classify),
        idx_map=pd.Series(dtype=object),
    )

    # 成交额过滤：只标记，不动价格本身。
    # 价格一旦被抹成 NaN，pct_change 会在低成交日断裂，回测收益被系统性低估。
    amt_ma = P.amount.rolling(20, min_periods=5).mean()
    P.tradable = amt_ma >= min_amount

    return P


def load_index_map() -> pd.Series:
    """ETF 代码 → 跟踪指数名称。用于指数级去重与同类比较。"""
    import json
    from pathlib import Path
    p = Path('/workspace/etf_board/pipeline/index_map.json')
    if not p.exists():
        return pd.Series(dtype=object)
    j = json.loads(p.read_text())
    rows = j.get('map') or {}
    return pd.Series({k: v['idx'] for k, v in rows.items() if isinstance(v, dict)},
                     dtype=object)


# ====================================================================== 分类修正
# 跟踪指数名里出现这些词，说明标的真的持有商品（期货/现货），而不是矿业股票
_COMM_IDX = ('期货', '上海金', '黄金9999', '商品', '豆粕', '原油',
             '上期', '郑商所', '大商所', '能源化工')
_COMM_NAME = ('黄金ETF', '黄金9999', '金ETF', '上海金', '豆粕',
              '能源化工', '大宗商品', '白银', '原油')


def refine_group(P: 'Panel', idx: pd.Series) -> pd.Series:
    """用跟踪指数名修正资产类别。

    `_classify` 只看 ETF 名称，会把「黄金股ETF」「有色金属ETF」「有色矿业ETF」
    判成商品。但这些持有的是矿业上市公司股票，和黄金期货的收益结构完全不同
    （前者跟股票 beta 走，后者跟金价走）。原口径下「商品」组有 43 只，
    真正持有商品的只有 16 只，其余 27 只都是股票——它们混在商品组里，
    既污染了商品组，又被股票组漏掉。
    """
    g = P.group.copy()
    for code in P.code:
        cur = g.get(code)
        x = idx.get(code)
        if isinstance(x, str):
            if any(k in x for k in _COMM_IDX):
                g[code] = 'commodity'
            elif cur == 'commodity':
                # 指数名不像商品 → 是黄金股/有色股这类股票指数
                g[code] = 'cross_border' if any(
                    k in x for k in ('港股', '沪深港', '恒生')) else 'sector'
        elif cur == 'commodity':
            n = str(P.meta.loc[code, 'name'])
            if not any(k in n for k in _COMM_NAME):
                g[code] = 'sector'
    return g


def stock_commodity_mask(P: 'Panel', idx: pd.Series) -> pd.Series:
    """股票型 + 商品型 的标的口径。

    剔除债券、货币。理由不是「不重要」，而是这两类的日收益由计息规则和
    资金面决定，量价因子在它们身上没有经济含义——债券 ETF 的「放量突破」
    是资金申购，不是价格发现。
    """
    g = refine_group(P, idx)
    return g.isin(['broad', 'sector', 'cross_border', 'commodity'])


# ====================================================================== 指数级面板
def to_index_panel(P: 'Panel', idx: pd.Series, keep: pd.Series,
                   amt_win: int = 20, sticky: float = 0.9) -> 'Panel':
    """把「ETF 面板」压成「指数面板」：一个指数只留一只，日频动态选流动性最好的。

    为什么必须做这一步
    ------------------
    1700 只 ETF 只对应 476 个指数，平均一个指数 3.5 只。同一指数的 ETF 日收益
    相关系数 0.99 以上，横截面 rank 时它们会互相占位——40 只中证A500 ETF 等于
    给 A500 这个观点投了 40 票，其他指数被稀释。IC 被同质化样本抬高，
    分层回测的分组边界也会被同一指数的多只标的挤在一个桶里。

    做法
    ----
    每个交易日，在每个指数内部选「20 日均成交额最大且达到流动性门槛」的那只。
    合成序列用**收益率累乘拼接**，不是直接取价格——不同 ETF 的单位净值基准
    不同（1.0 vs 3.5），直接拼会在切换日冒出一个假跳空。

    sticky：原持仓若成交额仍在新晋标的的 sticky 倍以上，就不换。同指数 ETF 的
    收益差不到 1bp，为了 1bp 每天换仓纯亏手续费。
    """
    codes = [c for c in P.code if bool(keep.get(c, False))]

    def arr(df: pd.DataFrame) -> np.ndarray:
        return df[codes].to_numpy(dtype=np.float64)

    C, O = arr(P.close), arr(P.open)
    H, L = arr(P.high), arr(P.low)
    V, A = arr(P.volume), arr(P.amount)
    T, N = C.shape

    amt_ma = P.amount[codes].rolling(amt_win, min_periods=5).mean().to_numpy()
    trad = (P.tradable[codes].to_numpy() if P.tradable is not None
            else np.ones((T, N), dtype=bool))

    # 指数标签：有映射用指数名，没有的自己独立成一组
    tag = idx.reindex(codes).astype(object)
    tag = tag.where(tag.notna(), pd.Series(codes, index=codes)).astype(str).to_numpy()

    pos_of: dict[str, list[int]] = {}
    for i, g in enumerate(tag):
        pos_of.setdefault(g, []).append(i)
    gnames = list(pos_of)

    # 日收益（按各 ETF 自身昨收算），切换日取新标的的当日收益，天然无跳空
    R = np.full((T, N), np.nan)
    R[1:] = C[1:] / C[:-1] - 1.0

    A_eff = np.where(trad & np.isfinite(amt_ma), amt_ma, -np.inf)
    ar = np.arange(T)
    G = len(gnames)
    out = {k: np.full((T, G), np.nan) for k in ('c', 'o', 'h', 'l', 'v', 'a')}
    trd = np.zeros((T, G), dtype=bool)
    hold = np.full(G, -1, dtype=int)          # 各组当前持有的列下标

    for j, g in enumerate(gnames):
        pos = np.array(pos_of[g])
        a = A_eff[:, pos]
        bad = np.all(np.isneginf(a), axis=1)
        pick = np.where(bad, -1, a.argmax(axis=1))

        # 粘性：原标的成交额仍有新标的的 sticky 倍，就不动
        if sticky < 1.0 and len(pos) > 1:
            for t in range(T):
                if bad[t]:
                    continue
                cur = hold[j]
                if cur >= 0 and np.isfinite(a[t, cur]) and a[t, cur] >= sticky * a[t, pick[t]]:
                    pick[t] = cur
                hold[j] = pick[t]
        else:
            for t in range(T):
                if not bad[t]:
                    hold[j] = pick[t]

        ok = ~bad
        if not ok.any():
            continue
        sel = pos[np.where(ok, pick, 0)]
        r = np.where(ok, R[ar, sel], np.nan)

        # 净值：停牌日跳过（1+r 用 1.0 顶替），首日前全 NaN
        nav = np.cumprod(np.where(np.isnan(r), 1.0, 1.0 + r))
        first = int(np.argmax(ok))
        nav[:first] = np.nan
        nav[~ok] = np.nan

        with np.errstate(invalid='ignore', divide='ignore'):
            ratio_o = np.where(ok, O[ar, sel] / C[ar, sel], np.nan)
            ratio_h = np.where(ok, H[ar, sel] / C[ar, sel], np.nan)
            ratio_l = np.where(ok, L[ar, sel] / C[ar, sel], np.nan)

        out['c'][:, j] = nav
        out['o'][:, j] = nav * ratio_o
        out['h'][:, j] = nav * ratio_h
        out['l'][:, j] = nav * ratio_l
        out['v'][:, j] = np.where(ok, V[ar, sel], np.nan)
        out['a'][:, j] = np.where(ok, A[ar, sel], np.nan)
        trd[:, j] = ok

    def mk(key: str) -> pd.DataFrame:
        return pd.DataFrame(out[key], index=P.date, columns=gnames).astype(np.float32)

    # 指数级元数据：分类取组内众数，名称取末段成交额最大的那只
    gmap = refine_group(P, idx)
    meta_rows = []
    last = P.date[-1]
    for g in gnames:
        pos = pos_of[g]
        cs = [codes[i] for i in pos]
        gg = gmap.reindex(cs).mode()
        amt_last = P.amount[cs].loc[:last].tail(20).mean()
        top = amt_last.idxmax() if amt_last.notna().any() else cs[0]
        meta_rows.append(dict(code=g, name=str(P.meta.loc[top, 'name']),
                              group=(gg.iloc[0] if len(gg) else 'sector'),
                              n_etf=len(cs), probe=top))
    mdf = pd.DataFrame(meta_rows).set_index('code')

    IP = Panel(open=mk('o'), high=mk('h'), low=mk('l'), close=mk('c'),
               volume=mk('v'), amount=mk('a'), meta=mdf,
               group=mdf['group'], idx_map=pd.Series(gnames, index=gnames))
    IP.tradable = pd.DataFrame(trd, index=P.date, columns=gnames)
    return IP


def load_universe(start: str = START, min_amount: float = 5e6) -> 'Panel':
    """研究口径的最终标的池：股票型 + 商品型，按跟踪指数去重。

    这是所有因子研究和回测的唯一入口。三个过滤一层套一层：
    1. 剔除债券、货币 —— 收益由计息规则决定，量价因子没有经济含义
    2. 一个指数只留一只 —— 同一指数 3.5 只 ETF 日收益相关 0.99，
       不去重等于给同一个观点重复投票
    3. 流动性门槛 —— 20 日均成交额下限，避免一笔申赎打出极端因子值
    """
    P = load_panel(start=start, min_amount=min_amount)
    idx = load_index_map()
    return to_index_panel(P, idx, stock_commodity_mask(P, idx))


if __name__ == '__main__':
    P = load_universe()
    print('指数面板', P.close.shape, P.date.min().date(), '→', P.date.max().date())
    print('分类', P.group.value_counts().to_dict())
    v = P.close.notna().sum(axis=1)
    print(v.resample('YE').mean().round(0).to_string())
    print(P.meta.head(8)[['name', 'group', 'n_etf', 'probe']].to_string())