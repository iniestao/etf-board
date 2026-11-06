"""
深交所历史 PCF 抓取
===================
这是今晚找到的最有价值的数据源。深交所的 PCF 是**按日期命名的静态文件**：

    https://reportdocs.static.szse.cn/files/text/etf/ETF{code}{YYYYMMDD}.txt

实测 2019-01 至今全部可回溯（HTTP 200，内容与日期真实对应）。每份文件含：

    目标指数代码            → 不用再靠名字猜跟踪指数
    基金份额净值            → **每日官方净值**，配收盘价就是折溢价率
    最小申购赎回单位资产净值  → 交叉验证
    现金差额
    完整成分股 + 股份数量    → 每日真实权重（不是季报的前十大）

为什么只抓月末
--------------
447 个代表 ETF × 1700 个交易日 = 76 万请求，不可能。因子研究用月度截面足够
（95 个月末），而且月度调仓本来就是这个研究的持有期量级。

沪市没有这个能力：上交所的 PCF 走 commonQuery 接口，只返回当前截面，
没有日期参数。沪市只能抓「今天」这一份，历史要用当前成分重放（有偏差，报告里说明）。
"""
from __future__ import annotations

import concurrent.futures as cf
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd

# 别写死 /workspace/etf_board：CI 里检出到 /home/runner/work/...，
# 写死之后 month_ends() 会在 Actions 上直接抛 FileNotFoundError
ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).parent
DB = OUT / 'pcf.db'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
BASE = 'https://reportdocs.static.szse.cn/files/text/etf/ETF{code}{day}.txt'

# ---------------------------------------------------------------- 解析
RE_CODE = re.compile(r'目标指数代码[：:]\s*([0-9A-Za-z]{4,10})')
RE_NAV = re.compile(r'基金份额净值[：:]\s*([\d.]+)')
RE_UNITNAV = re.compile(r'最小申购、赎回单位资产净值[：:]\s*([\d,.]+)')
RE_MINUNIT = re.compile(r'最小申购、赎回单位[：:]\s*([\d,]+)份')
RE_CASH = re.compile(r'现金差额[：:]\s*(-?[\d,.]+)')
# 原文明确写「2026-10-30日 信息内容」——这才是净值和持仓的真实日期。
# 文件日期是申赎日 T，本市场 ETF 是 T-1，跨境 ETF 是 T-2，不能靠猜。
RE_NAVDATE = re.compile(r'(\d{4})-(\d{2})-(\d{2})\s*日\s*信息内容')
RE_FTYPE = re.compile(r'基金类型[：:]\s*(\S+)')
# 一行：代码 简称 数量 现金替代标志 ...
# 代码 5 位是港股（00001 长和）、6 位是 A 股、纯字母是美股
RE_HOLD = re.compile(r'^[ \t]*(\d{5,6}|[A-Z]{1,6})[ \t]+(.+?)[ \t]+([\d,]+)[ \t]+(?:允许|必须|禁止)', re.M)


def _num(pat: re.Pattern, text: str, cast=float):
    """取第一个分组并转数字。缺字段返回 None，不抛异常。"""
    m = pat.search(text)
    if not m:
        return None
    try:
        return cast(m.group(1).replace(',', ''))
    except (ValueError, TypeError):
        return None


def parse(txt: str) -> dict | None:
    # 别只截前 3000 字符：PCF 每行前面有几十个空格做对齐，3000 字符只够十几行，
    # 而「基金份额净值」在第 17 行，正好被截掉。
    head = txt[:12000]
    m_code = RE_CODE.search(head)
    nav = _num(RE_NAV, head)
    if nav is None:
        return None
    holds = []
    for m in RE_HOLD.finditer(txt):
        c, name, q = m.group(1), m.group(2).strip(), int(m.group(3).replace(',', ''))
        if q <= 0 or c == '159900':          # 159900 是跨市场虚拟券
            continue
        # 用行尾的挂牌市场判沪深
        eol = txt.find('\n', m.start())
        line = txt[m.start(): eol if eol > 0 else len(txt)]
        mk = 'SH' if '上海市场' in line else ('SZ' if '深圳市场' in line else
                                              ('HK' if '香港市场' in line else 'OT'))
        holds.append((c, name, q, mk))
    m_nd = RE_NAVDATE.search(head)
    m_ft = RE_FTYPE.search(head)
    return dict(
        idx_code=m_code.group(1) if m_code else '',
        nav=nav,
        nav_date='%s-%s-%s' % m_nd.groups() if m_nd else None,
        fund_type=m_ft.group(1) if m_ft else None,
        unit_nav=_num(RE_UNITNAV, head),
        min_unit=_num(RE_MINUNIT, head, int),
        cash=_num(RE_CASH, head),
        holds=holds,
    )


def fetch(code: str, day: str, retries: int = 3) -> dict | None:
    url = BASE.format(code=code, day=day)
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://www.szse.cn/', 'Accept': '*/*'})
    for k in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read()
            if len(raw) < 500:
                return None
            return parse(raw.decode('gbk', 'ignore'))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(0.5 * (k + 1))
        except Exception:
            time.sleep(0.5 * (k + 1))
    return None


# ---------------------------------------------------------------- 标的与日期
def representatives() -> list[str]:
    """深市代表 ETF 的代码列表。

    优先读随仓库提交的 pcf_universe.txt：CI 里没有 shares.db（份额库是沙箱
    本地抓的），只能靠这份固定名单。文件不存在时回退到 shares.db，沙箱里的
    行为完全不变。

    注意返回的是**纯代码字符串**，不是 (code, idx) 元组——之前返回元组，
    组装任务时 `code, day = t` 把整个元组赋给了 code，拼出来的 URL 变成
    `ETF('159915', '创业板指')20261104.txt`，18145 个请求全部 404，
    但每个都「正常返回 None」，所以看起来像「深交所没有数据」。
    """
    f = OUT / 'pcf_universe.txt'
    if f.exists():
        return sorted(x.strip() for x in f.read_text().splitlines() if x.strip())
    con = sqlite3.connect(OUT / 'shares.db')
    rows = con.execute('SELECT DISTINCT code FROM shares').fetchall()
    con.close()
    return sorted(c for (c,) in rows if c.startswith('15'))


def month_ends() -> list[str]:
    con = sqlite3.connect(ROOT / 'data' / 'etf.db')
    d = pd.to_datetime(pd.read_sql('SELECT DISTINCT date FROM etf_daily ORDER BY date', con)['date'])
    con.close()
    df = pd.DataFrame({'d': d.values})
    df = df[df['d'] >= pd.Timestamp('2019-01-01')].copy()
    # 不要用 Series.groupby(list_of_Series)：index 对不齐会静默变成 0 组
    df['ym'] = df['d'].dt.to_period('M')
    return [x.strftime('%Y%m%d') for x in df.groupby('ym')['d'].last()]


def main():
    import argparse
    ap = argparse.ArgumentParser(description='抓深市 ETF 申购赎回清单')
    ap.add_argument('--date', help='只抓这一天（YYYYMMDD），给每日增量用；不传则按月末回溯')
    ap.add_argument('--db', help='数据库路径，默认 ./pcf.db')
    args = ap.parse_args()

    global DB
    if args.db:
        DB = Path(args.db)

    codes = representatives()
    days = [args.date] if args.date else month_ends()
    scope = f'当日 {args.date}' if args.date else f'月末 {len(days)} 期'
    print(f'深市代表 ETF {len(codes)} 只 × {scope} = {len(codes)*len(days)} 请求')

    con = sqlite3.connect(DB)
    con.executescript('''
    CREATE TABLE IF NOT EXISTS pcf_meta(
        code TEXT, date TEXT, idx_code TEXT, nav REAL, unit_nav REAL,
        min_unit INTEGER, cash REAL, n_hold INTEGER,
        PRIMARY KEY(code,date));
    CREATE TABLE IF NOT EXISTS pcf_hold(
        code TEXT, date TEXT, stock TEXT, name TEXT, qty INTEGER, market TEXT,
        PRIMARY KEY(code,date,stock));
    CREATE INDEX IF NOT EXISTS ix_hold_date ON pcf_hold(date);
    ''')
    con.commit()

    done = {(c, d) for c, d in con.execute(
        'SELECT code,date FROM pcf_meta WHERE nav_date IS NOT NULL')}
    tasks = [(c, d) for c in codes for d in days if (c, d) not in done]
    print(f'已完成 {len(done)}，待抓 {len(tasks)}')
    if not tasks:
        print('没有待抓任务')
        return

    t0 = time.time()
    ok = fail = 0
    batch_meta, batch_hold = [], []

    def work(t):
        code, day = t
        return code, day, fetch(code, day)

    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        for i, (code, day, r) in enumerate(ex.map(work, tasks), 1):
            if r is None:
                fail += 1
            else:
                ok += 1
                batch_meta.append((code, day, r['idx_code'], r['nav'], r['unit_nav'],
                                   r['min_unit'], r['cash'], len(r['holds']),
                                   r['nav_date'], r['fund_type']))
                batch_hold.extend((code, day, *h) for h in r['holds'])
            if i % 500 == 0:
                con.executemany('INSERT OR REPLACE INTO pcf_meta VALUES (?,?,?,?,?,?,?,?,?,?)', batch_meta)
                con.executemany('INSERT OR REPLACE INTO pcf_hold VALUES (?,?,?,?,?,?)', batch_hold)
                con.commit()
                batch_meta.clear(); batch_hold.clear()
                el = time.time() - t0
                print(f'  [{i}/{len(tasks)}] ok={ok} miss={fail} {el:.0f}s '
                      f'({i/el:.1f} req/s)', flush=True)
            # 快速失败：正常情况月末文件极少缺失，前 200 个若全 miss 一定是代码问题
            if i == 200 and ok == 0:
                con.rollback()
                raise SystemExit('前 200 个请求全部失败，先检查 URL 拼接，不要继续烧请求')

    con.executemany('INSERT OR REPLACE INTO pcf_meta VALUES (?,?,?,?,?,?,?,?,?,?)', batch_meta)
    con.executemany('INSERT OR REPLACE INTO pcf_hold VALUES (?,?,?,?,?,?)', batch_hold)
    con.commit()
    print(f'完成：成功 {ok}，缺失 {fail}，耗时 {time.time()-t0:.0f}s')

    n = con.execute('SELECT COUNT(*) FROM pcf_hold').fetchone()[0]
    m = con.execute('SELECT COUNT(*) FROM pcf_meta').fetchone()[0]
    print(f'入库：{m} 条清单，{n} 条持仓明细')


if __name__ == '__main__':
    main()
