#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上交所 ETF 份额历史回补 → data/shares/sh_hist.json（与 sz_hist.json 同格式）。

数据源：上交所「ETF 规模」报表（COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L）
  http://query.sse.com.cn/commonQuery.do?sqlId=...&STAT_DATE=YYYY-MM-DD
  返回 SEC_CODE / SEC_NAME / TOT_VOL（万份），必须校验 STAT_DATE 回显等于请求日，
  该接口约 1/3 概率返回空结果，需重试。

用法：
  python3 tools/sse_hist.py                       # 用 data/shares/sz_hist.json 的日期轴
  python3 tools/sse_hist.py --days 250            # 只取最近 250 个交易日
  python3 tools/sse_hist.py --start 2026-11-01 --end 2026-11-10
  python3 tools/sse_hist.py --date 2026-11-10     # 只补一天（增量用）
"""
import argparse
import datetime as dt
import json
import os
import statistics
import sys
import threading
import time
import urllib.parse
import urllib.request

URL = ('http://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L'
       '&STAT_DATE={d}&pageHelp.pageSize=5000&pageHelp.pageNo=1')
HDRS = {
    'Referer': 'http://www.sse.com.cn/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': '*/*',
}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SZ = os.path.join(ROOT, 'data/shares/sz_hist.json')
OUT = os.path.join(ROOT, 'data/shares/sh_hist.json')


def fetch_day(day, retries=4):
    """返回 {code: 份额(份)}；彻底失败返回 None。"""
    for k in range(retries):
        try:
            req = urllib.request.Request(URL.format(d=day), headers=HDRS)
            raw = urllib.request.urlopen(req, timeout=25).read()
            d = json.loads(raw)
            res = d.get('result') or []
            # 日期不在顶层（顶层只有 pageHelp），在 result 每一行上。
            # 读 d['STAT_DATE'] 永远是 None，这道闸门等于没有：请求还没发布的日期时，
            # 上交所会把上一日的表原样返回，按请求日写进轴里就是「当天零申赎」。
            dts = {str(r.get('STAT_DATE') or '')[:10] for r in res} - {''}
            if dts and (len(dts) > 1 or day not in dts):
                return None
            if not res:
                time.sleep(1.5 + k)
                continue
            out = {}
            for r in res:
                code = str(r.get('SEC_CODE') or '').strip()
                vol = r.get('TOT_VOL')
                try:
                    v = float(vol)
                except (TypeError, ValueError):
                    continue
                if len(code) == 6 and v > 0:
                    out[code] = int(round(v * 1e4))  # 万份 → 份
            if out:
                return out
        except Exception as e:
            if k == retries - 1:
                print('  %s 失败: %s' % (day, e), file=sys.stderr)
            time.sleep(1.5 + k)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=0, help='只取最近 N 个交易日')
    ap.add_argument('--start')
    ap.add_argument('--end')
    ap.add_argument('--date', help='只抓这一天并合并进 sh_hist.json')
    ap.add_argument('--workers', type=int, default=3)
    a = ap.parse_args()

    base = json.load(open(SZ, encoding='utf-8')) if os.path.exists(SZ) else None
    dates = list(base['d']) if base else []
    if base:
        print('基准日期轴：%s ~ %s，共 %d 天（取自 %s）' % (dates[0], dates[-1], len(dates), base['src']))

    if a.date:
        dates = [a.date]
    else:
        if a.start:
            dates = [d for d in dates if d >= a.start] if dates else dates
        if a.end:
            dates = [d for d in dates if d <= a.end]
        if a.days:
            dates = dates[-a.days:]
    if not dates:
        sys.exit('没有可抓的日期：检查 --start/--end，或先跑 sz_hist.json 生成日期轴')

    # 已有数据（增量合并用）
    old = None
    if os.path.exists(OUT):
        old = json.load(open(OUT, encoding='utf-8'))
        print('已有 %s：%d 只 × %d 天' % (OUT, len(old.get('c') or {}), len(old.get('d') or [])))

    todo = [d for d in dates]
    got = {}
    lock = threading.Lock()
    t0 = time.time()

    def work(chunk):
        for d in chunk:
            m = fetch_day(d)
            with lock:
                got[d] = m
                n = len(m) if m else 0
                done = len(got)
            print('  [%3d/%3d] %s → %s 只  (%.0fs)'
                  % (done, len(todo), d, n if n else '失败/未发布', time.time() - t0), flush=True)

    w = max(1, min(a.workers, 6))
    chunks = [todo[i::w] for i in range(w)]
    ths = [threading.Thread(target=work, args=(c,)) for c in chunks]
    [t.start() for t in ths]
    [t.join() for t in ths]

    ok_days = sorted(d for d, m in got.items() if m)
    if not ok_days:
        sys.exit('全部失败：上交所接口不可达或被限流')

    # 合并日期轴 + 数据
    all_dates = sorted(set(dates) | set(old['d'] if old else []))
    codes = set()
    for m in got.values():
        if m:
            codes |= set(m)
    if old:
        codes |= set(old['c'])
    codes = sorted(codes)

    name = {}
    if old:
        name.update(old.get('n') or {})
    # 名称从最后一次成功抓取里补（接口带 SEC_NAME，但 fetch_day 只留了数字，这里用旧值兜底）

    data = {}
    for c in codes:
        arr = []
        for d in all_dates:
            if c in got.get(d, {}):
                arr.append(got[d][c])
            elif old and c in old['c'] and d in old['d']:
                arr.append(old['c'][c][old['d'].index(d)])
            else:
                arr.append(None)
        data[c] = arr

    out = {
        'v': 1, 'market': 'SH', 'unit': 'share',
        'src': '上海证券交易所 ETF 规模报表',
        'imported': dt.datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z'),
        'd': all_dates, 'n': name, 'c': data,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + '.tmp'
    # 每只一行（与 xlsx2shares.py 的 write_shares 同一格式，见那里的注释）：
    # 单行 JSON 会让每天的 commit 都是整 blob，每只一行才能让 git delta 只存增量。
    codes_sorted = list(data.keys())
    head = {k: v for k, v in out.items() if k not in ('n', 'c')}
    lines = [json.dumps(head, ensure_ascii=False, separators=(',', ':'))[:-1] + ',"n":{']
    for i, code in enumerate(codes_sorted):
        lines.append('"%s":%s%s' % (code, json.dumps(out['n'].get(code, ''), ensure_ascii=False),
                                    ',' if i < len(codes_sorted) - 1 else ''))
    lines.append('},"c":{')
    for i, code in enumerate(codes_sorted):
        lines.append('"%s":%s%s' % (code, json.dumps(data[code], separators=(',', ':')),
                                    ',' if i < len(codes_sorted) - 1 else ''))
    lines.append('}}')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    os.replace(tmp, OUT)

    cnt = [sum(1 for x in v if x is not None) for v in data.values()]
    print('\n已写 %s：%d 只 × %d 天（成功 %d 天，失败 %d 天），%.2f MB'
          % (OUT, len(data), len(all_dates), len(ok_days), len(todo) - len(ok_days),
             os.path.getsize(OUT) / 1048576))
    print('每只有效天数 min/中位/max = %d / %.0f / %d'
          % (min(cnt), statistics.median(cnt), max(cnt)))
    if len(ok_days) < len(todo):
        miss = [d for d in todo if not got.get(d)]
        print('未取到：%s%s' % (', '.join(miss[:12]), ' ...' if len(miss) > 12 else ''))


if __name__ == '__main__':
    main()
