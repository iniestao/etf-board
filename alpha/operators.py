"""
Alpha101 算子库
===============
WorldQuant《101 Formulaic Alphas》(Kakushadze, 2015) 中出现的全部算子。

约定
----
所有函数接收并返回「宽表」DataFrame：index = 交易日（升序），columns = 标的代码。
这个形状是刻意的——101 个因子里有大量横截面运算（rank / scale），
宽表下 `axis=1` 一行代码就能表达；时序运算则在 `axis=0` 上滚动。

NaN 策略
--------
WorldQuant 原论文没有规定 min_periods。这里统一取 `min_periods = d`（完整窗口），
理由是不完整窗口算出的 ts_rank / ts_argmax 没有可比性，会把上市初期的噪声
当成信号。代价是每只 ETF 前 d-1 天为空，这是正确行为而非缺陷。

性能说明
--------
rolling().apply() 是 O(n·d) 的 Python 循环，在 2900×1717 的宽表上要跑几分钟。
因此 ts_rank / ts_argmax / ts_argmin / decay_linear 改用 numpy 的
sliding_window_view 实现，逐列走 C 层，整体快 50~100 倍。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view


# --------------------------------------------------------------------------
# 横截面算子（沿 axis=1，即同一天对所有标的运算）
# --------------------------------------------------------------------------
def rank(df: pd.DataFrame) -> pd.DataFrame:
    """横截面百分位排名，返回 (0, 1]。

    论文里的 rank() 就是这个含义。它把量纲完全抹掉，
    所以 101 个因子里凡带 rank 的输出都是无量纲的排序值。
    """
    return df.rank(axis=1, pct=True)


def scale(df: pd.DataFrame, a: float = 1.0) -> pd.DataFrame:
    """横截面缩放：使 sum(|x|) = a。

    注意分母是绝对值之和，不是平方和。分母为 0 时返回 NaN（避免除零）。
    """
    s = df.abs().sum(axis=1)
    return df.div(s.replace(0, np.nan), axis=0) * a


def indneutralize(df: pd.DataFrame, groups: pd.Series) -> pd.DataFrame:
    """行业中性化：减去同组均值。

    ETF 没有申万行业分类，这里用「资产类别」代理：
    宽基 / 行业主题 / 跨境 / 债券 / 货币 / 商品。
    这是对论文的合理降级——分组的粒度变粗了，但消除了
    「整类资产同涨同跌」带来的伪信号。
    """
    # groups: index=code, value=group
    g = groups.reindex(df.columns)
    return df.sub(df.T.groupby(g).transform('mean').T)


# --------------------------------------------------------------------------
# 时序算子（沿 axis=0 滚动）
# --------------------------------------------------------------------------
def delay(df: pd.DataFrame, d: int) -> pd.DataFrame:
    """d 个交易日前的值。"""
    return df.shift(d)


def delta(df: pd.DataFrame, d: int) -> pd.DataFrame:
    """当期 − d 日前。"""
    return df.diff(d)


def ts_sum(df: pd.DataFrame, d: int) -> pd.DataFrame:
    return df.rolling(d, min_periods=d).sum()


def ts_mean(df: pd.DataFrame, d: int) -> pd.DataFrame:
    return df.rolling(d, min_periods=d).mean()


def ts_min(df: pd.DataFrame, d: int) -> pd.DataFrame:
    return df.rolling(d, min_periods=d).min()


def ts_max(df: pd.DataFrame, d: int) -> pd.DataFrame:
    return df.rolling(d, min_periods=d).max()


def ts_stddev(df: pd.DataFrame, d: int) -> pd.DataFrame:
    return df.rolling(d, min_periods=d).std()


def ts_product(df: pd.DataFrame, d: int) -> pd.DataFrame:
    # 连乘极易溢出（价格 4 的 20 次方 = 1e12，还行；但收益率连乘必须用 log）
    return df.rolling(d, min_periods=d).apply(np.prod, raw=True)


def _block_apply(df: pd.DataFrame, d: int, fn, block: int = 192) -> pd.DataFrame:
    """按列分块执行滑动窗口函数，控制内存峰值。

    直接对 (T, N, d) 做一次运算，d=250 且 N=1717 时布尔临时数组要 2GB，
    多个因子叠加会撑爆内存。分块后峰值降到 1/9，代价只是多几次循环。
    """
    arr = df.to_numpy(dtype=np.float32)
    T, N = arr.shape
    out = np.full((T, N), np.nan, dtype=np.float32)
    if T < d:
        return pd.DataFrame(out, index=df.index, columns=df.columns)
    for j0 in range(0, N, block):
        j1 = min(j0 + block, N)
        sub = arr[:, j0:j1]
        sw = sliding_window_view(sub, d, axis=0)       # (T-d+1, n, d) 视图
        with np.errstate(invalid='ignore'):
            # 计算在 float64 上做，落盘降 float32：宽表内存减半
            out[d - 1:, j0:j1] = fn(sw).astype(np.float32)
    return pd.DataFrame(out, index=df.index, columns=df.columns)


def ts_rank(df: pd.DataFrame, d: int) -> pd.DataFrame:
    """当前值在过去 d 天中的百分位排名。

    「今天在这段时间里算高还是低」，与 ts_argmax 是两个不同问题：
    ts_rank 关心数值位置，ts_argmax 关心极值出现的时间位置。
    """
    def f(sw):
        last = sw[:, :, -1:]
        cnt = np.sum(sw < last, axis=2).astype(np.float64)
        cnt[~(~np.isnan(last[:, :, 0]))] = np.nan
        return cnt
    return _block_apply(df, d, f)


def ts_argmax(df: pd.DataFrame, d: int) -> pd.DataFrame:
    """过去 d 天内最大值出现在第几天（1 = 最早，d = 今天）。"""
    def f(sw):
        idx = np.argmax(sw, axis=2).astype(np.float64) + 1
        idx[np.isnan(sw).any(axis=2)] = np.nan
        return idx
    return _block_apply(df, d, f)


def ts_argmin(df: pd.DataFrame, d: int) -> pd.DataFrame:
    """过去 d 天内最小值出现在第几天（1 = 最早，d = 今天）。"""
    def f(sw):
        idx = np.argmin(sw, axis=2).astype(np.float64) + 1
        idx[np.isnan(sw).any(axis=2)] = np.nan
        return idx
    return _block_apply(df, d, f)


def decay_linear(df: pd.DataFrame, d: int) -> pd.DataFrame:
    """线性衰减加权平均，权重 1,2,...,d（最近权重最大）。

    与 ts_mean 的区别：给近期更高权重，对拐点更敏感。
    """
    w = np.arange(1, d + 1, dtype=np.float64)
    w /= w.sum()

    def f(sw):
        val = sw @ w                                   # 矩阵乘，走 C 层
        val[np.isnan(sw).any(axis=2)] = np.nan
        return val
    return _block_apply(df, d, f)


def ts_corr(x: pd.DataFrame, y: pd.DataFrame, d: int) -> pd.DataFrame:
    """滚动 Pearson 相关系数。

    必须清 inf：当某一侧在窗口内恒定（方差 0），分母为 0，pandas 会返回
    inf 而不是 NaN。ETF 里流动性差的标的成交额长期不动，这种情况很常见
    （全库实测 8726 个 inf）。inf 会污染后续 rank / ts_rank 的排序，
    所以统一转成 NaN——「算不出相关性」比「相关性无穷大」更接近事实。
    """
    r = x.rolling(d, min_periods=d).corr(y)
    return r.replace([np.inf, -np.inf], np.nan)


def ts_cov(x: pd.DataFrame, y: pd.DataFrame, d: int) -> pd.DataFrame:
    """滚动协方差。同样清 inf。"""
    r = x.rolling(d, min_periods=d).cov(y)
    return r.replace([np.inf, -np.inf], np.nan)


# --------------------------------------------------------------------------
# 变换算子
# --------------------------------------------------------------------------
def log(df: pd.DataFrame) -> pd.DataFrame:
    """自然对数。论文里的 log 作用在正数上（价格、成交额），负值置 NaN。"""
    return np.log(df.where(df > 0))


def sign(df: pd.DataFrame) -> pd.DataFrame:
    return np.sign(df)


def signedpower(df: pd.DataFrame, a: float) -> pd.DataFrame:
    """保留符号的幂：sign(x) · |x|^a。"""
    return np.sign(df) * df.abs() ** a


def adv(amount: pd.DataFrame, d: int) -> pd.DataFrame:
    """d 日平均成交额（average dollar volume）。"""
    return amount.rolling(d, min_periods=d).mean()


def max_(x, y) -> pd.DataFrame:
    """逐元素取大。论文里 max(x, y) 是这个意思，不是时序 max。

    用 np.fmax 而非 `x.where(x > y, y)`：后者在一侧为 NaN 时会返回 NaN，
    导致 a096 这种「两个不同窗口长度的分量取大」的因子整列为空。
    fmax 会忽略 NaN，返回另一侧的有效值，符合「哪个算得出就用哪个」的意图。

    y 允许是标量（a029 里是 min(..., 5)）。
    """
    ref = x if isinstance(x, pd.DataFrame) else y
    xa = x.to_numpy() if isinstance(x, pd.DataFrame) else x
    ya = y.to_numpy() if isinstance(y, pd.DataFrame) else y
    return pd.DataFrame(np.fmax(xa, ya), index=ref.index, columns=ref.columns)


def min_(x, y) -> pd.DataFrame:
    ref = x if isinstance(x, pd.DataFrame) else y
    xa = x.to_numpy() if isinstance(x, pd.DataFrame) else x
    ya = y.to_numpy() if isinstance(y, pd.DataFrame) else y
    return pd.DataFrame(np.fmin(xa, ya), index=ref.index, columns=ref.columns)


def safe_div(a: pd.DataFrame, b: pd.DataFrame) -> pd.DataFrame:
    """除零保护。论文里大量 x/y，分母为 0 时应当给 NaN 而非 inf。"""
    return a.div(b.replace(0, np.nan))


def returns(close: pd.DataFrame) -> pd.DataFrame:
    """日收益率。首日为 NaN。"""
    return close.pct_change(fill_method=None)


def vwap(amount: pd.DataFrame, volume: pd.DataFrame) -> pd.DataFrame:
    """成交均价 = 成交额 / 成交量。

    A 股 volume 单位是「股」，amount 是「元」，所以 vwap 直接得元/份。
    成交量为 0 的日子（停牌）给 NaN。
    """
    return safe_div(amount, volume)


OPERATORS = {
    'rank': rank, 'scale': scale, 'delay': delay, 'delta': delta,
    'ts_sum': ts_sum, 'ts_mean': ts_mean, 'ts_min': ts_min, 'ts_max': ts_max,
    'ts_stddev': ts_stddev, 'ts_rank': ts_rank, 'ts_argmax': ts_argmax,
    'ts_argmin': ts_argmin, 'decay_linear': decay_linear, 'ts_corr': ts_corr,
    'ts_cov': ts_cov, 'log': log, 'sign': sign, 'signedpower': signedpower,
    'adv': adv, 'max_': max_, 'min_': min_, 'indneutralize': indneutralize,
}
