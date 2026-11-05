"""
全市场异动快照
==============
把「自选里哪只今天动了」升级成「全部 468 个指数今天谁动了」。

为什么要在收盘后预计算
----------------------
盯盘页原本只诊断自选，因为拉历史是逐只请求，几百只会把 /api/hist 打爆。
但「全市场谁创新高」恰恰是最该每天看一眼的东西——只看自选等于只在自己
已经知道的池子里找机会。这里改成收盘后一次性算完，产出一个 30KB 的 JSON，
页面只读一个文件就拿到全市场的状态。

口径
----
1. **一个指数只留一只 ETF**：1700 只 ETF 对应 468 个指数，同指数日收益相关
   0.99 以上。每个交易日选该指数内 20 日均成交额最大的那只做代表，否则
   「创新高」会被 40 只中证A500 刷屏。
2. **剔除债券、货币**：这两类的日收益由计息规则和资金面决定，「放量突破」
   是申购赎回，不是价格发现，量价信号没有经济含义。
3. **后复权价**：close × adj_factor。后复权把最新价锚定在真实市价上，所以
   算出来的高低点可以直接和页面上的实时价比较，前端能就地重算位置。

位置的定义
----------
    pos = (今收 - 近 250 日最低) / (近 250 日最高 - 近 250 日最低) × 100

「昨天位置」用同一套高低点算，所以 pos - posPrev 是今天真实的位移，而不是
区间自己在动。这一点很关键：如果每天都用含当天的区间，位置永远在自己的
区间里，看不出「今天刚突破」。

用法
----
    python events.py --db ../data/etf.db --out ../dist
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path

import numpy as np
import pandas as pd

# 高位/低位分界，与前端标签阈值一致
HI, LO = 80.0, 20.0
# 量能倍数阈值
VOL_HOT, VOL_DRY = 2.0, 0.55
# 一年区间
LOOKBACK = 250

COLS = ['code', 'name', 'idx', 'pos', 'posPrev', 'evr', 'r20', 'r1',
        'hh', 'll', 'amt']


# ----------------------------------------------------------------- 分类与去重
_MONEY = ('货币', '现金', '理财', '保证金', '日利', '添益', '快线', '收添利')
_BOND = ('债', '短融', '政金', '国开', '进出口', '口行', '信用', '城投', '存单',
         '利率', '中票', '金融债', '公司债')


def classify(name: str, idx: str = '') -> str:
    """剔除债券/货币。名称 + 跟踪指数名双口径，只靠名称会漏掉「短融」「日利」这类。"""
    for t in (str(name), str(idx or '')):
        if any(k in t for k in _MONEY):
            return 'money'
        if any(k in t for k in _BOND):
            return 'bond'
    return 'equity'


def load(db: str, keep_days: int = 420):
    con = sqlite3.connect(db)
    meta = pd.read_sql('SELECT code, name FROM etf_meta', con)
    dates = [r[0] for r in con.execute(
        'SELECT DISTINCT date FROM etf_daily ORDER BY date').fetchall()]
    start = dates[-keep_days] if len(dates) > keep_days else dates[0]
    df = pd.read_sql(
        f"SELECT code, date, high, low, close, amount, adj_factor "
        f"FROM etf_daily WHERE date >= '{start}' ORDER BY date", con)
    con.close()
    df['date'] = pd.to_datetime(df['date'])
    # 未复权收盘单独留一份：后复权的锚点不一定等于今天的市价，
    # 页面上的实时价是原始价，区间高低点必须换算到同一尺度才能比。
    raw_close = df.pivot(index='date', columns='code', values='close').sort_index()
    for c in ('high', 'low', 'close'):
        df[c] = df[c] * df['adj_factor']
    wide = {c: df.pivot(index='date', columns='code', values=c).sort_index()
            for c in ('high', 'low', 'close', 'amount')}
    wide['raw'] = raw_close
    return wide, meta.set_index('code')['name'], dates[-1]


def index_tags(meta_names: pd.Series) -> pd.Series:
    """code -> 跟踪指数名。没有映射的 ETF 自己独立成一组（用代码当组名）。"""
    p = Path(__file__).resolve().parent.parent / 'pipeline/index_map.json'
    if not p.exists():
        return pd.Series(dtype=object)
    rows = (json.loads(p.read_text()).get('map') or {})
    return pd.Series({k: v['idx'] for k, v in rows.items()
                      if isinstance(v, dict) and v.get('idx')}, dtype=object)



# ----------------------------------------------------------------- 风格分组
# 判断顺序就是优先级：先看跨境，再看 Smart Beta 策略，再看宽基，最后才轮到行业。
# 反过来会把「恒生科技」判成科技、「港股红利」判成红利，风格地图就失真了。
_STYLE = [
    ('港股海外', ('恒生', '港股', '纳斯达克', '标普', '道琼斯', '德国', '法国', '日经',
                  '东京', '东南亚', '沙特', '越南', '亚太', '中概', '海外', '全球',
                  '美国', '日本', '中韩', '中概互联')),
    ('商品', ('黄金', '白银', '豆粕', '原油', '能源化工', '商品', '上海金', '有色期货')),
    ('红利价值', ('红利', '低波', '股息', '价值', '质量', '基本面', '等权', '动量',
                  '成长', '多因子', '策略')),
    ('宽基', ('沪深300', '中证500', '中证1000', '中证2000', '上证50', '创业板',
              '科创50', '科创板50', '中证A500', '中证A50', '中证100', '深证100',
              '上证180', '中证800', '全指', '综指', 'MSCI', '大盘', '中小盘', 'A股')),
    ('科技成长', ('科技', '芯片', '半导体', '人工智能', '机器人', '软件', '通信', '电子',
                  '军工', '新能源', '光伏', '电池', '电网', '云计算', '游戏', '传媒',
                  '影视', '计算机', '信息', '数据', '智能', '高端装备', '工业母机')),
    ('医药', ('医', '药', '生物', '健康', '疫苗', 'CXO')),
    ('消费', ('消费', '食品', '饮料', '白酒', '家电', '旅游', '零售', '农业', '养殖',
              '畜牧', '纺织', '服装', '商贸', '教育', '美容')),
    ('金融地产', ('银行', '证券', '保险', '金融', '地产', '房地产', '非银')),
    ('周期资源', ('有色', '煤炭', '钢铁', '化工', '石油', '能源', '建材', '稀土', '矿',
                  '电力', '公用', '交运', '运输', '港口', '基建', '机械')),
]


def style_of(name: str, idx: str) -> str:
    """先看跟踪指数名，退化到 ETF 名称。指数名更准，ETF 名称常带基金公司前缀。"""
    for label, keys in _STYLE:
        for t in (idx, name):
            if t and any(k in str(t) for k in keys):
                return label
    return '其他行业'


# ----------------------------------------------------------------- 单指数指标
def metrics(cl: np.ndarray, hi: np.ndarray, lo: np.ndarray, amt: np.ndarray,
            scale: float = 1.0):
    """对一个指数的代表 ETF 序列算位置、路径效率、量能。

    序列末尾是「最后一个交易日」，位置以它为锚。返回 None 表示历史不足。
    """
    ok = np.isfinite(cl) & (cl > 0)
    idx = np.flatnonzero(ok)
    if len(idx) < 120:          # 上市不满半年，区间位置没有意义
        return None
    e = idx[-1]
    s = max(0, e - LOOKBACK + 1)

    h = hi[s:e + 1]
    l = lo[s:e + 1]
    h = h[np.isfinite(h)]
    l = l[np.isfinite(l) & (l > 0)]
    if not len(h) or not len(l):
        return None
    hh, ll = float(h.max()), float(l.min())
    c = float(cl[e])
    if not (hh > ll):
        return None
    pos = (c - ll) / (hh - ll) * 100.0

    # 昨天在同一个区间里的位置 → 和今天的差就是今天的位移
    ce = float(cl[idx[-2]]) if len(idx) > 1 else c
    pos_prev = (min(max(ce, ll), hh) - ll) / (hh - ll) * 100.0

    # 20 日路径效率：净涨幅 ÷ 路径长度，回答「是拉上去的还是震上去的」
    m = min(21, e + 1)
    seg = cl[e - m + 1:e + 1]
    r = seg[1:] / seg[:-1] - 1.0
    r = r[np.isfinite(r)]
    path = float(np.abs(r).sum()) if len(r) else 0.0
    r20 = c / float(cl[max(0, e - 20)]) - 1.0 if cl[max(0, e - 20)] > 0 else 0.0
    pe = float(np.clip(r20 / path, -1, 1)) if path > 1e-6 else 0.0

    r1 = c / ce - 1.0 if ce > 0 else 0.0
    d_hi = c / hh - 1.0 if hh > 0 else None

    # 量能：今日成交额 ÷ 前 20 日均额。分母不含今天，否则放量日会自己抬高分母。
    a = amt[max(0, e - 25):e + 1]
    a = a[np.isfinite(a) & (a > 0)]
    evr = evr_prev = None
    if len(a) >= 6:
        evr = float(a[-1] / a[-21:-1].mean())
        if len(a) >= 7:
            evr_prev = float(a[-2] / a[-22:-2].mean())

    return dict(pos=pos, posPrev=pos_prev, pe=pe, r20=r20, r1=r1, dHi=d_hi,
                # 高低点换算到原始价格尺度，前端拿实时价就能就地重算位置
                evr=evr, evrPrev=evr_prev, hh=hh * scale, ll=ll * scale,
                amt=float(a[-1]) if len(a) else 0.0, bars=int(len(idx)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default='../data/etf.db')
    ap.add_argument('--out', default='../dist')
    ap.add_argument('--min-amt', type=float, default=1e6,
                    help='20 日均额门槛（元），低于它不算「有流动性」')
    args = ap.parse_args()
    return run(args.db, args.out, args.min_amt)


def run(db: str, out: str, min_amt: float = 1e6):
    """给 compute.py 直接调用，省得 CI 里多一条命令。"""
    args = argparse.Namespace(db=db, out=out, min_amt=min_amt)

    t0 = time.time()
    wide, names, last = load(args.db)
    cl, hi, lo, amt = wide['close'], wide['high'], wide['low'], wide['amount']
    tags = index_tags(names)

    # 只在最后一天有成交的标的里选，避免用停牌 ETF 当代表
    last_row = cl.iloc[-1]
    alive = last_row[np.isfinite(last_row) & (last_row > 0)].index

    # 名称/指数名先筛一遍，再用波动率兜底：债券货币 ETF 的年化波动通常低于 3%，
    # 股票/商品在 15% 以上。名字千奇百怪（短融、日利、添益），波动不会说谎。
    tg0 = tags.reindex(alive)
    kind = pd.Series([classify(names.get(c, ''), tg0.get(c, '')) for c in alive],
                     index=alive)
    alive = alive[(kind == 'equity').to_numpy()]
    rr = cl[alive].pct_change(fill_method=None).tail(60)
    vol = rr.std() * np.sqrt(252) * 100
    alive = alive[(vol.fillna(0) >= 4.0).to_numpy()]

    amt20 = amt.iloc[-25:].tail(20).mean()
    tag = tags.reindex(alive)
    tag = pd.Series(np.where(tag.notna(), tag.astype(object),
                             pd.Series(alive, index=alive)), index=alive).astype(str)

    # 每个指数取 20 日均额最大的那只做代表
    order = pd.Series(amt20.reindex(alive).to_numpy(), index=alive)
    order = order.where(order >= args.min_amt)
    pick = {}
    for code in order.sort_values(ascending=False).index:
        g = tag[code]
        if g not in pick and np.isfinite(order[code]):
            pick[g] = code

    raw = wide['raw']
    rows = []
    for g, code in pick.items():
        ca = cl[code].to_numpy(dtype=float)
        cr = raw[code].to_numpy(dtype=float)
        okb = np.isfinite(ca) & (ca > 0) & np.isfinite(cr) & (cr > 0)
        scale = float(cr[okb][-1] / ca[okb][-1]) if okb.any() else 1.0
        m = metrics(ca, hi[code].to_numpy(dtype=float),
                    lo[code].to_numpy(dtype=float), amt[code].to_numpy(dtype=float),
                    scale=scale)
        if not m:
            continue
        nm = str(names.get(code, code))
        ix = g if g != code else ''
        m.update(code=code, name=nm, idx=ix, style=style_of(nm, ix))
        rows.append(m)

    if not rows:
        raise SystemExit('没有可用标的，检查 --min-amt 或数据范围')

    # ---------------------------------------------------------------- 事件抽取
    ev = {k: [] for k in ('hi', 'lo', 'up80', 'dn20', 'vol', 'dry', 'near')}
    for r in rows:
        p, q, e, ep = r['pos'], r['posPrev'], r['evr'], r['evrPrev']
        if p >= 99.5 and q < 99.5:
            ev['hi'].append(r)
        elif q < HI <= p:
            ev['up80'].append(r)
        if p <= 0.5 and q > 0.5:
            ev['lo'].append(r)
        elif q > LO >= p:
            ev['dn20'].append(r)
        if e is not None and e >= VOL_HOT and (ep is None or ep < 1.4):
            ev['vol'].append(r)
        if e is not None and e <= VOL_DRY and (ep or 0) >= 1:
            ev['dry'].append(r)
        # 贴到新高 1% 以内但还没突破：分水岭就在眼前，比「已突破」更可操作
        d = r['dHi']
        if d is not None and -0.012 < d < -0.001 and p < 99:
            ev['near'].append(r)

    def pack(lst, cap=None, key=None):
        items = lst if key is None else sorted(lst, key=key)
        if cap:
            items = items[:cap]
        return [[r['code'], r['name'], r['idx'], round(r['pos'], 1),
                 round(r['posPrev'], 1),
                 None if r['evr'] is None else round(r['evr'], 2),
                 round(r['r20'] * 100, 2), round(r['r1'] * 100, 2),
                 round(r['hh'], 3), round(r['ll'], 3),
                 round(r['amt'] / 1e8, 3)] for r in items]

    # ---------------------------------------------------------------- 市场宽度
    pos_arr = np.array([r['pos'] for r in rows])
    r1_arr = np.array([r['r1'] for r in rows])
    breadth = dict(
        n=len(rows),
        p80=int((pos_arr >= HI).sum()),
        p20=int((pos_arr <= LO).sum()),
        up=int((r1_arr > 0).sum()),
        dn=int((r1_arr < 0).sum()),
        flat=int((r1_arr == 0).sum()),
        amt=round(float(sum(r['amt'] for r in rows)) / 1e8, 1),
        medPos=round(float(np.median(pos_arr)), 1),
    )

    # 风格地图：每组的位置中位数、创新高数、今日中位涨幅、合计成交额。
    # 一行一个风格、按位置排序，比看 423 行明细更快看出今天钱在往哪儿走。
    by_style = {}
    for r in rows:
        by_style.setdefault(r['style'], []).append(r)
    style = []
    for k, g in by_style.items():
        p_ = np.array([x['pos'] for x in g])
        r_ = np.array([x['r1'] for x in g])
        style.append(dict(
            k=k, n=len(g),
            pos=round(float(np.median(p_)), 1),
            hi=sum(1 for x in g if x['pos'] >= 99.5),
            r1=round(float(np.median(r_)) * 100, 2),
            amt=round(float(sum(x['amt'] for x in g)) / 1e8, 1),
        ))
    style.sort(key=lambda d: -d['pos'])

    # 全量精简表：前端做「全市场扫描」用，只留排序和筛选需要的列。
    # 名称不重复放，页面从行情接口按代码取，省 8KB。
    allrows = [[r['code'], r['style'], round(r['pos'], 1),
                None if r['evr'] is None else round(r['evr'], 2),
                round(r['r20'] * 100, 2), round(r['amt'] / 1e8, 3)] for r in rows]

    out = dict(
        v=1,
        date=last,
        generated_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        n=len(rows),
        cols=COLS,
        ev={k: pack(v, cap=40, key=lambda r: (-r['pos'] if k != 'lo' else r['pos']))
            for k, v in ev.items()},
        top=dict(
            up=pack(sorted(rows, key=lambda r: -r['r20'])[:12]),
            down=pack(sorted(rows, key=lambda r: r['r20'])[:12]),
            amt=pack(sorted(rows, key=lambda r: -r['amt'])[:12]),
        ),
        breadth=breadth,
        style=style,
        acols=['code', 'style', 'pos', 'evr', 'r20', 'amt'],
        all=allrows,
    )

    o = Path(args.out)
    o.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    p = o / 'events.json'
    p.write_text(txt, encoding='utf-8')

    # 同时写一份到 hist/ 目录。发布流水线只整目录复制 dist/hist，
    # 单独复制 dist/events.json 需要改 workflow 文件，而当前 GitHub token
    # 没有 workflow scope，改不了。放在 hist 下跟着走，零配置就能发上去。
    h = o / 'hist'
    if h.exists():
        (h / 'events.json').write_text(txt, encoding='utf-8')

    print(f'指数 {len(rows)} 个 / 事件 ' +
          ' '.join(f'{k}:{len(v)}' for k, v in ev.items()) +
          f' / {p.stat().st_size/1024:.1f} KB / {time.time()-t0:.1f}s')
    print(f'宽度 {breadth}')


if __name__ == '__main__':
    main()