"""
Alpha101 —— WorldQuant《101 Formulaic Alphas》完整复现
=======================================================
论文：Kakushadze, Z. (2016). 101 Formulaic Alphas. Wilmott, 2016(84), 72-81.
      arXiv:1601.00991

全部 101 个因子按论文原式实现，未做「简化」或「省略常数项」以外的任何改动
（论文中 `-0.5`、`+0` 这类平移量不改变横截面排序，故略去，但保留了注释）。

与论文的四处必要偏离
--------------------
1. **IndNeutralize**：论文用行业/板块分类。ETF 没有申万分类，用「资产类别」
   （宽基/行业主题/跨境/债券/货币/商品）代理。粒度变粗，但消除了整类资产
   同涨同跌的伪信号。相关因子会标注 DEGRADED。
2. **cap（市值）**：ETF 无市值概念，Alpha#56 用成交额 amount 代理，标注 DEGRADED。
3. **小数窗口**：论文里 3.92795、16.2289 这类窗口，统一 round 为整数。
4. **min_periods**：统一取完整窗口 d，避免上市初期噪声。

ETF 特有的失效风险
------------------
`volume` 对 ETF 的含义与个股不同——ETF 份额可以随时申赎，成交量受做市商和
套利盘影响远大于受「投资者看多看空」影响。因此所有依赖 volume 的因子
（约 60 个）在 ETF 上的经济含义弱于在股票上，需用 IC 检验筛选后再用。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from operators import (
    rank, scale, delay, delta, ts_sum, ts_mean, ts_min, ts_max, ts_stddev,
    ts_product, ts_rank, ts_argmax, ts_argmin, decay_linear, ts_corr, ts_cov,
    log, sign, signedpower, adv, max_, min_, safe_div, returns as calc_returns,
    vwap as calc_vwap, indneutralize,
)


def _w(cond, a, b):
    """三元运算 ? : 的 DataFrame 版本。"""
    out = pd.DataFrame(
        np.where(cond, a, b),
        index=cond.index, columns=cond.columns,
    )
    return out


class Alpha101:
    """输入为宽表 dict，输出为 dict[name -> DataFrame]。"""

    def __init__(self, data: dict, groups: pd.Series | None = None):
        self.o = data['open']
        self.h = data['high']
        self.l = data['low']
        self.c = data['close']
        self.v = data['volume']
        self.amt = data['amount']
        self.vw = calc_vwap(self.amt, self.v)
        self.r = calc_returns(self.c)
        self.groups = groups
        self.notes: dict[str, str] = {}

    # ------------------------------------------------------------------
    # 1-10
    # ------------------------------------------------------------------
    def a001(self):
        # rank(Ts_ArgMax(SignedPower(cond(returns<0, stddev(returns,20), close), 2), 5))
        inner = _w(self.r < 0, ts_stddev(self.r, 20), self.c)
        return rank(ts_argmax(signedpower(inner, 2), 5))

    def a002(self):
        return -1 * ts_corr(rank(delta(log(self.v), 2)), rank(safe_div(self.c - self.o, self.o)), 6)

    def a003(self):
        return -1 * ts_corr(rank(self.o), rank(self.v), 10)

    def a004(self):
        return -1 * ts_rank(rank(self.l), 9)

    def a005(self):
        return rank(self.o - ts_sum(self.vw, 10) / 10) * (-1 * rank(self.c - self.vw).abs())

    def a006(self):
        return -1 * ts_corr(self.o, self.v, 10)

    def a007(self):
        adv20 = adv(self.amt, 20)
        d7 = delta(self.c, 7)
        return _w(adv20 < self.v, -1 * ts_rank(d7.abs(), 60) * sign(d7), -1.0)

    def a008(self):
        x = ts_sum(self.o, 5) * ts_sum(self.r, 5)
        return -1 * rank(x - delay(x, 10))

    def a009(self):
        d1 = delta(self.c, 1)
        return _w(ts_min(d1, 5) > 0, d1,
                  _w(ts_max(d1, 5) < 0, d1, -1 * d1))

    def a010(self):
        d1 = delta(self.c, 1)
        return rank(_w(ts_min(d1, 4) > 0, d1,
                       _w(ts_max(d1, 4) < 0, d1, -1 * d1)))

    # ------------------------------------------------------------------
    # 11-20
    # ------------------------------------------------------------------
    def a011(self):
        spread = self.vw - self.c
        return (rank(ts_max(spread, 3)) + rank(ts_min(spread, 3))) * rank(delta(self.v, 3))

    def a012(self):
        return sign(delta(self.v, 1)) * (-1 * delta(self.c, 1))

    def a013(self):
        return -1 * rank(ts_cov(rank(self.c), rank(self.v), 5))

    def a014(self):
        return -1 * rank(delta(self.r, 3)) * ts_corr(self.o, self.v, 10)

    def a015(self):
        return -1 * ts_sum(rank(ts_corr(rank(self.h), rank(self.v), 3)), 3)

    def a016(self):
        return -1 * rank(ts_cov(rank(self.h), rank(self.v), 5))

    def a017(self):
        adv20 = adv(self.amt, 20)
        return (-1 * rank(ts_rank(self.c, 10))
                * rank(delta(delta(self.c, 1), 1))
                * rank(ts_rank(safe_div(self.v, adv20), 5)))

    def a018(self):
        return -1 * rank(ts_stddev((self.c - self.o).abs(), 5) + (self.c - self.o)
                         + ts_corr(self.c, self.o, 10))

    def a019(self):
        return (-1 * sign((self.c - delay(self.c, 7)) + delta(self.c, 7))
                * (1 + rank(1 + ts_sum(self.r, 250))))

    def a020(self):
        return (-1 * rank(self.o - delay(self.h, 1))
                * rank(self.o - delay(self.c, 1))
                * rank(self.o - delay(self.l, 1)))

    # ------------------------------------------------------------------
    # 21-30
    # ------------------------------------------------------------------
    def a021(self):
        adv20 = adv(self.amt, 20)
        vr = safe_div(self.v, adv20)
        cond1 = (ts_sum(self.c, 8) / 8 + ts_stddev(self.c, 8)) < (ts_sum(self.c, 2) / 2)
        cond2 = (ts_sum(self.c, 2) / 2) < (ts_sum(self.c, 8) / 8 - ts_stddev(self.c, 8))
        cond3 = vr >= 1
        return _w(cond1, -1.0, _w(cond2, 1.0, _w(cond3, 1.0, -1.0)))

    def a022(self):
        return -1 * (delta(ts_corr(self.h, self.v, 5), 5) * rank(ts_stddev(self.c, 20)))

    def a023(self):
        return _w((ts_sum(self.h, 20) / 20) < self.h, -1 * delta(self.h, 2), 0.0)

    def a024(self):
        x = delta(ts_sum(self.c, 100) / 100, 100) / delay(self.c, 100)
        return _w(x <= 0.05, -1 * (self.c - ts_min(self.c, 100)), -1 * delta(self.c, 3))

    def a025(self):
        return rank(-1 * self.r * adv(self.amt, 20) * self.vw * (self.h - self.c))

    def a026(self):
        return -1 * ts_max(ts_corr(ts_rank(self.v, 5), ts_rank(self.h, 5), 5), 3)

    def a027(self):
        cond = rank(ts_sum(ts_corr(rank(self.v), rank(self.vw), 6), 2) / 2.0) > 0.5
        return _w(cond, -1.0, 1.0)

    def a028(self):
        return scale(ts_corr(adv(self.amt, 20), self.l, 5) + (self.h + self.l) / 2 - self.c)

    def a029(self):
        # 论文原式嵌套极深；min(..., 5) 与 product(..., 1) 在实现上是恒等变形
        x = rank(rank(-1 * rank(delta(self.c - 1, 5))))
        part = ts_product(rank(rank(scale(log(ts_sum(ts_min(x, 2), 1))))), 1)
        return min_(part, 5) + ts_rank(delay(-1 * self.r, 6), 5)

    def a030(self):
        sgn = (sign(self.c - delay(self.c, 1))
               + sign(delay(self.c, 1) - delay(self.c, 2))
               + sign(delay(self.c, 2) - delay(self.c, 3)))
        return ((1.0 - rank(sgn)) * ts_sum(self.v, 5)) / ts_sum(self.v, 20)

    # ------------------------------------------------------------------
    # 31-40
    # ------------------------------------------------------------------
    def a031(self):
        part1 = rank(rank(rank(decay_linear(-1 * rank(rank(delta(self.c, 10))), 10))))
        part2 = rank(-1 * delta(self.c, 3))
        part3 = sign(scale(ts_corr(adv(self.amt, 20), self.l, 12)))
        return part1 + part2 + part3

    def a032(self):
        return (scale(ts_sum(self.c, 7) / 7 - self.c)
                + 20 * scale(ts_corr(self.vw, delay(self.c, 5), 230)))

    def a033(self):
        return rank(-1 * (1 - safe_div(self.o, self.c)))

    def a034(self):
        return rank((1 - rank(safe_div(ts_stddev(self.r, 2), ts_stddev(self.r, 5))))
                    + (1 - rank(delta(self.c, 1))))

    def a035(self):
        return (ts_rank(self.v, 32)
                * (1 - ts_rank(self.c + self.h - self.l, 16))
                * (1 - ts_rank(self.r, 32)))

    def a036(self):
        adv20 = adv(self.amt, 20)
        return (2.21 * rank(ts_corr(self.c - self.o, delay(self.v, 1), 15))
                + 0.7 * rank(self.o - self.c)
                + 0.73 * rank(ts_rank(delay(-1 * self.r, 6), 5))
                + rank(ts_corr(self.vw, adv20, 6).abs())
                + 0.6 * rank((ts_sum(self.c, 200) / 200 - self.o) * (self.c - self.o)))

    def a037(self):
        return (rank(ts_corr(delay(self.o - self.c, 1), self.c, 200))
                + rank(self.o - self.c))

    def a038(self):
        return -1 * rank(ts_rank(self.c, 10)) * rank(safe_div(self.c, self.o))

    def a039(self):
        adv20 = adv(self.amt, 20)
        return (-1 * rank(delta(self.c, 7) * (1 - rank(decay_linear(safe_div(self.v, adv20), 9))))
                * (1 + rank(ts_sum(self.r, 250))))

    def a040(self):
        return -1 * rank(ts_stddev(self.h, 10)) * ts_corr(self.h, self.v, 10)

    # ------------------------------------------------------------------
    # 41-50
    # ------------------------------------------------------------------
    def a041(self):
        return np.sqrt(self.h * self.l) - self.vw

    def a042(self):
        return rank(self.vw - self.c) / rank(self.vw + self.c)

    def a043(self):
        return ts_rank(safe_div(self.v, adv(self.amt, 20)), 20) * ts_rank(-1 * delta(self.c, 7), 8)

    def a044(self):
        return -1 * ts_corr(self.h, rank(self.v), 5)

    def a045(self):
        return -1 * (rank(ts_sum(delay(self.c, 5), 20) / 20)
                     * ts_corr(self.c, self.v, 2)
                     * rank(ts_corr(ts_sum(self.c, 5), ts_sum(self.c, 20), 2)))

    def a046(self):
        x = (delay(self.c, 20) - delay(self.c, 10)) / 10 - (delay(self.c, 10) - self.c) / 10
        return _w(x > 0.25, -1.0, _w(x < 0, 1.0, -1 * (self.c - delay(self.c, 1))))

    def a047(self):
        adv20 = adv(self.amt, 20)
        inner = safe_div(rank(1 / self.c) * self.v / adv20,
                         ts_sum(self.h, 5) / 5) * (self.h * rank(self.h - self.c))
        return inner - rank(self.vw - delay(self.vw, 5))

    def a048(self):
        if self.groups is None:
            self.notes['a048'] = 'MISSING: 无行业分组'
            return None
        num = ts_corr(delta(self.c, 1), delta(delay(self.c, 1), 1), 250) * delta(self.c, 1)
        num = indneutralize(safe_div(num, self.c), self.groups)
        den = ts_sum((delta(self.c, 1) / delay(self.c, 1)) ** 2, 250)
        self.notes['a048'] = 'DEGRADED: 行业用资产类别代理'
        return safe_div(num, den)

    def a049(self):
        x = (delay(self.c, 20) - delay(self.c, 10)) / 10 - (delay(self.c, 10) - self.c) / 10
        return _w(x < -0.1, 1.0, -1 * (self.c - delay(self.c, 1)))

    def a050(self):
        return -1 * ts_max(rank(ts_corr(rank(self.v), rank(self.vw), 5)), 5)

    # ------------------------------------------------------------------
    # 51-60
    # ------------------------------------------------------------------
    def a051(self):
        x = (delay(self.c, 20) - delay(self.c, 10)) / 10 - (delay(self.c, 10) - self.c) / 10
        return _w(x < -0.05, 1.0, -1 * (self.c - delay(self.c, 1)))

    def a052(self):
        return ((-1 * ts_min(self.l, 5) + delay(ts_min(self.l, 5), 5))
                * rank((ts_sum(self.r, 240) - ts_sum(self.r, 20)) / 220)
                * ts_rank(self.v, 5))

    def a053(self):
        return -1 * delta(safe_div((self.c - self.l) - (self.h - self.c), self.c - self.l), 9)

    def a054(self):
        return safe_div(-1 * (self.l - self.c) * self.o ** 5,
                        (self.l - self.h) * self.c ** 5)

    def a055(self):
        rng = ts_max(self.h, 12) - ts_min(self.l, 12)
        return -1 * ts_corr(rank(safe_div(self.c - ts_min(self.l, 12), rng)), rank(self.v), 6)

    def a056(self):
        # 论文用 cap（市值），ETF 无市值 → 用成交额代理
        self.notes['a056'] = 'DEGRADED: cap 用成交额代理'
        return -1 * (rank(safe_div(ts_sum(self.r, 10), ts_sum(ts_sum(self.r, 2), 3)))
                     * rank(self.r * self.amt))

    def a057(self):
        return -1 * safe_div(self.c - self.vw, decay_linear(rank(ts_argmax(self.c, 30)), 2))

    def a058(self):
        if self.groups is None:
            self.notes['a058'] = 'MISSING: 无行业分组'
            return None
        self.notes['a058'] = 'DEGRADED: 行业用资产类别代理'
        return -1 * ts_rank(decay_linear(
            ts_corr(indneutralize(self.vw, self.groups), self.v, 4), 8), 6)

    def a059(self):
        if self.groups is None:
            self.notes['a059'] = 'MISSING: 无行业分组'
            return None
        self.notes['a059'] = 'DEGRADED: 行业用资产类别代理'
        k = 0.728317
        return -1 * ts_rank(decay_linear(
            ts_corr(indneutralize(self.vw * k + self.vw * (1 - k), self.groups), self.v, 4), 16), 8)

    def a060(self):
        inner = safe_div((self.c - self.l) - (self.h - self.c), self.h - self.l) * self.v
        return -1 * (2 * scale(rank(inner)) - scale(rank(ts_argmax(self.c, 10))))

    # ------------------------------------------------------------------
    # 61-70
    # ------------------------------------------------------------------
    def a061(self):
        return rank(self.vw - ts_min(self.vw, 16)) < rank(ts_corr(self.vw, adv(self.amt, 180), 18))

    def a062(self):
        cond = (rank(ts_corr(self.vw, ts_sum(adv(self.amt, 20), 22), 10))
                < rank((rank(self.o) + rank(self.o))
                       < (rank((self.h + self.l) / 2) + rank(self.h))))
        return -1.0 * cond

    def a063(self):
        if self.groups is None:
            self.notes['a063'] = 'MISSING: 无行业分组'
            return None
        self.notes['a063'] = 'DEGRADED: 行业用资产类别代理'
        k = 0.318108
        p1 = rank(decay_linear(delta(indneutralize(self.c, self.groups), 2), 8))
        p2 = rank(decay_linear(
            ts_corr(self.vw * k + self.o * (1 - k), ts_sum(adv(self.amt, 180), 37), 14), 12))
        return -1 * (p1 - p2)

    def a064(self):
        k = 0.178404
        p1 = rank(ts_corr(ts_sum(self.o * k + self.l * (1 - k), 13),
                          ts_sum(adv(self.amt, 120), 13), 17))
        p2 = rank(delta((self.h + self.l) / 2 * k + self.vw * (1 - k), 4))
        return -1.0 * (p1 < p2)

    def a065(self):
        k = 0.00817205
        p1 = rank(ts_corr(self.o * k + self.vw * (1 - k), ts_sum(adv(self.amt, 60), 9), 6))
        p2 = rank(self.o - ts_min(self.o, 14))
        return -1.0 * (p1 < p2)

    def a066(self):
        p1 = rank(decay_linear(delta(self.vw, 4), 7))
        p2 = ts_rank(decay_linear(
            safe_div(self.l - self.vw, self.o - (self.h + self.l) / 2), 11), 7)
        return -1 * (p1 + p2)

    def a067(self):
        if self.groups is None:
            self.notes['a067'] = 'MISSING: 无行业分组'
            return None
        self.notes['a067'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(self.h - ts_min(self.h, 2))
        p2 = rank(ts_corr(indneutralize(self.vw, self.groups),
                          indneutralize(adv(self.amt, 20), self.groups), 6))
        return -1 * (p1 ** p2)

    def a068(self):
        p1 = ts_rank(ts_corr(rank(self.h), rank(adv(self.amt, 15)), 9), 14)
        p2 = rank(delta(self.c * 0.518371 + self.l * (1 - 0.518371), 1))
        return -1.0 * (p1 < p2)

    def a069(self):
        if self.groups is None:
            self.notes['a069'] = 'MISSING: 无行业分组'
            return None
        self.notes['a069'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(ts_max(delta(indneutralize(self.vw, self.groups), 3), 5))
        p2 = ts_rank(ts_corr(self.c * 0.490655 + self.vw * (1 - 0.490655), adv(self.amt, 20), 5), 9)
        return -1 * (p1 ** p2)

    def a070(self):
        if self.groups is None:
            self.notes['a070'] = 'MISSING: 无行业分组'
            return None
        self.notes['a070'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(delta(self.vw, 1))
        p2 = ts_rank(ts_corr(indneutralize(self.c, self.groups), adv(self.amt, 50), 18), 18)
        return -1 * (p1 ** p2)

    # ------------------------------------------------------------------
    # 71-80
    # ------------------------------------------------------------------
    def a071(self):
        p1 = ts_rank(decay_linear(
            ts_corr(ts_rank(self.c, 3), ts_rank(adv(self.amt, 180), 12), 18), 4), 16)
        p2 = ts_rank(decay_linear(rank(self.l + self.o - 2 * self.vw) ** 2, 16), 4)
        return max_(p1, p2)

    def a072(self):
        p1 = rank(decay_linear(ts_corr((self.h + self.l) / 2, adv(self.amt, 40), 9), 10))
        p2 = rank(decay_linear(
            ts_corr(ts_rank(self.vw, 4), ts_rank(self.v, 19), 7), 3))
        return safe_div(p1, p2)

    def a073(self):
        p1 = rank(decay_linear(delta(self.vw, 5), 3))
        k = 0.147155
        x = self.o * k + self.l * (1 - k)
        p2 = ts_rank(decay_linear(safe_div(delta(x, 2), x) * -1, 3), 17)
        return -1 * max_(p1, p2)

    def a074(self):
        p1 = rank(ts_corr(self.c, ts_sum(adv(self.amt, 30), 37), 15))
        p2 = rank(ts_corr(rank(self.h * 0.0261661 + self.vw * (1 - 0.0261661)),
                          rank(self.v), 11))
        return -1.0 * (p1 < p2)

    def a075(self):
        return (rank(ts_corr(self.vw, self.v, 4))
                < rank(ts_corr(rank(self.l), rank(adv(self.amt, 50)), 12)))

    def a076(self):
        if self.groups is None:
            self.notes['a076'] = 'MISSING: 无行业分组'
            return None
        self.notes['a076'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(decay_linear(delta(self.vw, 1), 12))
        p2 = ts_rank(decay_linear(
            ts_rank(ts_corr(indneutralize(self.l, self.groups), adv(self.amt, 81), 8), 20), 17), 19)
        return -1 * max_(p1, p2)

    def a077(self):
        p1 = rank(decay_linear((self.h + self.l) / 2 + self.h - (self.vw + self.h), 20))
        p2 = rank(decay_linear(ts_corr((self.h + self.l) / 2, adv(self.amt, 40), 3), 6))
        return min_(p1, p2)

    def a078(self):
        k = 0.352233
        p1 = rank(ts_corr(ts_sum(self.l * k + self.vw * (1 - k), 20),
                          ts_sum(adv(self.amt, 40), 20), 7))
        p2 = rank(ts_corr(rank(self.vw), rank(self.v), 6))
        return p1 ** p2

    def a079(self):
        if self.groups is None:
            self.notes['a079'] = 'MISSING: 无行业分组'
            return None
        self.notes['a079'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(delta(indneutralize(self.c * 0.60733 + self.o * (1 - 0.60733), self.groups), 1))
        p2 = rank(ts_corr(ts_rank(self.vw, 4), ts_rank(adv(self.amt, 150), 9), 15))
        return 1.0 * (p1 < p2)

    def a080(self):
        if self.groups is None:
            self.notes['a080'] = 'MISSING: 无行业分组'
            return None
        self.notes['a080'] = 'DEGRADED: 行业用资产类别代理'
        k = 0.868128
        p1 = rank(sign(delta(indneutralize(self.o * k + self.h * (1 - k), self.groups), 4)))
        p2 = ts_rank(ts_corr(self.h, adv(self.amt, 10), 5), 6)
        return -1 * (p1 ** p2)

    # ------------------------------------------------------------------
    # 81-90
    # ------------------------------------------------------------------
    def a081(self):
        p1 = rank(log(ts_product(
            rank(rank(ts_corr(self.vw, ts_sum(adv(self.amt, 10), 50), 8)) ** 4), 15)))
        p2 = rank(ts_corr(rank(self.vw), rank(self.v), 5))
        return -1.0 * (p1 < p2)

    def a082(self):
        if self.groups is None:
            self.notes['a082'] = 'MISSING: 无行业分组'
            return None
        self.notes['a082'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(decay_linear(delta(self.o, 1), 15))
        p2 = ts_rank(decay_linear(
            ts_corr(indneutralize(self.v, self.groups), self.o, 17), 7), 13)
        return -1 * min_(p1, p2)

    def a083(self):
        x = safe_div(self.h - self.l, ts_sum(self.c, 5) / 5)
        return safe_div(rank(delay(x, 2)) * rank(rank(self.v)), safe_div(x, self.vw - self.c))

    def a084(self):
        p1 = signedpower(ts_rank(self.vw - ts_max(self.vw, 15), 21), delta(self.c, 5))
        return p1

    def a085(self):
        p1 = rank(ts_corr(self.h * 0.876703 + self.c * (1 - 0.876703),
                          adv(self.amt, 30), 10))
        p2 = rank(ts_corr(ts_rank((self.h + self.l) / 2, 4), ts_rank(self.v, 10), 7))
        return p1 ** p2

    def a086(self):
        p1 = ts_rank(ts_corr(self.c, ts_sum(adv(self.amt, 20), 15), 6), 20)
        p2 = rank((self.o + self.c) - (self.vw + self.o))
        return -1.0 * (p1 < p2)

    def a087(self):
        if self.groups is None:
            self.notes['a087'] = 'MISSING: 无行业分组'
            return None
        self.notes['a087'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(decay_linear(delta(self.c * 0.369701 + self.vw * (1 - 0.369701), 2), 3))
        p2 = ts_rank(decay_linear(
            ts_corr(indneutralize(adv(self.amt, 81), self.groups), self.c, 13).abs(), 5), 14)
        return -1 * max_(p1, p2)

    def a088(self):
        p1 = rank(decay_linear(rank(self.o) + rank(self.l) - rank(self.h) - rank(self.c), 8))
        p2 = ts_rank(decay_linear(
            ts_corr(ts_rank(self.c, 8), ts_rank(adv(self.amt, 60), 21), 8), 7), 3)
        return min_(p1, p2)

    def a089(self):
        if self.groups is None:
            self.notes['a089'] = 'MISSING: 无行业分组'
            return None
        self.notes['a089'] = 'DEGRADED: 行业用资产类别代理'
        p1 = ts_rank(decay_linear(ts_corr(self.l, adv(self.amt, 10), 7), 6), 4)
        p2 = ts_rank(decay_linear(
            delta(indneutralize(self.vw, self.groups), 3), 10), 15)
        return p1 - p2

    def a090(self):
        if self.groups is None:
            self.notes['a090'] = 'MISSING: 无行业分组'
            return None
        self.notes['a090'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(self.c - ts_max(self.c, 5))
        p2 = ts_rank(ts_corr(indneutralize(adv(self.amt, 40), self.groups), self.l, 5), 3)
        return -1 * (p1 ** p2)

    # ------------------------------------------------------------------
    # 91-101
    # ------------------------------------------------------------------
    def a091(self):
        if self.groups is None:
            self.notes['a091'] = 'MISSING: 无行业分组'
            return None
        self.notes['a091'] = 'DEGRADED: 行业用资产类别代理'
        p1 = ts_rank(decay_linear(decay_linear(
            ts_corr(indneutralize(self.c, self.groups), self.v, 10), 16), 4), 5)
        p2 = rank(decay_linear(ts_corr(self.vw, adv(self.amt, 30), 4), 3))
        return -1 * (p1 - p2)

    def a092(self):
        p1 = ts_rank(decay_linear(((self.h + self.l) / 2 + self.c) < (self.l + self.o), 15), 19)
        p2 = ts_rank(decay_linear(ts_corr(rank(self.l), rank(adv(self.amt, 30)), 8), 7), 7)
        return min_(p1, p2)

    def a093(self):
        if self.groups is None:
            self.notes['a093'] = 'MISSING: 无行业分组'
            return None
        self.notes['a093'] = 'DEGRADED: 行业用资产类别代理'
        p1 = ts_rank(decay_linear(
            ts_corr(indneutralize(self.vw, self.groups), adv(self.amt, 81), 17), 20), 8)
        p2 = rank(decay_linear(delta(self.c * 0.524434 + self.vw * (1 - 0.524434), 3), 16))
        return safe_div(p1, p2)

    def a094(self):
        p1 = rank(self.vw - ts_min(self.vw, 12))
        p2 = ts_rank(ts_corr(ts_rank(self.vw, 20), ts_rank(adv(self.amt, 60), 4), 18), 3)
        return -1 * (p1 ** p2)

    def a095(self):
        p1 = rank(self.o - ts_min(self.o, 12))
        p2 = ts_rank(rank(ts_corr(ts_sum((self.h + self.l) / 2, 19),
                                  ts_sum(adv(self.amt, 40), 19), 13)) ** 5, 12)
        return 1.0 * (p1 < p2)

    def a096(self):
        p1 = ts_rank(decay_linear(ts_corr(rank(self.vw), rank(self.v), 4), 4), 8)
        p2 = ts_rank(decay_linear(
            ts_argmax(ts_corr(ts_rank(self.c, 7), ts_rank(adv(self.amt, 60), 4), 4), 13), 14), 13)
        return -1 * max_(p1, p2)

    def a097(self):
        if self.groups is None:
            self.notes['a097'] = 'MISSING: 无行业分组'
            return None
        self.notes['a097'] = 'DEGRADED: 行业用资产类别代理'
        p1 = rank(decay_linear(
            delta(indneutralize(self.l * 0.721001 + self.vw * (1 - 0.721001), self.groups), 3), 20))
        p2 = ts_rank(decay_linear(
            ts_rank(ts_corr(ts_rank(self.l, 8), ts_rank(adv(self.amt, 60), 17), 5), 19), 16), 7)
        return -1 * (p1 - p2)

    def a098(self):
        p1 = rank(decay_linear(ts_corr(self.vw, ts_sum(adv(self.amt, 5), 26), 5), 7))
        p2 = rank(decay_linear(
            ts_rank(ts_argmin(ts_corr(rank(self.o), rank(adv(self.amt, 15)), 21), 9), 7), 8))
        return p1 - p2

    def a099(self):
        p1 = rank(ts_corr(ts_sum((self.h + self.l) / 2, 20),
                          ts_sum(adv(self.amt, 60), 20), 9))
        p2 = rank(ts_corr(self.l, self.v, 6))
        return -1.0 * (p1 < p2)

    def a100(self):
        if self.groups is None:
            self.notes['a100'] = 'MISSING: 无行业分组'
            return None
        self.notes['a100'] = 'DEGRADED: 行业用资产类别代理'
        inner = safe_div((self.c - self.l) - (self.h - self.c), self.h - self.l) * self.v
        p1 = scale(indneutralize(indneutralize(rank(inner), self.groups), self.groups))
        p2 = scale(indneutralize(
            ts_corr(self.c, rank(adv(self.amt, 20)), 5) - rank(ts_argmin(self.c, 30)), self.groups))
        return -1 * (1.5 * p1 - p2) * safe_div(self.v, adv(self.amt, 20))

    def a101(self):
        return safe_div(self.c - self.o, (self.h - self.l) + 0.001)

    # ------------------------------------------------------------------
    def compute_all(self, only: list[str] | None = None) -> dict[str, pd.DataFrame]:
        """计算全部（或指定）因子。单个失败不影响其余。"""
        out: dict[str, pd.DataFrame] = {}
        names = only if only else [f'a{i:03d}' for i in range(1, 102)]
        for name in names:
            fn = getattr(self, name, None)
            if fn is None:
                continue
            try:
                res = fn()
                if res is not None:
                    # float32：101 个宽表若用 float64 要 7.4GB，超出容器配额。
                    # 最后统一清 inf——除零、相关系数分母为 0 都会产生，
                    # 留给下游会污染排序，必须在落盘前转成 NaN。
                    res = res.astype(np.float32, copy=True)
                    arr = res.to_numpy(copy=False)
                    n_inf = np.isinf(arr).sum()
                    if n_inf:
                        arr[np.isinf(arr)] = np.nan
                        self.notes.setdefault(name, f'INF_CLEANED: {n_inf}')
                    out[name] = res
            except Exception as e:                     # noqa: BLE001
                self.notes[name] = f'ERROR: {type(e).__name__}: {str(e)[:80]}'
        return out
