# 部署到免费云

覆盖境内上市全部 ETF（1717 只），含跨境 / 债券 / 货币 / 商品。
实时榜单 + 同指数去重 + 历史 K 线 + 自选跨设备，全部跑在免费额度内。

```
worker/
├── src/index.js        后端：多源竞速 + 透传 + 历史数据（R2 或 GitHub）+ KV 自选
├── src/page.js         前端：解析/分类/排序/去重/K 线面板 + 腾讯直连
├── src/idx_data.js     指数映射（由 pipeline/gen_idx_data.mjs 生成，勿手改）
├── dist/worker.js      单文件版（可直接粘贴部署）
├── deno/main.ts        Deno Deploy 入口
├── build.mjs           打包脚本
├── dev_server.mjs      本地调试（带 R2 / KV 的 mock）
└── wrangler.toml       可选绑定：R2（加速，需绑卡）、KV
```

---

## 一、数据源架构

| 用途 | 源 | 通道 | 频率 |
|---|---|---|---|
| 全市场 1717 只榜单 | 新浪 `etf_hq_fund` | Worker 代理（透传，不解码） | 60s / 非交易 300s |
| **自选盯盘** | **腾讯 `qt.gtimg.cn`** | **浏览器 `<script>` 直连** | **5s / 非交易 30s** |
| 溢价率 / IOPV | 东财 `push2delay` | Worker（东财可用时） | 跟随全市场 |
| 历史日线 + 指标 | GitHub `data` 分支（或 R2） | Worker 透传 → 浏览器解析 | 日更（Actions） |

### 为什么自选走浏览器直连腾讯

腾讯返回的是 `v_sh510300="1~名称~现价~..."` 这种 JS 赋值语句，且响应头带 `charset=GBK`。

- **Cloudflare Worker 里用不了**：Workers 的 `TextDecoder` 只支持 UTF-8，解 GBK 会抛异常
- **浏览器里完全可用**：`<script src>` 加载外部 JS 时，浏览器按响应头 charset 自动用 GBK 解码，中文完全正常（实测 `沪深300ETF华泰柏瑞` 无乱码）；而且 `<script>` 不受 CORS 限制

于是得到一条**零成本高频通道**：不经过 Worker、不消耗请求额度、不受 10ms CPU 限制，
5 秒刷一次也没有任何费用，腾讯 88 个字段全部可用。

> 溢价率需要 IOPV，只有东财提供。境外 IP 下东财大概率不通，溢价率列显示 `-`，不影响其他功能。

---

## 二、同指数去重（默认开）

### 2.1 为什么需要

1717 只 ETF 背后只有 476 个跟踪指数，同一个指数常常有一二十只 ETF 在同时交易：

| 跟踪指数 | ETF 只数 |
|---|---|
| 中证A500 | 40 |
| 沪深300 | 29 |
| 中证500 | 29 |
| 上证科创板综合 | 23 |
| 上证科创板50 | 20 |
| 中证全指证券公司 | 17 |
| 创业板指 | 17 |

它们跟踪同一个指数，日内涨跌幅几乎一样，差别只在跟踪误差、费率和盘口厚度。
榜单里连着排 40 行 A500，看着热闹，实际只有一个信息。按成交额留一只，**1717 → 515 只**。

> 这里只解决「不要重复看同一只指数」。同指数 ETF 之间的切换套利不在范围内——
> 那需要盘口逐笔、申赎清单和实时折溢价，不是一个盯盘表格能承担的。

### 2.2 怎么判定「同一指数」

不能靠名字匹配。`300ETF`、`沪深300ETF华泰柏瑞`、`300基金` 是同一只指数，
而 `沪深300价值`、`沪深300成长` 不是；`中证A500` 和 `中证A50` 差一个 0，完全无关。

映射取自天天基金基金档案页的 **「跟踪标的」** 字段，逐只抓取后归一化：

```bash
node pipeline/fetch_index_map.mjs    # 1717 只，约 75 秒；增量，已抓过的跳过
node pipeline/gen_idx_data.mjs       # → worker/src/idx_data.js（19KB）
```

归一化只做三件事：

1. 去掉括号注释：`创业板指数(价格)` → `创业板指数`
2. 剥末尾修饰：`指数` / `价格` / `全收益` / `人民币`（**注意顺序**，先剥"指数"再剥"价格"，
   否则 `上证科创板综合价格指数` 会被留下 `…综合价格`，同一指数拆成两组）
3. 查一张人工核对过的别名表：`上证科创板综合价格` → `上证科创板综合`

**只有官方指数全称确实相同的才合并。** 合并错了会把一只好标的从表里挤掉，
少合并只是多显示一行——代价不对等，所以这里一律保守。

### 2.3 交互

| 操作 | 效果 |
|---|---|
| 默认 | 每组只留成交额最大的，名称后显示 `×N`（该指数共 N 只），蓝色 = 本组代表 |
| 点 `×N` | 展开该指数全部成员，按成交额排序，再点一次返回 |
| 点「同指数去重」 | 关掉，显示全部 1717 只（状态存 localStorage） |
| 搜索时 | 自动不去重——搜 "300" 就是想看所有 300ETF，藏掉 28 只反而碍事 |

两个实现细节：

- **15% 滞后**：两只成交额接近时（5000 万 vs 5100 万），若每次刷新都按最大值选，
  60 秒一次就会来回跳，看着像在闪。现任只要还有最大值的 85% 就不换。
- **盘前用规模兜底**：9:15 前成交额全是 0，此时退到流通市值选代表标的。

单只的指数（229 个）不参与去重，也不进 `idx_data.js`，省体积。

### 2.4 映射过期怎么办

新 ETF 上市后映射会慢慢失效——新代码不在表里，就按"无跟踪标的"处理，不去重，不会出错。
Actions 每天跑一次覆盖度体检，低于 90% 会打 warning。真掉下去了，重跑上面两条命令
再部署一次即可，季度级别的维护频率。

---

## 三、历史 K 线

### 3.1 数据是怎么到浏览器手上的

```
GitHub Actions（每日 16:35）
  ├ 拉 1717 只全历史 → SQLite → 复权 → 56 指标 + 101 因子
  ├ dist/etf/{code}.parquet   全历史 × 165 字段，给回测用（993MB）
  └ dist/hist/{code}.bin      近 500 天 × 17 字段，给页面用（46MB）
        ↓ git push --force（孤儿单提交，仓库不膨胀）
      GitHub data 分支
        ↓ Worker 原样透传（不解压、不解析）
      浏览器 DataView → Float32Array → canvas
```

**为什么单独导一份 `.bin`**：单只 Parquet 是 2.27MB / 165 列，光 zstd 解压就要几百毫秒，
而 Workers 免费版只有 10ms CPU。硬解必然 1102 超时。所以换成定长二进制，
Worker 只做一次 `bucket.get()` + 流式返回，解析全部交给浏览器。

### 3.2 文件格式

无压缩、小端、定长。**压缩在这里是负收益**——46MB 走 Cloudflare 出站免费，
省下的带宽还不够多花一次解压的时间。

```
magic      4B    'ETH1'
hdr_len    4B    uint32，JSON header 字节数
header     nB    {"code","n","cols":[...17 个列名...],"start","end"}
dates      4B×n  int32，YYYYMMDD
列数据     4B×n×17  float32，按 cols 顺序逐列连续
```

列名写在 header 里而不是前端硬编码：以后加字段，旧文件不会静默错位。

| 字段 | 说明 |
|---|---|
| `open` `high` `low` `close` | 交易所原始成交价（不是复权价，要跟券商软件对得上） |
| `volume` `amount` | 成交量、成交额 |
| `adj_ratio` | `adj_factor / 最新日 adj_factor`，乘上去就是前复权价 |
| `ma20` `ma60` | 均线（已按前复权口径换算） |
| `rsi14` | 相对强弱 |
| `macd_dif` `macd_dea` | MACD |
| `boll_up` `boll_low` | 布林带上下轨 |
| `atr14` `hvol20` | 真实波幅、20 日历史波动率（**百分数**，14.55 表示 14.55%） |
| `vol_ratio5` | 5 日量比 |

单只约 36KB（500 天），全部 46MB。

### 3.3 交互

| 操作 | 效果 |
|---|---|
| 点任意一行（自选或榜单） | 弹出面板，默认 1 年 |
| 3M / 6M / 1Y / 全部 | 切换区间，最多 500 天 |
| 鼠标移动 | 十字光标 + 当日 OHLC / 涨跌 / 量额 / RSI |
| Esc 或点遮罩 | 关闭 |

区间概览里的「累计」有两个口径：**默认给复权收益**，括号里附原始价收益。
两者差异超过 0.5% 时会额外提示"本区间内有分红或份额折算"——
159922 就是典型，原始价算出来 −56%，复权后其实是 +10.9%。

### 3.4 两种数据源

`histSource()` 按优先级选源：绑了 R2 就用 R2，否则读 `HIST_BASE` 指向的 GitHub
`data` 分支，两者都没有就在面板提示"历史数据未启用"，其余功能完全不受影响。

R2 快，但开通要绑卡；GitHub 零配置零成本，回源慢一点（首次约 200ms，
之后走边缘缓存 6 小时）。`/api/status` 会告诉你当前用哪个源、数据截止哪天。

---

## 四、自选跨设备

存在 Workers KV 的一个 key 里，几 KB。

| 动作 | 行为 |
|---|---|
| 打开页面 | 先渲染 localStorage（不等网络），再拉云端覆盖 |
| 增删自选 | 本地立刻生效，800ms 防抖后推云端 |
| 换设备 | 拉云端列表，与本地不同则以云端为准 |
| 没绑 KV | 静默降级为纯 localStorage，表头不显示「云端」标记 |

**一个容易踩的坑**：GET 必须区分「从没写过」和「写了个空数组」。
只返回 `list:[]` 的话，你在 A 设备清空自选，B 设备打开会以为云端没数据、
用本地列表重新推上去，删掉的标的全复活。所以接口返回额外带一个 `exists` 字段：

```json
{"ok":true,"exists":true,"list":[]}    // 用户清空了 → 其他设备跟着清空
{"ok":true,"exists":false,"list":[]}   // 从没写过 → 用本地列表初始化
```

同理，云端有数据时**不做并集**——并集分不清"新增"和"别处已删"。

---

## 五、部署

分两步：先让页面跑起来，再开历史 K 线和自选同步。
第一步不需要任何存储，五分钟能完。

### 5.1 第一步：跑起来

**A. 网页粘贴（最快，不装任何东西）**

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → Hello World → Deploy
2. **Edit code** → 全选删除 → 粘贴 `dist/worker.js` 全部内容 → **Deploy**
3. 访问 `https://<名字>.<子域>.workers.dev`

变量和 KV 也能在控制台加（见 5.2 末尾），所以这条路能走完全部功能。

**B. 命令行（推荐，配置写进 wrangler.toml，改起来有记录）**

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler deploy
```

### 5.2 第二步：开历史 K 线和自选同步

**历史数据：默认不用 R2**

Worker 支持两种数据源，`histSource()` 决定优先级：

```js
function histSource(env) {
  if (env.BUCKET) return 'r2';        // 绑了 R2 就用 R2
  if (env.HIST_BASE) return 'gh';     // 否则读 GitHub 的 data 分支
  return null;                        // 都没有 → 历史面板标记未启用
}
```

默认走 GitHub：Actions 每天把 `dist/hist/` + `manifest.json` 推到仓库的 `data` 分支
（每次都是孤儿单提交 + `--force`，所以仓库体积稳定在 62MB，不会一天涨一份）。
Worker 只需一个变量指过去：

```toml
[vars]
HIST_BASE = "https://raw.githubusercontent.com/你的用户名/etf-board/data"
```

想改回 R2（更快，但要绑卡开通）：

```bash
npx wrangler r2 bucket create etf-data
```

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "etf-data"
```

绑了 R2 之后 `HIST_BASE` 自动失效，不用删。

**自选：KV（免费，不用绑卡）**

```bash
npx wrangler kv namespace create WATCH
```

命令会打印 `id = "xxxx"`，填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "WATCH"
id = "上一步打印的 id"
```

**重新部署**

```bash
npx wrangler deploy
```

**验证**

访问 `https://<你的域名>/api/status`：

```json
{"ok":true,
 "bindings":{"r2":false,"kv":true,"gh":true},
 "hist":{"source":"gh","last_trade_date":"2026-11-04","codes":1717,"format":"ETH1","cols":17}}
```

`hist` 为 null 说明两种源都没配；`hist.error` 说明配了但没数据，去跑一次 Actions。

> 用网页粘贴部署的话，变量在 **Settings → Variables and Secrets** 加，
> KV 在 **Settings → Bindings** 加，效果一样。

### 5.3 GitHub Actions：不需要任何 secret

只有一件事要开：仓库 **Settings → Actions → General → Workflow permissions**
选 **Read and write permissions**。

因为发布数据用的是 Actions 内置的 `GITHUB_TOKEN`，往自己的 `data` 分支 push，
workflow 里已经声明了 `permissions: contents: write`。

然后 Actions 页面点 **Run workflow** 手动跑一次，约 15 分钟。

跑完仓库会多一个 `data` 分支，里面是：

```
data/
├── hist/510300.bin     1717 个，每个约 36KB
└── manifest.json       字段清单 + 最新交易日
```

### 5.4 Deno Deploy（没有 10ms 限制，但没有历史面板）

```bash
cd worker
deno install -gArf jsr:@deno/deployctl
deployctl deploy deno/main.ts
```

或在 https://dash.deno.com 建 Playground，粘贴 `deno/main.ts` + `src/index.js`
+ `src/page.js` + `src/idx_data.js`。

> Deno 没有 R2 / KV 绑定（`env` 传的是 `{}`），所以历史面板和自选同步会自动降级关闭。
> 要这两样就用 Cloudflare。

### 5.5 本地预览（不部署）

```bash
cd worker
node build.mjs && node dev_server.mjs     # → http://127.0.0.1:8899
```

`dev_server.mjs` 会给 Worker 塞一套 mock：**R2 读本地 `../dist`，KV 存进程内存**。
所以历史面板和自选同步在本地都能完整走通，不用为了看一眼 K 线先部署。

---

## 六、免费平台横向对比（2026-11 核实）

| 平台 | 请求额度 | CPU 预算 | 单请求上限 | 会休眠 | GBK 解码 | 对象存储 |
|---|---|---|---|---|---|---|
| **Cloudflare Workers** | 10 万/天 | 10ms × 请求 | **10ms** ⚠️ | 否 | ❌ | ✅ R2（10GB，出站免费） |
| **Deno Deploy** | 100 万/月 | **15 CPU 小时/月** | 无硬限制 | 否 | ✅ | ❌ 需外部 |
| Vercel Hobby | 100 万调用/月 | 4 CPU 小时/月 | 60s 执行 | 冷启动 | ✅ | ❌ 需外部 |
| Netlify Free | 12.5 万调用/月 | — | 10s 执行 | 冷启动 | ✅ | ❌ |
| Fly.io | — | — | — | — | — | ❌ 2024 起无免费档 |
| HuggingFace Spaces | — | — | — | **会睡** | ✅ | ❌ 不适合盯盘 |

**本项目的实际 CPU 消耗**：冷拉全量约 190ms，60 秒一次 → 约 **2.3 CPU 小时/月**。

- Deno 的 15 小时 → 富余 6 倍，但拿不到 R2 / KV 绑定
- Workers 的 10ms/请求 → 单请求卡死，只能靠「缓存命中 2.2ms」绕
- 历史数据不占 Worker 的 CPU：62MB 的 bin 放 GitHub 或 R2，Worker 只做透传

**结论：选 Cloudflare Workers。历史数据默认放 GitHub（不绑卡），
想要更快再开 R2——只是存储位置不同，Worker 代码不用改。**

---

## 七、Workers 的 10ms 是怎么绕过去的

全量 1717 只的处理成本实测（Node 环境）：

| 步骤 | CPU |
|---|---|
| `JSON.parse` 0.6MB | 3.4ms |
| **分类 1717 次（字符串 includes）** | **10.3ms** |
| 排序 1717 条 | 1.2ms |
| 纯字符串拼接 20 页 | 0.7ms |

常规写法光分类就 10.3ms，**必然超限**。所以：

1. Worker 只把 20 页文本拼成一个 JSON 数组字符串**直接透传**（0.7ms，不解码）
2. `JSON.parse`、字段映射、分类、排序、筛选、K 线绘制 **全部在浏览器做**
3. 加 `caches.default` 边缘缓存，跨 isolate 共享，TTL 5 秒

实测：**缓存命中 2.2ms**（从 34.9ms 降下来）。

历史数据走同一条思路：Worker 只 `bucket.get()` 后把流原样返回，一个字节都不解析。
边缘缓存 6 小时——历史数据一天只变一次。

如果日志出现 `1102 Worker exceeded CPU time limit`，按顺序：

1. `src/index.js` 的 `TTL` 从 `5` → `10`
2. `SINA_PAGES` 从 `20` → `12`（覆盖约 1200 只）
3. 换 Deno Deploy（放弃历史面板），或升级 Workers Paid（$5/月，CPU 30s）

---

## 八、接口

| 路由 | 说明 | 缓存 |
|---|---|---|
| `GET /` | 前端页面 | ETag |
| `GET /api/all` | 全市场原始数据 `{src, n, raw:[]}` | 5s |
| `GET /api/quote?codes=` | 东财批量（可选，前端已改用腾讯直连） | 无 |
| `GET /api/probe` | 多源实测 | 无 |
| `GET /api/hist?code=` | 单只历史二进制 `ETH1` | 6h |
| `GET /api/watch` | 云端自选 `{ok, exists, list}` | 无 |
| `POST /api/watch` | 覆盖写，body `{"list":["510300",...]}` | — |
| `GET /api/status` | 部署自检：绑定状态 + 数据日期 | 无 |

`raw` 字段随 `src` 变：`sina` 用 `code/name/trade/settlement/changepercent/amount/turnoverratio/high/low/open`，
`eastmoney` 用 `f12/f14/f2/f18/f3/f6/f8/f15/f16/f17/f441(IOPV)`。
前端 `normalize()` 统一，你不用关心当前是哪个源。

---

## 九、调刷新频率

改 `src/page.js` 里的 `schedule()`：

```js
timerSlow = setInterval(loadFull, open ? 60000 : 300000);   // 全市场
timerFast = setInterval(loadTXQuotes, open ? 5000 : 30000); // 自选（浏览器直连）
```

自选走浏览器直连，**调多快都不花钱**，但别低于 3 秒——腾讯有风控。
全市场走 Worker 代理新浪，调太快会被新浪封，建议不低于 30 秒。

---

## 十、数据存在哪

| 数据 | 存在哪 | 活多久 | 跨设备 | 跨实例 |
|---|---|---|---|---|
| 实时行情 `L1` | Worker 进程内存 | 5 秒 | ❌ | ❌ |
| `/api/all` 响应 | Web Cache API | 5 秒 | ✅ | ✅ 同 region |
| **自选列表** | **Workers KV**（一个 key） | 永久 | ✅ | ✅ |
| **历史日线** | **GitHub `data` 分支**（1717 个 bin，62MB），或 R2 | 永久 | ✅ | ✅ |

自选在 KV 之外还有一份 localStorage 副本：先把本地那份画出来，再用云端覆盖。
网络慢的时候不至于盯着空白表格等。

### 存储成本

**默认方案（GitHub）**：`data` 分支放 1717 个 bin + manifest，共 62MB。
每次 Actions 都是新的孤儿提交 + force push，旧提交不可达，仓库体积稳定。
完整 Parquet（993MB）只留在 Actions 的临时目录里，不回传——回测要在本地重跑
`alpha/compute.py`，不依赖线上那份。

**可选方案（R2）**：免费额度 10GB 存储 / 100 万 Class A / 1000 万 Class B 每月 /
出站全免。开起来后 `HIST_BASE` 自动失效，优先读 R2。

为什么不把 1GB Parquet 也传上去：Parquet 是整文件格式，改一个字段就得重写整个文件，
每天全量重传是纯浪费。页面只需要 `hist/`，回测只需要本地跑一次。
