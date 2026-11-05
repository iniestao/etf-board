"""中证指数接口参数爆破：找出能返回真实数据的组合。"""
from __future__ import annotations

import itertools
import json
import ssl
import urllib.parse
import urllib.request

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

BASE = 'https://www.csindex.com.cn'
HDR = {'User-Agent': UA, 'Referer': BASE + '/', 'Accept': 'application/json, text/plain, */*'}


def get(path, params=None):
    url = BASE + path + ('?' + urllib.parse.urlencode(params) if params else '')
    req = urllib.request.Request(url, headers=HDR)
    try:
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            return r.status, r.read().decode('utf-8', 'ignore')
    except urllib.error.HTTPError as e:
        return e.code, ''
    except Exception as e:
        return 0, str(e)


def main():
    codes = ['000300', '000300.CSI', 'H000300', 'sh000300', '399006', '000905']
    dates = [('2026-10-01', '2026-11-05'), ('20261001', '20261031'),
             ('2026-10-31', '2026-11-05')]
    paths = [
        '/csindex-home/perf/index-perf',
        '/csindex-home/index/index-valuation',
        '/csindex-home/indexInfo/index-valuation',
        '/csindex-home/perf/index-valuation',
    ]
    extra_variants = [{}, {'flag': '1'}, {'period': 'DAY'}]

    print('=== A. index-perf 参数组合 ===')
    for code, (s, e), ex in itertools.product(codes[:3], dates[:1], extra_variants):
        p = dict(indexCode=code, startDate=s, endDate=e, **ex)
        st, body = get('/csindex-home/perf/index-perf', p)
        n = len(body)
        mark = 'DATA' if '"data":[' in body and len(body) > 150 else ''
        print(f'  {st:4d} {n:6d}B {mark:4s} {code:12s} {s} {ex}')
        if mark:
            print('       ', body[:300])

    print('\n=== B. 估值类路径 ===')
    for path, code in itertools.product(paths, codes[:2]):
        for p in [{'indexCode': code}, {'indexCode': code, 'date': '2026-10-31'}]:
            st, body = get(path, p)
            mark = 'DATA' if len(body) > 150 and '404' not in body and 'Not Found' not in body else ''
            print(f'  {st:4d} {len(body):6d}B {mark:4s} {path:42s} {p}')
            if mark:
                print('       ', body[:250])

    print('\n=== C. 其他可能的 RESTful 路径 ===')
    for path in ['/csindex-home/indexInfo/index-search',
                 '/csindex-home/indexInfo/index-basic-info',
                 '/csindex-home/index/weight/top10',
                 '/csindex-home/index/index-detail',
                 '/csindex-home/indexInfo/index-detail']:
        for code in ['000300']:
            for p in [{'indexCode': code}, {'indexCode': code, 'pageNum': 1, 'pageSize': 10}]:
                st, body = get(path, p)
                print(f'  {st:4d} {len(body):6d}B {path:42s} {list(p.keys())}  {body[:80]}')


if __name__ == '__main__':
    main()
