"""
因子相关性聚类与低相关组合构建
================================
读 dist/etf/*.parquet → 算 101 个因子的横截面相关矩阵 → 层次聚类 →
按 |IC| 选 5~8 个互不冗余的因子合成打分 → 样本外回测。

为什么必须做这一步
------------------
101 个因子不是 101 个独立信号。若它们高度共线，等权合成等于对少数信号
重复加权，名义分散、实际集中，还会推高换手。

但实测结论与预设相反：**在 ETF 上因子间相关性很低**（pairwise |ρ| 均值 0.11，
中位数 0.06，只有 1.1% 的因子对超过 0.6）。原因有二：
  1. 衰减偏差——ETF 横截面上 alpha 信号本身很弱（IC 0.02 量级），
     两个因子都含大量独立噪声时，观测相关 ≈ 真实相关 × 信噪比乘积；
  2. ETF 只有 1700 只，横截面样本小，相关系数估计方差大。
所以在 ETF 上「因子共线性」不是主要矛盾，「信号太弱」才是。
本脚本因此把重点从「去冗余」改成「在弱相关里挑最强且互补的几个，
并验证组合是否真的强于单因子和全因子等权」。

方法
----
1. 相关矩阵：逐日横截面 Spearman（先 rank 再 Pearson），时间上用
   Fisher z 变换平均（相关系数在 ±1 附近非正态，直接平均会压低绝对值）。
2. 聚类：层次聚类，距离 = 1 − |ρ|。用绝对值是因为 ρ=−0.9 的两个因子
   信息量等价、只是方向相反，属于同一个「信息源」。
3. 选因子：按训练段 |IC| 排序贪心加入，要求与已选因子 |ρ| < thresh。
4. 回测：训练段（前 60%）定因子与方向，测试段（后 40%）只做验证，
   5 日重叠持有，含单边交易成本。

用法
----
    python select_factors.py                       # 默认 3 年、阈值 0.5
    python select_factors.py --years 5 --thresh 0.4 --topn 6
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform

sys.path.insert(0, str(Path(__file__).parent))

FACTORS = [f'a{i:03d}' for i in range(1, 102)]
FACTOR_SET = set(FACTORS)

# 资产类别：ETF 没有行业分类，用名称关键词代理。
# 顺序敏感——先匹配更具体的（跨境/商品/债券/货币），最后才是行业与宽基。
_GROUP_RULES = [
    ('cross', ['恒生', '港股', '中概', '纳指', '标普', '日经', '德国', '法国',
               '东南亚', '亚太', '海外', '全球', '美国', 'QDII', '越南', '沙特',
               '印度', '日本', '韩国', '中韩', '新兴', '国际']),
    ('commodity', ['黄金', '白银', '豆粕', '有色', '能源化工', '商品', '原油',
                   '饲料', '铜', '豆', '能化']),
    ('bond', ['债', '政金', '信用', '国开', '短融', '城投', '金融债']),
    ('money', ['货币', '现金', '保证金', '日利', '添益', '快线', '快钱',
               '理财', '财富宝', '金管家', '现金添利', '短债']),
]
_BROAD = ['沪深300', '中证300', '中证500', '中证1000', '中证2000', '中证100',
          '上证50', '科创50', '创业板', '科创', '上证', '深证', '中证', 'A50',
          'A500', 'A100', '红利', '价值', '成长', '超大盘', '180', '大盘', '双创']


def _classify(name: str) -> str:
    for g, ws in _GROUP_RULES:
        if any(w in name for w in ws):
            return g
    if any(w in name for w in _BROAD):
        return 'broad'
    return 'industry'


def load_groups(dist: Path, codes: list[str]):
    """从 manifest.json 取名称 → 资产类别整数标签（按 codes 顺序）。"""
    mf = json.loads((dist / 'manifest.json').read_text(encoding='utf-8'))
    nm = {it['code']: it.get('name', '') for it in mf['items']}
    cats = [_classify(nm.get(c, '')) for c in codes]
    order = {g: i for i, g in enumerate(
        ['broad', 'industry', 'cross', 'commodity', 'bond', 'money'])}
    return np.array([order.get(c, 1) for c in cats], dtype=np.int8), cats



# ---------------------------------------------------------------- 载入
def load_panel(dist: Path, years: int = 3):
    """把所有分片拼成 (T, N, K) 三维数组 + 成交额 + 复权收盘价。"""
    files = sorted((dist / 'etf').glob('*.parquet'))
    if not files:
        raise SystemExit(f'找不到分片：{dist / "etf"}')

    frames, codes = [], []
    for f in files:
        try:
            df = pd.read_parquet(f)
        except Exception:                              # noqa: BLE001
            continue
        if 'date' in df.columns:
            df = df.set_index('date')
        df.index = pd.to_datetime(df.index)
        if not isinstance(df.index, pd.DatetimeIndex):
            continue
        codes.append(f.stem)
        frames.append(df)

    print(f'  读入 {len(frames)} 只', flush=True)
    alldates = frames[0].index
    for d in frames[1:]:
        alldates = alldates.union(d.index)
    alldates = alldates.sort_values()
    if years:
        alldates = alldates[alldates >= alldates.max() - pd.DateOffset(years=years)]
    alldates = pd.DatetimeIndex(alldates)

    T, N, K = len(alldates), len(codes), len(FACTORS)
    print(f'  面板 {T} 日 × {N} 只 × {K} 因子  '
          f'({alldates[0]:%Y-%m-%d} ~ {alldates[-1]:%Y-%m-%d})', flush=True)

    pos = {d: i for i, d in enumerate(alldates)}
    fpos = {n: i for i, n in enumerate(FACTORS)}
    arr = np.full((T, N, K), np.nan, dtype=np.float32)
    amt = np.full((T, N), np.nan, dtype=np.float32)
    cpx = np.full((T, N), np.nan, dtype=np.float32)

    for j, df in enumerate(frames):
        idx = np.fromiter((pos.get(d, -1) for d in df.index), dtype=np.int64, count=len(df))
        keep = idx >= 0
        if not keep.any():
            continue
        idx = idx[keep]
        sub = df.iloc[keep]
        cols = [c for c in sub.columns if c in FACTOR_SET]
        if cols:
            # 各分片缺列情况不同（a097 覆盖率低、布尔因子无 NaN 列被省略等），
            # 按 (行, 列) 二元索引精确落位，不能假设列顺序一致。
            fc = np.array([fpos[c] for c in cols], dtype=np.intp)
            arr[:, j, :][idx[:, None], fc[None, :]] = sub[cols].to_numpy(dtype=np.float32)
        if 'amount' in sub.columns:
            amt[idx, j] = sub['amount'].to_numpy(dtype=np.float32)
        if 'close' in sub.columns:
            adj = (sub['adj_factor'].to_numpy(dtype=np.float32)
                   if 'adj_factor' in sub.columns else 1.0)
            cpx[idx, j] = sub['close'].to_numpy(dtype=np.float32) * adj

    return arr, amt, cpx, codes, alldates


# ---------------------------------------------------------------- 相关矩阵
def _row_rank(X: np.ndarray) -> np.ndarray:
    """按列（横截面）转秩次，NaN 保持。"""
    return pd.DataFrame(X).rank(axis=0, method='average').to_numpy(dtype=np.float64)


def cross_sectional_corr(arr: np.ndarray, amt: np.ndarray, cpx: np.ndarray,
                         t0: int = 0, t1: int | None = None,
                         min_amt: float = 1e7, min_n: int = 100):
    """逐日横截面 Spearman 相关，时间上做 Fisher z 平均。

    用矩阵乘法一次性算完 pairwise 的相关系数，避免 5050 次双重循环：
      n_ij  = Σ m_i m_j
      Sx_ij = Σ x_i m_j          （x 已 rank、已 mask）
    NaN 按 pairwise 剔除，不会被填充污染。
    """
    T, N, K = arr.shape
    t1 = T if t1 is None else t1
    zsum = np.zeros((K, K), dtype=np.float64)
    zcnt = np.zeros((K, K), dtype=np.int32)
    n_days = 0

    for t in range(t0, t1):
        valid = (amt[t] >= min_amt) & np.isfinite(cpx[t]) & ~np.isnan(arr[t, :, 0])
        if valid.sum() < min_n:
            continue
        X = arr[t][valid]
        R = _row_rank(X)
        M = (~np.isnan(R)).astype(np.float64)
        Z = np.where(np.isnan(R), 0.0, R)

        n = M.T @ M
        sx = Z.T @ M
        sy = M.T @ Z
        sxy = Z.T @ Z
        sxx = (Z * Z).T @ M
        syy = M.T @ (Z * Z)

        with np.errstate(invalid='ignore', divide='ignore'):
            mx = sx / n
            my = sy / n
            cov = sxy / n - mx * my
            vx = sxx / n - mx ** 2
            vy = syy / n - my ** 2
            r = cov / np.sqrt(vx * vy)
        ok = np.isfinite(r) & (n >= min_n)
        r = np.clip(r, -0.999999, 0.999999)
        zsum[ok] += np.arctanh(r[ok])
        zcnt[ok] += 1
        n_days += 1

        if n_days % 200 == 0:
            print(f'    {n_days} 日', flush=True)

    with np.errstate(invalid='ignore', divide='ignore'):
        z = np.where(zcnt > 0, zsum / np.maximum(zcnt, 1), np.nan)
    corr = np.tanh(z)
    np.fill_diagonal(corr, 1.0)
    return corr, n_days


# ---------------------------------------------------------------- IC
def compute_ic(arr: np.ndarray, amt: np.ndarray, cpx: np.ndarray,
               t0: int = 0, t1: int | None = None,
               horizon: int = 5, min_amt: float = 1e7,
               gidx: np.ndarray | None = None) -> pd.DataFrame:
    """因子与未来 horizon 日收益的横截面 Spearman 相关（逐日，再取时序均值）。

    gidx 不为空时先做「组内分位」再算相关：把每只 ETF 的因子值换成它在
    同资产类别内的分位数，未来收益也同理。这样剔除「黄金整体涨、债券整体跌」
    这类类别效应，只留下类别内部的选股差异。

    ETF 全市场不分组的横截面 rank 会被类别差异主导——不同资产类别的波动率
    差 3~5 倍，同一个因子值在黄金里和在货币里含义完全不同。不中性化的话
    IC 会被稀释，看起来像是「因子无效」，其实是「因子在赌类别」。
    """
    T = arr.shape[0]
    t1 = T if t1 is None else t1
    fwd = np.full_like(cpx, np.nan)
    fwd[:T - horizon] = cpx[horizon:] / cpx[:T - horizon] - 1

    ic_mat = np.full((t1 - t0, arr.shape[2]), np.nan, dtype=np.float64)
    for t in range(t0, t1 - horizon):
        valid = ((amt[t] >= min_amt) & np.isfinite(cpx[t])
                 & np.isfinite(fwd[t]) & ~np.isnan(arr[t, :, 0]))
        if valid.sum() < 50:
            continue
        X = arr[t][valid].astype(np.float64)
        y = fwd[t][valid].astype(np.float64)
        if gidx is None:
            R = _row_rank(X)
            ry = pd.Series(y).rank().to_numpy()
        else:
            g = gidx[valid]
            R = np.full_like(X, np.nan)
            ry = np.full(len(y), np.nan)
            for gg in np.unique(g):
                m = g == gg
                if m.sum() < 8:
                    continue
                R[m] = pd.DataFrame(X[m]).rank().to_numpy() / m.sum()
                ry[m] = pd.Series(y[m]).rank().to_numpy() / m.sum()

        M = ~np.isnan(R) & np.isfinite(ry)[:, None]
        Z = np.where(M, R, 0.0)
        n = M.sum(axis=0).astype(np.float64)
        my = np.nanmean(ry)
        with np.errstate(invalid='ignore', divide='ignore'):
            mx = Z.sum(axis=0) / n
            dx = np.where(M, Z - mx, 0.0)
            dy = np.where(np.isfinite(ry), ry - my, 0.0)
            num = (dx * dy[:, None]).sum(axis=0)
            den = np.sqrt((dx ** 2).sum(axis=0) * (dy ** 2).sum())
            ic_mat[t - t0] = np.where((n >= 50) & (den > 0), num / den, np.nan)

    rows = []
    for k, name in enumerate(FACTORS):
        v = ic_mat[:, k]
        v = v[np.isfinite(v)]
        if len(v) < 30:
            rows.append({'alpha': name, 'n_days': len(v)})
            continue
        mu, sd = v.mean(), v.std(ddof=1)
        rows.append({
            'alpha': name, 'n_days': int(len(v)),
            'ic_mean': round(float(mu), 5), 'ic_std': round(float(sd), 5),
            'ir': round(float(mu / sd), 4) if sd > 0 else np.nan,
            't_stat': round(float(mu / sd * np.sqrt(len(v))), 2) if sd > 0 else np.nan,
            'win_rate': round(float((np.sign(v) == np.sign(mu)).mean()), 4),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- 聚类
def cluster_factors(corr: np.ndarray, thresh: float = 0.5):
    """距离 = 1 − |ρ|，average linkage。返回 (簇标签, linkage)。"""
    c = np.nan_to_num(corr, nan=0.0)
    c = (c + c.T) / 2
    np.fill_diagonal(c, 1.0)
    d = np.clip(1.0 - np.abs(c), 0, None)
    np.fill_diagonal(d, 0.0)
    Z = linkage(squareform(d, checks=False), method='average')
    return fcluster(Z, t=1.0 - thresh, criterion='distance'), Z


def pick_factors(corr: np.ndarray, ic: pd.DataFrame, labels: np.ndarray,
                 topn: int, max_pair_corr: float = 0.5) -> list[dict]:
    """按 |IC| 排序贪心选，强制与已选因子两两 |ρ| < max_pair_corr。

    簇号只作标注（说明这个因子属于哪个信息族），不作硬约束——
    实测簇数过多时按簇取代表退化成「无约束按 IC 排序」，不如直接贪心。
    """
    idx = {n: i for i, n in enumerate(FACTORS)}
    lab = dict(zip(FACTORS, labels))
    icm = ic.set_index('alpha')
    ranked = ic.reindex(ic['ic_mean'].abs().sort_values(ascending=False).index)
    ranked = ranked.dropna(subset=['ic_mean'])

    chosen: list[dict] = []
    for name in ranked['alpha']:
        if len(chosen) >= topn:
            break
        if name not in idx:
            continue
        rho_max, blocker = 0.0, None
        for q in chosen:
            r = abs(corr[idx[name], idx[q['alpha']]])
            if np.isfinite(r) and r > rho_max:
                rho_max, blocker = r, q['alpha']
        if rho_max >= max_pair_corr:
            continue
        row = icm.loc[name]
        chosen.append({
            'alpha': name, 'ic_mean': float(row['ic_mean']),
            'ir': float(row['ir']), 't_stat': float(row['t_stat']),
            'win_rate': float(row['win_rate']),
            'cluster': int(lab[name]),
            'max_rho_with_chosen': round(float(rho_max), 3),
            'max_rho_vs': blocker,
        })
    return chosen


# ---------------------------------------------------------------- 组合
def build_score(arr: np.ndarray, names: list[str], signs: np.ndarray,
                gidx: np.ndarray | None = None) -> np.ndarray:
    """横截面 z-score（截尾 ±3）→ 组内去均值 → 按 IC 符号定向 → 等权合成。

    组内去均值这一步不能省：黄金、债券、货币 ETF 的波动率差 3~5 倍，
    同一个 z-score 在这三类里的经济含义完全不同。不去均值的话，
    组合会变成「押注低波动类别」而不是「在类别内选好的」。
    """
    T, N, K = arr.shape
    idx = {n: i for i, n in enumerate(FACTORS)}
    score = np.full((T, N), np.nan, dtype=np.float64)
    rows = [idx[n] for n in names]

    for t in range(T):
        Z = np.full((N, len(rows)), np.nan)
        for j, k in enumerate(rows):
            x = arr[t, :, k].astype(np.float64)
            m = np.isfinite(x)
            if m.sum() < 50:
                continue
            v = x[m]
            sd = v.std(ddof=0)
            if sd <= 0:
                continue
            z = np.full(N, np.nan)
            z[m] = np.clip((v - v.mean()) / sd, -3, 3)
            if gidx is not None:
                for gg in np.unique(gidx):
                    gm = m & (gidx == gg)
                    if gm.sum() >= 8:
                        z[gm] -= z[gm].mean()
            Z[:, j] = z
        cnt = (~np.isnan(Z)).sum(axis=1)
        # 覆盖率门槛：只靠 2 个因子拼出来的分数方差远大于用满 8 个的，
        # 不加门槛的话组合会系统性偏向「数据不全的新上市 / 长期停牌 ETF」。
        min_cnt = max(1, int(0.5 * len(rows)))
        with np.errstate(invalid='ignore'):
            s = np.nansum(np.where(np.isnan(Z), 0.0, Z) * signs, axis=1) / np.maximum(cnt, 1)
        score[t] = np.where(cnt >= min_cnt, s, np.nan)
    return score


def _select_holds(score: np.ndarray, amt: np.ndarray, cpx: np.ndarray,
                  t0: int, t1: int, top_pct: float, min_amt: float,
                  gidx: np.ndarray | None, side: int = 1) -> np.ndarray:
    """逐日选出持仓集合。side=1 取多头 top，side=-1 取空头 bottom。"""
    T, N = cpx.shape
    univ = (amt >= min_amt) & np.isfinite(score) & np.isfinite(cpx)
    holds = np.zeros((T, N), dtype=bool)
    for t in range(t0, min(t1, T - 1)):
        m = univ[t]
        if m.sum() < 50:
            continue
        s = np.where(m, score[t], np.inf * side)
        if gidx is None:
            k = max(5, int(m.sum() * top_pct))
            thr = np.partition(s, -k)[-k] if side > 0 else np.partition(s, k - 1)[k - 1]
            holds[t] = m & ((s >= thr) if side > 0 else (s <= thr))
        else:
            for gg in np.unique(gidx):
                gm = m & (gidx == gg)
                if gm.sum() < 3:
                    continue
                k = max(1, int(gm.sum() * top_pct))
                if side > 0:
                    thr = np.partition(s[gm], -k)[-k]
                    holds[t] |= gm & (s >= thr)
                else:
                    thr = np.partition(s[gm], k - 1)[k - 1]
                    holds[t] |= gm & (s <= thr)
    return holds


def _run_holds(holds: np.ndarray, ret: np.ndarray, t0: int, t1: int,
               horizon: int, cost_bp: float) -> tuple[np.ndarray, float]:
    """把逐日持仓集合变成日收益序列（horizon 日重叠持有）。"""
    T, N = ret.shape
    ret0 = np.where(np.isfinite(ret), ret, 0.0)
    port, turn = [], []
    prev_w = np.zeros(N, dtype=np.float64)
    for t in range(t0, min(t1, T)):
        batch = holds[max(t0, t - horizon):t]
        if batch.size == 0:
            port.append(np.nan)
            turn.append(0.0)
            continue
        w = batch.mean(axis=0).astype(np.float64)
        tot = w.sum()
        if tot <= 0:
            port.append(np.nan)
            turn.append(0.0)
            continue
        w /= tot
        to = 0.5 * float(np.abs(w - prev_w).sum())
        port.append(float(w @ ret0[t]) - to * cost_bp * 1e-4 * 2)
        turn.append(to)
        prev_w = w
    return np.array(port, dtype=float), (float(np.nanmean(turn)) if turn else np.nan)


def backtest(score: np.ndarray, amt: np.ndarray, cpx: np.ndarray,
             t0: int, t1: int, horizon: int = 5, top_pct: float = 0.1,
             min_amt: float = 1e7, cost_bp: float = 2.0,
             gidx: np.ndarray | None = None) -> dict:
    """多头 / 空头 / 多空三组收益。

    多空（top − bottom）是检验因子有没有 α 的标准做法：
    多头组合的绝对收益里混着市场 β 和资产类别 β，只看它无法区分
    「因子有效」和「刚好押对了方向」。多空对冲掉 β，剩下的才是 α。

    gidx 不为空时在每个资产类别内部选，避免组合退化成类别押注。
    """
    T, N = cpx.shape
    ret = np.full((T, N), np.nan)
    ret[1:] = cpx[1:] / cpx[:-1] - 1
    ret = np.clip(ret, -0.5, 0.5)

    hl = _select_holds(score, amt, cpx, t0, t1, top_pct, min_amt, gidx, 1)
    hs = _select_holds(score, amt, cpx, t0, t1, top_pct, min_amt, gidx, -1)
    dl, tl = _run_holds(hl, ret, t0, t1, horizon, cost_bp)
    ds, ts = _run_holds(hs, ret, t0, t1, horizon, cost_bp)
    ls = dl - ds

    return {'daily': dl, 'daily_short': ds, 'daily_ls': ls,
            'turnover': tl, 'turnover_ls': (tl + ts), 'holds': hl}


def stats(p: np.ndarray, tag: str = '') -> dict:
    p = p[np.isfinite(p)]
    if len(p) < 30:
        return {'days': int(len(p))}
    nav = np.cumprod(1 + p)
    ann = nav[-1] ** (244 / len(p)) - 1
    vol = p.std(ddof=1) * np.sqrt(244)
    dd = float((nav / np.maximum.accumulate(nav) - 1).min())
    return {
        'days': int(len(p)),
        'ann_ret': round(float(ann), 4),
        'ann_vol': round(float(vol), 4),
        'sharpe': round(float(ann / vol), 3) if vol > 0 else None,
        'max_dd': round(dd, 4),
        'win_rate': round(float((p > 0).mean()), 4),
    }


def combo_ic(score: np.ndarray, cpx: np.ndarray, amt: np.ndarray,
             t0: int, t1: int, horizon: int = 5, min_amt: float = 1e7,
             gidx: np.ndarray | None = None) -> dict:
    """合成打分的 IC / IR —— 判断组合是否真的强于单因子。"""
    T = cpx.shape[0]
    fwd = np.full_like(cpx, np.nan)
    fwd[:T - horizon] = cpx[horizon:] / cpx[:T - horizon] - 1
    vals = []
    for t in range(t0, min(t1, T - horizon)):
        valid = ((amt[t] >= min_amt) & np.isfinite(fwd[t])
                 & np.isfinite(score[t]) & np.isfinite(cpx[t]))
        if valid.sum() < 50:
            continue
        s = score[t][valid]
        y = fwd[t][valid]
        if gidx is None:
            sr = pd.Series(s).rank()
            yr = pd.Series(y).rank()
        else:
            g = gidx[valid]
            sr = np.full(len(s), np.nan)
            yr = np.full(len(y), np.nan)
            for gg in np.unique(g):
                m = g == gg
                if m.sum() < 8:
                    continue
                sr[m] = pd.Series(s[m]).rank().to_numpy() / m.sum()
                yr[m] = pd.Series(y[m]).rank().to_numpy() / m.sum()
        r = np.corrcoef(sr, yr)[0, 1]
        if np.isfinite(r):
            vals.append(r)
    v = np.array(vals)
    if len(v) < 30:
        return {'n_days': len(v)}
    mu, sd = v.mean(), v.std(ddof=1)
    return {'n_days': int(len(v)), 'ic_mean': round(float(mu), 5),
            'ir': round(float(mu / sd), 4), 't_stat': round(float(mu / sd * np.sqrt(len(v))), 2)}


# ---------------------------------------------------------------- 画图
def plot_heatmap(corr: np.ndarray, labels: np.ndarray, out: Path) -> None:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    order = np.lexsort((np.arange(len(FACTORS)), labels))
    c = np.nan_to_num(corr, nan=0.0)[np.ix_(order, order)]

    # 色标不能固定 ±1：实测 99% 的因子对都落在 ±0.5 内，
    # 用 ±1 会让整张图变成一片白，看不出结构。
    off = np.abs(c - np.eye(len(c)))
    lim = float(np.percentile(off, 99.5))
    lim = max(lim, 0.2)

    fig, ax = plt.subplots(figsize=(12, 10.5), dpi=150)
    im = ax.imshow(c, cmap='RdBu_r', vmin=-lim, vmax=lim, interpolation='nearest')
    ticks = list(range(0, 101, 4))
    ax.set_xticks(ticks)
    ax.set_yticks(ticks)
    ax.set_xticklabels([FACTORS[i][1:] for i in order[::4]], fontsize=7, rotation=90)
    ax.set_yticklabels([FACTORS[i][1:] for i in order[::4]], fontsize=7)

    # 只标出较大的簇（size≥4）的边界，73 条线全画会糊成网格噪声
    lab_sorted = labels[order]
    b, start = [], 0
    for i in range(1, len(lab_sorted) + 1):
        if i == len(lab_sorted) or lab_sorted[i] != lab_sorted[start]:
            if i - start >= 4:
                b += [start, i]
            start = i
    for x in b:
        ax.axhline(x - 0.5, color='k', lw=0.8, alpha=0.55)
        ax.axvline(x - 0.5, color='k', lw=0.8, alpha=0.55)

    ax.set_title(f'Alpha101 cross-sectional Spearman correlation, ETF universe (train window)\n'
                 f'{len(set(labels))} clusters at |rho|>=0.5; colour clipped at +/-{lim:.2f}',
                 fontsize=11)
    fig.colorbar(im, ax=ax, shrink=0.75, label='corr')
    fig.tight_layout()
    fig.savefig(out, bbox_inches='tight')
    plt.close(fig)


def plot_nav(curves: dict, out: Path) -> None:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(10, 4.6), dpi=150)
    for lab, (x, y, lw) in curves.items():
        ax.plot(x, y, lw=lw, label=lab, alpha=0.9)
    ax.set_yscale('log')
    ax.set_ylabel('NAV (log)')
    ax.grid(alpha=0.25)
    ax.legend(fontsize=9)
    ax.set_title('out-of-sample NAV, 5-day overlapping hold, cost 2bp one-way', fontsize=10)
    fig.tight_layout()
    fig.savefig(out, bbox_inches='tight')
    plt.close(fig)


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dist', default='../dist')
    ap.add_argument('--years', type=int, default=3)
    ap.add_argument('--thresh', type=float, default=0.5, help='聚类阈值 |rho|')
    ap.add_argument('--topn', type=int, default=8)
    ap.add_argument('--horizon', type=int, default=5)
    ap.add_argument('--split', type=float, default=0.6, help='训练段占比')
    args = ap.parse_args()

    dist = Path(args.dist)
    t0 = time.time()

    print('=' * 64)
    print('  因子相关性聚类 / 低相关组合')
    print('=' * 64)

    print('\n[1/5] 载入面板')
    arr, amt, cpx, codes, dates = load_panel(dist, args.years)
    T = arr.shape[0]
    cut = int(T * args.split)
    print(f'  训练段 {dates[0]:%Y-%m-%d} ~ {dates[cut-1]:%Y-%m-%d} ({cut} 日)')
    print(f'  测试段 {dates[cut]:%Y-%m-%d} ~ {dates[-1]:%Y-%m-%d} ({T-cut} 日)')

    print('\n[2/5] 相关矩阵（训练段）')
    t = time.time()
    corr, nd = cross_sectional_corr(arr, amt, cpx, 0, cut)
    a = np.abs(corr.copy())
    np.fill_diagonal(a, np.nan)
    print(f'  {nd} 日，pairwise |rho| 均值 {np.nanmean(a):.3f} / '
          f'中位 {np.nanmedian(a):.3f} / p95 {np.nanpercentile(a, 95):.3f}')
    print(f'  |rho|>0.6 的因子对占比 {100*np.nanmean(a > 0.6):.1f}%  ({time.time()-t:.0f}s)')

    print('\n[3/5] 聚类 + IC（训练段）')
    labels, _ = cluster_factors(corr, args.thresh)
    gidx, cats = load_groups(dist, codes)
    print('  资产类别分布: ' + '  '.join(
        f'{g}={c}' for g, c in pd.Series(cats).value_counts().items()))

    ic_raw = compute_ic(arr, amt, cpx, 0, cut, horizon=args.horizon)
    ic = compute_ic(arr, amt, cpx, 0, cut, horizon=args.horizon, gidx=gidx)
    n_cl = len(set(labels))
    sizes = pd.Series(labels).value_counts()
    print(f'  {n_cl} 个簇（|rho|≥{args.thresh}），最大簇 {sizes.iloc[0]} 个因子')

    cmp = pd.DataFrame({
        'alpha': ic_raw['alpha'].values,
        'ic_all': ic_raw['ic_mean'].values,
        'ic_grp': ic['ic_mean'].values,
        't_all': ic_raw['t_stat'].values,
        't_grp': ic['t_stat'].values,
    })
    print(f'  全市场 IC 均值 {cmp.ic_all.abs().mean():.4f}  '
          f'|t|>2 的 {int((cmp.t_all.abs() > 2).sum())} 个')
    print(f'  类别内 IC 均值 {cmp.ic_grp.abs().mean():.4f}  '
          f'|t|>2 的 {int((cmp.t_grp.abs() > 2).sum())} 个')
    ic = ic.sort_values('ic_mean', key=np.abs, ascending=False)

    picks = pick_factors(corr, ic, labels, args.topn, args.thresh)
    print(f'\n  选出 {len(picks)} 个（两两 |rho| < {args.thresh}）:')
    print(f'  {"因子":<7}{"IC组内":>9}{"IR":>8}{"t值":>7}{"胜率":>7}{"簇":>5}{"最大rho":>9}')
    for p in picks:
        print(f"  {p['alpha']:<7}{p['ic_mean']:>9.4f}{p['ir']:>8.3f}"
              f"{p['t_stat']:>7.2f}{p['win_rate']:>7.1%}{p['cluster']:>5}"
              f"{p['max_rho_with_chosen']:>9.3f}")

    print('\n[4/5] 组合回测（测试段，样本外，类别中性）')
    names = [p['alpha'] for p in picks]
    signs_pick = np.array([np.sign(p['ic_mean']) or 1.0 for p in picks])
    score_pick = build_score(arr, names, signs_pick, gidx)

    # 对照组：101 个全用，按训练段 IC 符号定向等权
    all_names, all_signs = [], []
    for _, r in ic.dropna(subset=['ic_mean']).iterrows():
        all_names.append(r['alpha'])
        all_signs.append(np.sign(r['ic_mean']) or 1.0)
    score_all = build_score(arr, all_names, np.array(all_signs), gidx)

    # 对照组：单因子最强
    best = picks[0]['alpha']
    score_best = build_score(arr, [best], np.array([np.sign(picks[0]['ic_mean']) or 1.0]), gidx)

    res = {}
    for tag, sc in (('pick', score_pick), ('all', score_all), ('best', score_best)):
        r = backtest(sc, amt, cpx, cut, T, horizon=args.horizon, gidx=gidx)
        res[tag] = r
        res[tag]['ic'] = combo_ic(sc, cpx, amt, cut, T, horizon=args.horizon, gidx=gidx)

    # 样本内对照：同一套因子、同一套权重，在训练段回测。
    # 若样本内也是负的，说明实现有问题；若样本内很好、样本外崩，
    # 说明 IC 不可外推。这个对照决定了结论的性质，不能省。
    res_in = backtest(score_pick, amt, cpx, 0, cut, horizon=args.horizon, gidx=gidx)
    res_in_all = backtest(score_all, amt, cpx, 0, cut, horizon=args.horizon, gidx=gidx)
    st_in, st_in_all = stats(res_in['daily_ls']), stats(res_in_all['daily_ls'])

    # 基准：全市场等权
    univ = (amt >= 1e7) & np.isfinite(cpx)
    ret = np.full_like(cpx, np.nan)
    ret[1:] = cpx[1:] / cpx[:-1] - 1
    bm = np.array([np.nanmean(np.where(univ[t], np.clip(ret[t], -.5, .5), np.nan))
                   if univ[t].sum() > 20 else np.nan for t in range(cut, T)])

    print(f'\n  {"策略":<18}{"年化":>9}{"波动":>8}{"夏普":>7}{"回撤":>9}'
          f'{"IC":>8}{"IR":>7}{"换手":>7}')
    rows = []
    for tag, label in (('pick', f'{len(names)}因子组合'), ('all', '101因子等权'),
                       ('best', f'单因子{best}')):
        icr = res[tag]['ic']
        for kind, key, lto in (('多头', 'daily', 'turnover'),
                               ('多空', 'daily_ls', 'turnover_ls')):
            st = stats(res[tag][key])
            to = res[tag][lto]
            print(f"  {label + ' ' + kind:<18}{st.get('ann_ret',0):>9.1%}"
                  f"{st.get('ann_vol',0):>8.1%}{st.get('sharpe') or 0:>7.2f}"
                  f"{st.get('max_dd',0):>9.1%}"
                  f"{(icr.get('ic_mean') if kind == '多头' else 0) or 0:>8.4f}"
                  f"{(icr.get('ir') if kind == '多头' else 0) or 0:>7.3f}"
                  f"{(to or 0):>7.0%}")
            rows.append({'strategy': f'{label} {kind}', **st,
                         'ic_mean': icr.get('ic_mean') if kind == '多头' else None,
                         'ir': icr.get('ir') if kind == '多头' else None,
                         'turnover': round(to, 3) if to == to else None})
    st = stats(bm)
    print(f"  {'全市场等权 多头':<18}{st.get('ann_ret',0):>9.1%}"
          f"{st.get('ann_vol',0):>8.1%}{st.get('sharpe') or 0:>7.2f}"
          f"{st.get('max_dd',0):>9.1%}")
    rows.append({'strategy': '全市场等权 多头', **st})

    print(f"\n  样本内对照（训练段自身回测，多空）:")
    print(f"  8因子组合   年化 {st_in.get('ann_ret',0):>7.1%}  "
          f"夏普 {st_in.get('sharpe') or 0:>5.2f}  回撤 {st_in.get('max_dd',0):>7.1%}")
    print(f"  101因子等权 年化 {st_in_all.get('ann_ret',0):>7.1%}  "
          f"夏普 {st_in_all.get('sharpe') or 0:>5.2f}  回撤 {st_in_all.get('max_dd',0):>7.1%}")

    print(f'\n[5/5] 落盘')

    # ---- 输出
    pd.DataFrame(corr, index=FACTORS, columns=FACTORS).to_parquet(
        dist / 'factor_corr.parquet', compression='zstd', compression_level=9)
    cl = pd.DataFrame({'alpha': FACTORS, 'cluster': labels})
    cl['cluster_size'] = cl['cluster'].map(cl['cluster'].value_counts())
    cl = cl.merge(ic[['alpha', 'ic_mean', 'ir', 't_stat', 'win_rate', 'n_days']],
                  on='alpha', how='left')
    cl = cl.merge(cmp[['alpha', 'ic_all', 't_all']], on='alpha', how='left')
    cl['picked'] = cl['alpha'].isin(names)
    cl.to_csv(dist / 'factor_clusters.csv', index=False, encoding='utf-8-sig')
    pd.DataFrame(rows).to_csv(dist / 'combo_backtest.csv', index=False,
                              encoding='utf-8-sig')

    payload = {
        'generated_at': pd.Timestamp.now().isoformat(timespec='seconds'),
        'window': [str(dates[0].date()), str(dates[-1].date())],
        'train': [str(dates[0].date()), str(dates[cut - 1].date())],
        'test': [str(dates[cut].date()), str(dates[-1].date())],
        'train_days': int(nd), 'test_days': int(T - cut),
        'cluster_thresh': args.thresh, 'clusters': n_cl,
        'corr_stats': {
            'mean_abs': round(float(np.nanmean(a)), 4),
            'median_abs': round(float(np.nanmedian(a)), 4),
            'p95_abs': round(float(np.nanpercentile(a, 95)), 4),
            'share_gt_0.6': round(float(np.nanmean(a > 0.6)), 4),
        },
        'picks': picks,
        'backtest': rows,
        'horizon': args.horizon,
    }
    (dist / 'factor_combo.json').write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')

    plot_heatmap(corr, labels, dist / 'corr_heatmap.png')
    idx_dates = dates[cut:T]
    curves = {}
    base = 100.0
    for tag, label, lw in (('pick', f'combo L/S ({len(names)}f)', 1.8),
                           ('all', '101 factors L/S', 1.1),
                           ('best', f'single {best} L/S', 1.0)):
        s = res[tag]['daily_ls']
        nav = np.cumprod(1 + np.nan_to_num(s, nan=0.0))
        curves[label] = (idx_dates[:len(nav)], base * nav, lw)
    nb = np.cumprod(1 + np.nan_to_num(bm, nan=0.0))
    curves['all-ETF long'] = (idx_dates[:len(nb)], base * nb, 1.2)
    plot_nav(curves, dist / 'combo_nav.png')

    print(f'  factor_corr.parquet / factor_clusters.csv / factor_combo.json')
    print(f'  combo_backtest.csv / corr_heatmap.png / combo_nav.png')
    print(f'\n总耗时 {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
