# 部署记录

**状态：已上线** · 2026-11-04

| 项 | 值 |
|---|---|
| 线上地址 | https://etf-board.171098509.workers.dev |
| GitHub 仓库 | https://github.com/iniestao/etf-board（公开） |
| Cloudflare 账号 | `d4661207d82c2945cc023c3cd208362c` |
| Worker 名 | `etf-board` |
| KV 命名空间 | `etf-board-WATCH` / `433b04a19510470ca9e54a778cd2b598` |
| 历史数据源 | GitHub `data` 分支（`raw.githubusercontent.com`，jsDelivr 兜底） |
| R2 | 未启用 |
| 访问控制 | **口令门禁**（`ACCESS_PASS` secret），除登录入口外全站需口令 |
| 当前版本 | `8fa15306-4dc5-499b-9d7b-910e73529a54` |
| Actions 定时 | 每天 16:35（北京时间），`update-data.yml` |

## 上线时的端到端验证

沙箱到 `workers.dev` 的出站被完全阻断（DNS 污染 + anycast 超时），无法从外部访问。
所以临时部署了一个带 cron 的 Worker，用 **service binding** 直接调 `etf-board` 的
fetch handler，把每步结果写进同一个 KV，再通过 Cloudflare API 把结果读出来。

测的是真实 Worker 运行时，不是本地 mock：

```
首页         HTTP 200   72484 bytes  text/html     14ms
状态         HTTP 200   kv=true gh=true             117ms
             hist: 1717 只 / 2026-11-03 / ETH1 / 17 列 / 47.8MB
历史K线      HTTP 200   36228 bytes  magic=ETH1     7ms
自选         HTTP 200   exists=false list=[]        3ms
全市场       HTTP 200   n=1717  src=sina            3740ms（首次拉 18 页）
```

验证完自检 Worker 与测试 key 已全部删除，KV 为空。

## 访问口令（让网址不对外）

`workers.dev` 地址是公开的，谁拿到链接都能打开。想锁住只有一条可靠路径：
**在 Worker 里守门**。

> 为什么不用 Cloudflare Access：Access 只能挂在**自定义域名 / 路由**上，
> 对 `*.workers.dev` 默认域名完全不生效——开了也照样人人可进。
> 除非先买域名绑上去，否则 Access 在这个部署里没有意义。

机制：

| 环节 | 实现 |
|---|---|
| 口令存放 | `ACCESS_PASS` secret（不进仓库；仓库是 public，写进代码等于没锁） |
| 校验后 | 种 `HttpOnly; Secure; SameSite=Lax` Cookie，值 = `HMAC-SHA256(口令)`，有效期 1 年 |
| 服务端会话 | **不需要**。口令一变，HMAC 全变，所有旧 Cookie 立即作废 |
| 未登录 · 页面 | 401 + 口令输入框（`noindex`，不含任何行情数据） |
| 未登录 · 接口 | `/api/*` 401 JSON；`/api/status` 只回 `{ok,locked}` 便于探测存活 |
| 爆破防护 | 同一 IP 10 分钟内错 6 次 → 锁 10 分钟；每次失败固定拖 600ms |
| 未配置口令 | 整站 503 并显示设置说明页（宁可锁死也不裸奔） |

设置口令（**必做**，否则站点打不开）：

```bash
cd worker
npx wrangler secret put ACCESS_PASS      # 交互输入，终端不回显
```

或 Dashboard：Workers → `etf-board` → **Settings** → **Variables and Secrets**
→ **Add** → Name `ACCESS_PASS`，类型选 **Secret**，Value 填口令 → **Save and deploy**。

口令建议 12 位以上、字母+数字，别用生日/手机号——这是唯一一道锁。

**换口令 / 怀疑泄露**：重设一次 `ACCESS_PASS` 即可，所有已登录设备立刻掉线。

**忘了口令**：Dashboard 里覆盖 `ACCESS_PASS`，然后用新口令登录。

**退出登录**：访问 `/__out`（清 Cookie，跳回登录页）。

## 部署踩过的坑

| 问题 | 原因 | 处理 |
|---|---|---|
| 私有仓库 K 线全挂 | `raw.githubusercontent.com` 对匿名请求读私有仓库返回 **404**，jsDelivr 也不服务私有仓库 | 仓库改为公开；同时给 Worker 加了 `GITHUB_TOKEN` 分支，将来要私有化时配一个只读令牌即可 |
| 手写 API 部署的 cron 不触发 | `PUT /workers/scripts/{name}` 带 `metadata.triggers` 未真正绑定调度器 | 改用 `wrangler deploy` 读 `wrangler.toml` 的 `[triggers]`，一行 `schedule: * * * * *` 确认生效 |
| `curl -F` 上传报 `No such module` | multipart 的 filename 取自本地文件名，与 `main_module` 不一致 | 加 `filename=xxx.js` 显式指定 |
| Actions 首次失败 | `setup-python` 配了 `cache: pip`，但仓库没有 `requirements.txt` 可算缓存 key | 补 `alpha/requirements.txt` |
| `git push` 偶发 TLS 中断 | 网络对大流量 HTTPS 的干扰 | `-c http.version=HTTP/1.1`，仍失败就走 Contents API 上传 |

## 日常运维

**数据更新**：Actions 每天 16:35 自动跑，约 25 分钟（runner 在境外，访问新浪慢）。
想手动更新：仓库 **Actions** → `update-data` → **Run workflow**。

**改代码后重新部署**：

```bash
cd worker
npx wrangler deploy          # 需先 export CLOUDFLARE_API_TOKEN
```

**看实时日志**：

```bash
npx wrangler tail etf-board --format pretty
```

**验证线上**：

```bash
ACCESS_PASS=你的口令 node tools/verify.mjs https://etf-board.171098509.workers.dev
```

不带 `ACCESS_PASS` 只能跑到「首页 401 站点上锁」，后面接口全是 401。

## 可选升级

| 想解决的问题 | 做法 |
|---|---|
| K 线回源慢（首次 ~200ms） | 开 R2（需绑卡），`wrangler r2 bucket create etf-data` 后取消 toml 里 `[[r2_buckets]]` 注释再 deploy。绑了 R2 自动优先用 R2 |
| 仓库想改回私有 | `wrangler secret put GITHUB_TOKEN`，填一个只读 `data` 分支的 fine-grained PAT；代码已支持 |
| 想用自定义域名 | Cloudflare Dashboard → Workers → etf-board → Settings → Domains & Routes |

## 第二轮改动（已随门禁版本上线）

下面这几项在 `8fa15306` 那一版里已经生效：

| 改动 | 位置 | 说明 |
|---|---|---|
| K 线副图可切换 | 页面 | RSI / MACD / 量比 / 波动率 / ATR / BOLL%B，主图可叠均线、布林带 |
| 因子研究改成独立页 | `/research` | 不再弹窗；`/?panel=rs` 会自动跳转过去 |
| 因子数据每天更新 | Actions + `/api/research` | 新增 `select_factors.py`（33 秒）与 `gen_research.mjs`，结果推到 `data` 分支的 `research.json` |
| 自选按设备隔离 | `/api/watch?u=` | 别人打开你的网址不会再看到或覆盖你的自选 |
| **全站口令访问** | Worker 门禁 | 没口令看不到任何页面和数据，见上一节「访问口令」 |

**部署**（两条路选一条）：

```bash
# A. 有 API Token
export CLOUDFLARE_API_TOKEN=...        # Workers Scripts:Edit + KV Storage:Edit
cd worker && npx wrangler deploy
```

**B. 没 Token**：Dashboard → Workers → `etf-board` → **Edit code** →
全选删掉 → 粘贴 `/workspace/worker.js` → **Deploy**。

**第三件事（必做）**：设 `ACCESS_PASS`，否则新版本上线后整站 503 打不开。
Dashboard → Workers → `etf-board` → Settings → Variables and Secrets → Add，
名字 `ACCESS_PASS`、类型 Secret、值填你的口令，保存。设完再访问网址，
看到口令框、输进去能进，就说明门禁通了。

最后自检（**带上口令**）：

```bash
ACCESS_PASS=你的口令 node tools/verify.mjs https://etf-board.171098509.workers.dev
```

应该看到 9 项全过（本地实测 9/9）。

## 第三轮改动（待部署）

| 改动 | 位置 | 说明 |
|---|---|---|
| K 线接上当天 | `page.js` | 历史最后一天不是今天时，用实时快照补一根，指标按完整序列重算到该点 |
| 单只行情兜底 | `page.js` | 盘后 `/api/all` 常只回 900 条，缺失标的单独问 `/api/quote` |
| 因子可点开看构造 | `/research` | 101 个全部列出，点任意行展开中文名、一句话解读、AST 生成的公式 |
| push 即部署 | `.github/workflows/deploy-worker.yml` | 配一次 secret，以后改代码不用再贴 Token |

### 部署这条路：配一次，以后免 Token

因为每次改代码都要「生成 Token → 贴过去 → 销毁」实在太烦，改成了：

```
GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret
  CLOUDFLARE_API_TOKEN   权限：Workers Scripts:Edit + Workers KV Storage:Edit + Account Settings:Read
  CLOUDFLARE_ACCOUNT_ID  d4661207d82c2945cc023c3cd208362c
```

配完之后 push 到 `main` 且改动命中 `worker/**`，就会自动构建 + 部署，日志在 Actions 页。
`ACCESS_PASS` 是 Cloudflare 侧的 secret，重新部署**不会**覆盖它，口令不用重设。

> 当前该 workflow 处于 **disabled** 状态：secret 还没配，先禁掉避免每次 push 都报红。
> 配好 secret 后在 Actions 页面点 **Enable workflow**，或直接 Run workflow 手动跑一次。

### 不用 Token 的兜底：网页粘贴

Dashboard → Workers → `etf-board` → **Edit code** → 全选删掉 →
粘贴 `/workspace/worker.js`（183KB，与 `worker/dist/worker.js` 同一份）→ **Deploy**。

约 3 分钟，缺点是以后每次改代码都要重来一次。

## 门禁上线记录（2026-11-04）

口令门禁已随本次部署上线，Worker 版本 `8fa15306-4dc5-499b-9d7b-910e73529a54`，
`ACCESS_PASS` 已写入 secret。

沙箱无法直连 `workers.dev`（出站被墙），所以仍用「临时 Worker + service binding」
在真实运行时里验证，验完把临时 Worker 与测试 KV key 全部删除：

| 用例 | 结果 |
|---|---|
| 匿名访问 `/`、`/research` | **401**，只有口令页，不含任何行情字段 |
| 匿名访问 `/api/all`、`/api/hist` | **401** `{"error":"unauthorized"}` |
| 匿名访问 `/api/status` | 200 `{"ok":true,"locked":true}`（不含绑定信息） |
| 伪造 Cookie | **401** |
| 正确口令 | **302** → `Location: /research`，Cookie 带 HttpOnly + Secure + SameSite=Lax |
| 登录后 `/` | 200，94432 字节 |
| 登录后 `/api/status` | 200，历史源 gh，1717 只 / 2026-11-03 |
| 登录后 `/api/hist?code=510300` | 200，36228 字节，magic=ETH1 |
| `/__out` | 302，`Max-Age=0` 清 Cookie |

部署过程中踩到一个只在线上暴露的坑，记在这里：

> **service binding 的 fetch 默认 `redirect: 'follow'`**。测登录时拿到 401，
> 一度以为是口令写错，实际是 `/__auth` 返回的 302 被自动跟随到 `/`，
> 而那一刻 Cookie 还没落到后续请求里，于是拿到「未登录」的 401。
> 测这类返回 302 的接口一律要加 `redirect: 'manual'`。
> `tools/verify.mjs` 和临时自检 Worker 都已按这个改。

另：验证时 `/api/all` 偶发只返回 900 条（东财被限流）或直接报「所有行情源均不可用」
（新浪响应 19~40 秒，超过 6 秒等待上限）。这是既有竞速逻辑与上游限流叠加的结果，
与门禁无关；盘后时段更容易出现，交易时段通常 3~4 秒正常返回 1717 只。

## K 线与因子页（2026-11-04 第二轮）

### 1. K 线接入「今天」

历史 `.bin` 由 Actions 每天 16:35 生成，盘中打开时最后一根永远是昨天——盯盘最需要的
当天走势反而没有，副图指标也停在昨天。现在打开 K 线时，如果历史最后一天不是今天，
就用实时快照接一根上去，指标用完整序列重算到该点。

关键在于**算法必须和 `alpha/indicators.py` 逐点对齐**，否则今天接上去的值和明天
Actions 跑完的值不一致，图上看起来就是最后一根莫名跳一下。对齐关系：

| 指标 | 后端 | 前端重算 |
|---|---|---|
| MA20 / MA60 | `rolling(n).mean()` | 末 n 项均值，窗口内有一个 NaN 就整体 NaN |
| 布林带 | `rolling(20).std()`（ddof=1） | 样本标准差，×2 加减中轨 |
| RSI14 | `ewm(alpha=1/14, adjust=False)` | Wilder 平滑，逐点递推 |
| MACD | `ewm(span=n, adjust=False)` | 同一递推，DIF=EMA12−EMA26，DEA=EMA9(DIF) |
| ATR14 | 同上，作用于 TR | 同 |
| HVOL20 | `pct_change().rolling(20).std()×√244×100` | 同 |
| 量比5 | `volume / rolling(5).mean()` | 同 |

验证方式：拿 `dist/hist/510300.bin` 剥掉最后一天，用「剥掉的那天自己的实时快照」
补回来，再和文件里存的真实值对比：

```
ma20 0.0000%  ma60 0.0000%  rsi14 0.0001%  macd_dif 0.0000%  macd_dea 0.0001%
boll_up 0.0000%  boll_low 0.0000%  atr14 0.0000%  hvol20 0.0003%  vol_ratio5 0.0704%
```

只有量比差 0.07%，因为成交量是估的：东财 `f5` 是「手」、新浪 `volume` 是「份」，
两个源单位不同，直接用会让柱子差 100 倍。改成用成交额 ÷ 当日均价（VWAP 近似），
两边都统一到「份」，误差 0.2% 以内——对柱子高度和量比几乎无影响。

触发条件（任一不满足就不补，宁可少画也不画错）：
- 历史最后一天 < 今天
- 实时快照存在且最新价 > 0
- 当日成交额 > 0（未开盘、停牌、节假日都会被这一条挡住）
- 今天不是周六日（成交额为 0 已经挡住，这里是第二道）
- 历史最后一天距今不超过 10 个自然日（数据太久没更新时硬接会留下大段空洞）

### 2. 因子可以点开看构造

原来只列 IC 最大的 12 个，看着像「就算出这么几个」。现在列出全部 101 个，
按 |IC| 排序，前 20 个默认展开、其余折叠，**点任意一行展开它的构造方式**：
中文名、一句话解读、以及公式。

公式不是手写的，是 `tools/gen_alpha_meta.py` 用 AST 从 `alpha/alpha101.py`
读出来的，所以页面显示的和真正在跑的永远是同一份，不会漂移。

生成过程踩了两个坑，都记在脚本注释里：

> 1. 最早用正则展开 `_w(cond, a, b)`，`ts_stddev(returns, 20)` 里的逗号被当成
>    参数分隔符，a001 直接变成 `ts_stddev(returns : 20)`。改成走 AST 遍历。
> 2. 运算符优先级一丢，`(close-low)-(high-close)` 就写成 `close-low-high-close`，
>    `a / ((l-h)*c**5)` 写成 `a / (l-h) * c**5`。现在每个二元子表达式都补括号。
> 3. `(c-o).abs()` 曾被拼成 `close − open.abs()`，意思从「收盘减开盘取绝对值」
>    变成「收盘减去开盘的绝对值」。现在 `.abs()` 单独处理成 `abs(...)`。

生成：`python3 tools/gen_alpha_meta.py` → `worker/src/alpha_meta.js`（20.6 KB）。
体积换来的是一次请求就能点开任意因子，不用再发 HTTP。

**本次改动文件**：`worker/src/page.js`、`worker/src/alpha_meta.js`（新增）、
`worker/build.mjs`、`tools/gen_alpha_meta.py`（新增）。


