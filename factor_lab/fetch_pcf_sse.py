"""
上交所当日 PCF（只有当前截面）
=============================
上交所的接口没有日期参数，只能拿「今天」这一份——历史拿不到，这是和深交所
最大的差别（深市是静态文件按日期命名，可回溯到 2019）。

用途：补全当前截面的成分股权重，让横截面研究至少在当前时点覆盖沪深两市。

字段映射：
    INSTRUMENT_ID           证券代码
    INSTRUMENT_NAME         证券简称
    QUANTITY                数量
    UNDERLYION_SECURITY_ID  市场代码（102 深市 / 101 沪市，但代码首位更可靠）
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import sqlite3
import time
import urllib.request
from pathlib import Path

OUT = Path(__file__).parent
DB = OUT / 'pcf.db'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
URL = ('https://query.sse.com.cn/commonQuery.do?isPagination=false&FUNDID2={code}'
       '&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C')


def market_of(code: str) -> str:
    c = str(code)
    if c.startswith('6') or c.startswith('5'):
        return 'SH'
    if c.startswith(('0', '3', '1')):
        return 'SZ'
    if c.startswith(('4', '8')):
        return 'BJ'
    return 'SH'


def fetch(code: str, retries: int = 3) -> list | None:
    req = urllib.request.Request(URL.format(code=code), headers={
        'User-Agent': UA,
        'Referer': f'https://www.sse.com.cn/disclosure/fund/etflist/detail.shtml?fundid={code}',
        'Accept': '*/*',
    })
    for k in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read().decode('utf-8', 'ignore'))
            return j.get('result') or []
        except Exception:
            time.sleep(0.6 * (k + 1))
    return None


def main():
    con = sqlite3.connect(OUT / 'shares.db')
    codes = [c for (c,) in con.execute('SELECT DISTINCT code FROM shares').fetchall()
             if not c.startswith('15')]
    con.close()
    codes = sorted(codes)
    print(f'沪市代表 ETF {len(codes)} 只')

    db = sqlite3.connect(DB)
    db.executescript('''
    CREATE TABLE IF NOT EXISTS pcf_meta(
        code TEXT, date TEXT, idx_code TEXT, nav REAL, unit_nav REAL,
        min_unit INTEGER, cash REAL, n_hold INTEGER,
        PRIMARY KEY(code,date));
    CREATE TABLE IF NOT EXISTS pcf_hold(
        code TEXT, date TEXT, stock TEXT, name TEXT, qty INTEGER, market TEXT,
        PRIMARY KEY(code,date,stock));
    CREATE INDEX IF NOT EXISTS ix_hold_date ON pcf_hold(date);
    ''')
    today = time.strftime('%Y%m%d')
    done = {c for (c,) in db.execute('SELECT code FROM pcf_meta WHERE date=?', (today,))}
    todo = [c for c in codes if c not in done]
    print(f'今天已抓 {len(done)}，待抓 {len(todo)}')

    ok = fail = 0
    rows_meta, rows_hold = [], []
    def work(c):
        return c, fetch(c)

    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for i, (c, res) in enumerate(ex.map(work, todo), 1):
            if not res:
                fail += 1
                continue
            holds = []
            for x in res:
                sc = str(x.get('INSTRUMENT_ID') or '').strip()
                q = str(x.get('QUANTITY') or '0').replace(',', '').strip()
                if not sc or not q.isdigit() or int(q) <= 0:
                    continue
                holds.append((sc, (x.get('INSTRUMENT_NAME') or sc).strip(),
                              int(q), market_of(sc)))
            if not holds:
                fail += 1
                continue
            ok += 1
            rows_meta.append((c, today, '', None, None, None, None, len(holds)))
            rows_hold.extend((c, today, *h) for h in holds)
            if i % 40 == 0:
                db.executemany('INSERT OR REPLACE INTO pcf_meta VALUES (?,?,?,?,?,?,?,?)', rows_meta)
                db.executemany('INSERT OR REPLACE INTO pcf_hold VALUES (?,?,?,?,?,?)', rows_hold)
                db.commit()
                rows_meta.clear(); rows_hold.clear()
                print(f'  [{i}/{len(todo)}] ok={ok} fail={fail}', flush=True)

    db.executemany('INSERT OR REPLACE INTO pcf_meta VALUES (?,?,?,?,?,?,?,?)', rows_meta)
    db.executemany('INSERT OR REPLACE INTO pcf_hold VALUES (?,?,?,?,?,?)', rows_hold)
    db.commit()
    print(f'完成：成功 {ok}，失败 {fail}')
    n = db.execute('SELECT COUNT(*) FROM pcf_hold WHERE date=?', (today,)).fetchone()[0]
    print(f'今日截面成分 {n} 条')


if __name__ == '__main__':
    main()
