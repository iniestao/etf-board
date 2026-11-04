"""
因子计算编排
============
从 SQLite 读全市场日线 → 转宽表 → 算技术指标 + Alpha101 → 导出 Parquet。

用法
----
    python compute.py --limit 50 --check        # 小样本冒烟测试
    python compute.py --out ../dist             # 全量导出
    python compute.py --years 3 --out ../dist   # 只算近 N 年（省内存/时间）

设计要点
--------
1. **复权价**：所有价格类计算用 close × adj_factor。原始价只用于展示。
2. **宽表稀疏性**：1717 只 ETF 上市时间跨度 20 年，宽表前置部分是 NaN。
   rolling(min_periods=d) 遇到 NaN 会返回 NaN，这正是我们要的——
   ETF 上市前的「历史」不存在，不能被前向填充伪造出来。
3. **内存**：全量宽表约 5300×1717，单字段 73MB。101 个因子全量驻留约 7GB。
   导出时逐只写盘并释放，避免累积。
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import indicators as ind
from alpha101 import Alpha101


# ---------------------------------------------------------------- 数据加载
def load_panel(db_path: str, years: int | None = None) -> tuple[dict, pd.DataFrame]:
    """读库并转成宽表 dict + meta 表。"""
    con = sqlite3.connect(db_path)
    meta = pd.read_sql('SELECT code, name, exchange, first_date, last_date, bars FROM etf_meta', con)

    where = ''
    if years:
        # 用库内最大日期往前推，避免依赖系统时间
        max_date = con.execute('SELECT MAX(date) FROM etf_daily').fetchone()[0]
        cutoff = pd.Timestamp(max_date) - pd.DateOffset(years=years)
        where = f"WHERE date >= '{cutoff:%Y-%m-%d}'"

    df = pd.read_sql(f'SELECT code, date, open, high, low, close, volume, amount, adj_factor '
                     f'FROM etf_daily {where}', con)
    con.close()

    df['date'] = pd.to_datetime(df['date'])
    print(f'  读入 {len(df):,} 行 / {df.code.nunique()} 只 / '
          f'{df.date.min():%Y-%m-%d} ~ {df.date.max():%Y-%m-%d}', flush=True)

    panel = {}
    for col in ('open', 'high', 'low', 'close', 'volume', 'amount'):
        panel[col] = df.pivot(index='date', columns='code', values=col).sort_index().astype(np.float32)
    panel['adj'] = df.pivot(index='date', columns='code', values='adj_factor').sort_index().astype(np.float32)

    # 复权价：技术指标和因子一律用它
    for col in ('open', 'high', 'low', 'close'):
        panel[f'{col}_adj'] = (panel[col] * panel['adj']).astype(np.float32)

    return panel, meta


def build_groups(meta: pd.DataFrame, cols) -> pd.Series:
    """用名称关键词构造「资产类别」，作为 IndClass 的代理。"""
    RULES = [
        ('cross', ['恒生', '港股', '中概', '纳指', '标普', '日经', '德国', '法国',
                   '东南亚', '亚太', '海外', '全球', '美国', 'QDII', '越南', '沙特',
                   '印度', '日本', '韩国', '中韩', '新兴', '国际']),
        ('commodity', ['黄金', '白银', '豆粕', '有色', '能源化工', '商品', '原油',
                       '饲料', '铜', '豆', '能化']),
        ('bond', ['债', '政金', '信用', '国开', '短融', '城投', '金融债']),
        ('money', ['货币', '现金', '保证金', '日利', '添益', '快线', '快钱',
                   '理财', '财富宝', '金管家', '现金添利', '短债']),
    ]
    BROAD = ['沪深300', '中证300', '中证500', '中证1000', '中证2000', '中证100',
             '上证50', '科创50', '创业板', '科创', '上证', '深证', '中证', 'A50',
             'A500', 'A100', '红利', '价值', '成长', '超大盘', '180', '大盘', '双创']

    def classify(n: str) -> str:
        for g, ws in RULES:
            if any(w in n for w in ws):
                return g
        if any(w in n for w in BROAD):
            return 'broad'
        return 'industry'

    s = meta.set_index('code')['name'].fillna('').map(classify)
    return s.reindex(cols)


# ---------------------------------------------------------------- 指标
def compute_indicators(panel: dict) -> dict[str, pd.DataFrame]:
    """算技术指标。价格类用复权价，量能类用原始量。"""
    o, h, l, c = panel['open_adj'], panel['high_adj'], panel['low_adj'], panel['close_adj']
    v, amt = panel['volume'], panel['amount']
    out: dict[str, pd.DataFrame] = {}

    # --- 趋势
    for n in (5, 10, 20, 60, 120):
        out[f'ma{n}'] = ind.sma(c, n)
    for n in (12, 26):
        out[f'ema{n}'] = ind.ema(c, n)
    dif, dea, hist = ind.macd(c)
    out['macd_dif'], out['macd_dea'], out['macd_hist'] = dif, dea, hist
    pdi, mdi, adx = ind.dmi(h, l, c)
    out['dmi_pdi'], out['dmi_mdi'], out['adx'] = pdi, mdi, adx
    au, ad_ = ind.aroon(h, l)
    out['aroon_up'], out['aroon_down'] = au, ad_
    out['trix'] = ind.trix(c)
    for n in (6, 12, 24):
        out[f'bias{n}'] = ind.bias(c, n)

    # --- 动量
    out['rsi6'] = ind.rsi(c, 6)
    out['rsi14'] = ind.rsi(c, 14)
    out['rsi24'] = ind.rsi(c, 24)
    k, d, j = ind.kdj(h, l, c)
    out['kdj_k'], out['kdj_d'], out['kdj_j'] = k, d, j
    out['wr14'] = ind.williams_r(h, l, c)
    out['roc12'] = ind.roc(c, 12)
    out['mom10'] = ind.mom(c, 10)
    out['cmo14'] = ind.cmo(c, 14)
    out['tsi'] = ind.tsi(c)
    out['uo'] = ind.ultimate_oscillator(h, l, c)
    out['cci20'] = ind.cci(h, l, c)
    out['psy12'] = ind.psy(c)

    # --- 波动
    out['atr14'] = ind.atr(h, l, c)
    out['natr14'] = ind.natr(h, l, c)
    bu, bm, bl, pctb, bw = ind.boll(c)
    out['boll_up'], out['boll_mid'], out['boll_low'] = bu, bm, bl
    out['boll_pctb'], out['boll_width'] = pctb, bw
    ku, km, kl = ind.keltner(h, l, c)
    out['kelt_up'], out['kelt_mid'], out['kelt_low'] = ku, km, kl
    du, dl = ind.donchian(h, l)
    out['donch_up'], out['donch_low'] = du, dl
    out['hvol20'] = ind.hist_vol(c, 20)
    out['hvol60'] = ind.hist_vol(c, 60)
    out['pvol20'] = ind.parkinson_vol(h, l, 20)

    # --- 量能
    out['obv'] = ind.obv(c, v)
    out['ad_line'] = ind.ad_line(h, l, c, v)
    out['cmf20'] = ind.cmf(h, l, c, v)
    out['mfi14'] = ind.mfi(h, l, c, v)
    out['vr26'] = ind.vr(c, v)
    out['vol_ratio5'] = ind.vol_ratio(v, 5)
    out['amt_strength20'] = ind.turnover_proxy(amt, 20)
    out['amihud20'] = ind.amihud(c, amt)

    # 统一降为 float32：宽表 5300×1717，float64 单个就要 73MB，
    # 56 个指标全驻留会吃掉 4GB，容器只有 8GB 配额。
    return {k: v.astype(np.float32) for k, v in out.items()}


# ---------------------------------------------------------------- IC 检验
def _row_corr(A: np.ndarray, B: np.ndarray, min_n: int = 30) -> np.ndarray:
    """逐行 Pearson 相关，向量化实现。

    输入已是 rank 值，所以结果等价于 Spearman IC。
    用 numpy 一次算完，比 pandas 的 corrwith(axis=1) 快两个数量级。
    """
    mask = ~(np.isnan(A) | np.isnan(B))
    n = mask.sum(axis=1)
    A0 = np.where(mask, A, 0.0)
    B0 = np.where(mask, B, 0.0)
    with np.errstate(invalid='ignore', divide='ignore'):
        ma = A0.sum(1) / n
        mb = B0.sum(1) / n
        da = np.where(mask, A - ma[:, None], 0.0)
        db = np.where(mask, B - mb[:, None], 0.0)
        num = (da * db).sum(1)
        den = np.sqrt((da ** 2).sum(1) * (db ** 2).sum(1))
        r = num / den
    r[(n < min_n) | (den <= 0)] = np.nan
    return r


def compute_ic(panel: dict, alphas: dict, horizon: int = 5,
               min_amt: float = 1e7, min_n: int = 30) -> pd.DataFrame:
    """因子 IC 检验。

    可投资域：当日成交额 ≥ min_amt。这一步必须有——1717 只里有大量
    零成交的僵尸 ETF，不剔除的话 IC 会被「不动的价格」稀释成接近 0，
    结论没有意义。

    IC = 因子横截面排名 与 未来 horizon 日收益横截面排名 的相关系数。
    """
    c = panel['close_adj']
    univ = (panel['amount'] >= min_amt) & c.notna()
    fwd = (c.shift(-horizon) / c - 1).where(univ)
    fwd_rank = fwd.rank(axis=1).to_numpy(dtype=np.float64)
    print(f'  可投资域：日均 {univ.sum(axis=1).mean():.0f} 只（成交额≥{min_amt/1e7:.0f}千万）')

    rows = []
    for name, f in alphas.items():
        fr = f.where(univ).rank(axis=1).to_numpy(dtype=np.float64)
        ic = _row_corr(fr, fwd_rank, min_n)
        ic = ic[~np.isnan(ic)]
        if len(ic) < 60:
            rows.append({'alpha': name, 'n_days': len(ic)})
            continue
        mean, std = ic.mean(), ic.std(ddof=1)
        rows.append({
            'alpha': name,
            'n_days': len(ic),
            'ic_mean': round(float(mean), 5),
            'ic_std': round(float(std), 5),
            'ir': round(float(mean / std), 4) if std > 0 else np.nan,
            't_stat': round(float(mean / std * np.sqrt(len(ic))), 2) if std > 0 else np.nan,
            'win_rate': round(float((np.sign(ic) == np.sign(mean)).mean()), 4),
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- 导出
# 有价格量纲的字段：导出时必须统一到「前复权」口径，
# 否则 MA20 会显示 5.275 而 close 是 4.092，图上均线悬在价格上方 29%，
# 看起来像数据错误，实际是两种口径混排。
# 由「后复权价」算出、需要换算成前复权口径的字段。
# 注意不含 open/high/low/close —— 那四个是交易所原始成交价，
# 本来就是最新价口径，再除一次就变成 3.27 了（真实值是 4.09）。
PRICE_FIELDS = {
    'ma5', 'ma10', 'ma20', 'ma60', 'ma120', 'ema12', 'ema26',
    'macd_dif', 'macd_dea', 'macd_hist',
    'atr14', 'boll_up', 'boll_mid', 'boll_low',
    'kelt_up', 'kelt_mid', 'kelt_low', 'donch_up', 'donch_low', 'mom10',
}

# ---------------------------------------------------------------- 前端历史格式
# Parquet 是给回测用的：全历史 165 字段、2.27MB/只。但 Worker 免费版只有
# 10ms CPU，解不了 Parquet（光解压就超时），所以给前端另导一份精简二进制。
#
# 格式（小端，定长，无压缩——压缩省下的传输量还不够解压花的时间）：
#     magic      4B   'ETH1'
#     hdr_len    4B   uint32，JSON header 字节数
#     header     nB   JSON：cols 列名数组 / n 行数 / code / start / end
#     dates      4B×n int32，YYYYMMDD
#     列数据     4B×n×k float32，按 cols 顺序逐列连续存放
#
# 浏览器侧 DataView 直接切片成 Float32Array，不需要 wasm、不需要图表库。
# 列名写进 header 而不是在前端硬编码：以后加字段旧文件也不会静默错位。
HIST_FIELDS = [
    'open', 'high', 'low', 'close', 'volume', 'amount', 'adj_ratio',
    'ma20', 'ma60', 'rsi14', 'macd_dif', 'macd_dea',
    'boll_up', 'boll_low', 'atr14', 'hvol20', 'vol_ratio5',
]
HIST_ROWS = 500          # 约两年交易日。再长在 1200px 屏幕上每根 K 线不足 2px


def write_hist_bin(one: pd.DataFrame, last_adj: float, code: str, path: Path,
                   max_rows: int = HIST_ROWS) -> int:
    """把单只 ETF 的尾部 N 天写成精简二进制，返回字节数。

    one 已做过前复权换算（价格类字段除以 last_adj），所以这里直接取值。
    OHLC 存的是原始成交价——用户要跟券商软件对得上号；
    adj_ratio = adj_factor / last_adj，前端乘上去就能看连续复权曲线。
    """
    tail = one.iloc[-max_rows:]
    n = len(tail)
    if n == 0:
        return 0

    arrs = {}
    for f in HIST_FIELDS:
        if f == 'adj_ratio':
            if 'adj_factor' in tail.columns and last_adj:
                v = tail['adj_factor'].to_numpy(np.float32) / np.float32(last_adj)
            else:
                v = np.ones(n, dtype=np.float32)
        elif f in tail.columns:
            v = tail[f].to_numpy(np.float32)
        else:
            v = np.full(n, np.nan, dtype=np.float32)
        arrs[f] = v

    idx = tail.index
    dates = (idx.year * 10000 + idx.month * 100 + idx.day).to_numpy(np.int32)

    header = json.dumps({
        'code': code, 'n': int(n), 'cols': HIST_FIELDS,
        'start': int(dates[0]), 'end': int(dates[-1]),
    }, separators=(',', ':'), ensure_ascii=False).encode()
    # 补齐到 4 字节：浏览器侧要 new Float32Array(buf, offset, n)，
    # 而 TypedArray 要求 byteOffset 是元素大小的整数倍。
    # JSON 尾部补空格不影响 parse。
    if len(header) % 4:
        header += b' ' * (4 - len(header) % 4)

    buf = bytearray()
    buf += b'ETH1'
    buf += len(header).to_bytes(4, 'little')
    buf += header
    buf += dates.astype('<i4').tobytes()
    for f in HIST_FIELDS:
        buf += arrs[f].astype('<f4').tobytes()

    path.write_bytes(buf)
    return len(buf)



def export(panel: dict, meta: pd.DataFrame, inds: dict, alphas: dict,
           out_dir: Path, notes: dict) -> None:
    """每只 ETF 一个 Parquet（宽表转置），另存全市场快照与清单。

    价格类字段统一转前复权：除以该只最新交易日的 adj_factor。
    OHLC 保持交易所原始成交价（本身就是最新口径），不参与换算；
    均线、通道、MACD、ATR 这些由复权价算出的字段则要换算，
    这样图上「最后一根 K 线 = 真实成交价」，且均线穿过价格带而不是悬在上方。
    Alpha 因子不做缩放——它们绝大多数是 rank 或比值，无量纲；
    少数带价格量纲的（a012/a041/a084）除以同一常数不改变排序，不影响使用。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'etf').mkdir(exist_ok=True)
    (out_dir / 'hist').mkdir(exist_ok=True)

    codes = panel['close'].columns
    # 每只 ETF 最新交易日的复权因子（前复权的基准）
    last_adj = panel['adj'].apply(
        lambda s: s.dropna().iloc[-1] if s.notna().any() else 1.0
    )

    base_cols = {
        'open': panel['open'], 'high': panel['high'], 'low': panel['low'],
        'close': panel['close'], 'volume': panel['volume'], 'amount': panel['amount'],
        'adj_factor': panel['adj'],
    }
    all_cols = {**base_cols, **inds, **alphas}
    name_map = meta.set_index('code')['name'].to_dict()

    print(f'\n  导出 {len(codes)} 只，字段 {len(all_cols)} 个', flush=True)
    t0 = time.time()
    total_bytes = 0
    total_hist = 0
    manifest = []

    for i, code in enumerate(codes, 1):
        # 取该只有数据的日期范围，避免整列 NaN 占位
        sub = {}
        for k, df in all_cols.items():
            if code in df.columns:
                s = df[code]
                if s.notna().any():
                    sub[k] = s
        if not sub:
            continue
        one = pd.DataFrame(sub)
        one.index.name = 'date'
        # 只保留该 ETF 真实存在的交易日
        valid = panel['close'][code].notna()
        one = one.loc[valid[valid].index.intersection(one.index)]
        if one.empty:
            continue

        # 价格类转前复权：除以该只最新交易日的复权因子。
        # 在单只 DataFrame 上做（几万行），不碰全局宽表——否则每列复制一份
        # 36MB 的宽表，22 个价格字段就是 800MB，直接撑爆 8GB 配额。
        k = float(last_adj.get(code, 1.0))
        if k and k != 1.0:
            for c in PRICE_FIELDS:
                if c in one.columns:
                    one[c] = one[c] / k

        one = one.astype(np.float32)
        f = out_dir / 'etf' / f'{code}.parquet'
        one.to_parquet(f, compression='zstd', compression_level=9, index=True)
        total_bytes += f.stat().st_size
        total_hist += write_hist_bin(one, k, code, out_dir / 'hist' / f'{code}.bin')
        manifest.append({
            'code': code, 'name': name_map.get(code, ''),
            'first': one.index.min().strftime('%Y-%m-%d'),
            'last': one.index.max().strftime('%Y-%m-%d'),
            'rows': len(one), 'bytes': f.stat().st_size,
        })
        if i % 100 == 0 or i == len(codes):
            print(f'    {i}/{len(codes)}  {total_bytes/1024/1024:.1f} MB  '
                  f'hist {total_hist/1024/1024:.1f} MB  {time.time()-t0:.0f}s',
                  flush=True)

    # 全市场最新快照：一行一只，含全部字段（用于筛选/排序）
    last_date = panel['close'].index[-1]
    snap = {}
    for k, df in all_cols.items():
        if last_date in df.index:
            snap[k] = df.loc[last_date]
    snap_df = pd.DataFrame(snap)
    snap_df.insert(0, 'name', snap_df.index.map(name_map))
    # 快照同样要转前复权，保持与分片文件一致
    for c in PRICE_FIELDS:
        if c in snap_df.columns:
            snap_df[c] = snap_df[c] / snap_df.index.map(last_adj)
    snap_df.to_parquet(out_dir / 'snapshot.parquet', compression='zstd',
                       compression_level=9)
    print(f'  快照 {out_dir / "snapshot.parquet"}  '
          f'{snap_df.shape[0]} 行 × {snap_df.shape[1]} 列')

    (out_dir / 'manifest.json').write_text(json.dumps({
        'generated_at': pd.Timestamp.now().isoformat(timespec='seconds'),
        'last_trade_date': last_date.strftime('%Y-%m-%d'),
        'codes': len(manifest),
        'fields': list(all_cols.keys()),
        'field_count': len(all_cols),
        'hist': {'format': 'ETH1', 'max_rows': HIST_ROWS,
                 'cols': HIST_FIELDS, 'files': len(manifest),
                 'bytes': total_hist},
        'alpha_notes': {k: v for k, v in notes.items() if k.startswith('a')},
        'items': manifest,
    }, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'  清单 {out_dir / "manifest.json"}')
    print(f'  历史二进制 {len(manifest)} 个 / {total_hist/1024/1024:.1f} MB '
          f'(平均 {total_hist/max(len(manifest),1)/1024:.0f} KB)')


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default='../data/etf.db')
    ap.add_argument('--out', default='../dist')
    ap.add_argument('--limit', type=int, default=0, help='只算前 N 只（测试用）')
    ap.add_argument('--years', type=int, default=0, help='只算最近 N 年')
    ap.add_argument('--check', action='store_true', help='冒烟测试：只报告不导出')
    args = ap.parse_args()

    t_all = time.time()
    print('=' * 64)
    print('  ETF 因子计算')
    print('=' * 64)

    print('\n[1/4] 载入数据')
    panel, meta = load_panel(args.db, args.years or None)

    if args.limit:
        keep = list(panel['close'].columns[:args.limit])
        panel = {k: v[keep] for k, v in panel.items()}
        print(f'  限制为前 {len(keep)} 只')

    codes = panel['close'].columns
    groups = build_groups(meta, codes)
    print(f'  资产类别分布: {groups.value_counts().to_dict()}')

    print('\n[2/4] 技术指标')
    t = time.time()
    inds = compute_indicators(panel)
    print(f'  {len(inds)} 个指标，{time.time()-t:.1f}s')

    print('\n[3/4] Alpha101')
    t = time.time()
    data = {
        'open': panel['open_adj'], 'high': panel['high_adj'],
        'low': panel['low_adj'], 'close': panel['close_adj'],
        'volume': panel['volume'], 'amount': panel['amount'],
    }
    a = Alpha101(data, groups)
    alphas = a.compute_all()
    ok = len(alphas)
    print(f'  成功 {ok}/101，{time.time()-t:.1f}s')

    missing = [f'a{i:03d}' for i in range(1, 102) if f'a{i:03d}' not in alphas]
    if missing:
        print(f'  未产出: {missing}')
    for k, v in a.notes.items():
        print(f'  {k}: {v}')

    # 覆盖率检查：末行非 NaN 的标的占比
    print('\n[4/5] 覆盖率（最后一日非空标的占比）')
    cov = []
    for k, df in alphas.items():
        last = df.iloc[-1]
        cov.append((k, last.notna().sum(), last.notna().mean()))
    cov.sort(key=lambda x: x[2])
    print(f'  最低 5 个: {[(k, f"{r:.0%}") for k, _, r in cov[:5]]}')
    print(f'  最高 5 个: {[(k, f"{r:.0%}") for k, _, r in cov[-5:]]}')
    print(f'  中位覆盖率: {np.median([x[2] for x in cov]):.0%}')

    print('\n[5/5] IC 检验（未来 5 日收益）')
    t = time.time()
    ic_df = compute_ic(panel, alphas, horizon=5)
    ic_df['abs_ic'] = ic_df['ic_mean'].abs()
    ic_df = ic_df.sort_values('abs_ic', ascending=False).drop(columns='abs_ic')
    print(f'  {time.time()-t:.1f}s')
    top = ic_df.dropna(subset=['ic_mean']).head(12)
    print(f'  {"因子":<7}{"IC均值":>9}{"IR":>8}{"t值":>8}{"胜率":>8}{"天数":>7}')
    for _, r in top.iterrows():
        print(f'  {r["alpha"]:<7}{r["ic_mean"]:>9.4f}{r["ir"]:>8.3f}'
              f'{r["t_stat"]:>8.2f}{r["win_rate"]:>8.1%}{int(r["n_days"]):>7}')
    sig = ic_df[(ic_df['t_stat'].abs() > 2) & ic_df['ic_mean'].notna()]
    print(f'  |t| > 2 的因子: {len(sig)} 个')

    if args.check:
        print(f'\n冒烟测试完成，总耗时 {time.time()-t_all:.1f}s')
        return

    print('\n导出')
    export(panel, meta, inds, alphas, Path(args.out), a.notes)
    ic_df.to_csv(Path(args.out) / 'ic_report.csv', index=False, encoding='utf-8-sig')
    print(f'  IC 报告 {Path(args.out) / "ic_report.csv"}')
    print(f'\n完成，总耗时 {time.time()-t_all:.1f}s')


if __name__ == '__main__':
    main()
