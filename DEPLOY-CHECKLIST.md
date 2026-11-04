# 部署清单：从零到线上

这份清单是一次性执行用的。全程约 40 分钟，其中 25 分钟是等 Actions 跑数据，实际动手约 15 分钟。

---

## 0. 先说清楚边界

Cloudflare 和 GitHub 的授权必须由你在浏览器里点"允许"。这是 OAuth 的设计——令牌只能发到发起请求的那台机器，我这边拿不到，也不该拿。

除了授权，其余已经做完并跑通了：

| 事项 | 状态 |
|---|---|
| 代码仓库（2 次提交，工作区干净） | 已就绪 |
| Worker 单文件构建产物（92KB） | 已构建，可重现 |
| 部署后自检脚本 `tools/verify.mjs` | 已对本地 mock 跑通，7/7 |
| 多源竞速的完整性缺陷 | **已修**（见文末附录 D） |

你需要做的是 6 步，其中 4 步是复制粘贴命令。

---

## 1. 准备（3 分钟）

### 1.1 解压代码

把 `etf-board-deploy.zip` 解压到任意目录，例如 `C:\Users\leitao3\WorkBuddy\etf_board`。

压缩包里**已经带 `.git`**，所以不需要 `git init`，也不需要重新提交——解压完就能直接推到你的仓库。

确认目录长这样：

```
etf_board/
├── .github/workflows/update-data.yml
├── .git/
├── worker/wrangler.toml
├── worker/dist/worker.js
└── tools/verify.mjs
```

### 1.2 检查 Node

```powershell
node -v
```

要 **v22.5 或更高**（拉数据用了 Node 内置的 `node:sqlite`）。低于这个版本去 https://nodejs.org 装 LTS，装完重开一个 PowerShell 窗口。

预期输出类似 `v22.13.1`。

> 为什么卡 22.5：`data/import_etf.mjs` 用的是 `node:sqlite`，22.5 之前没有这个模块。本地 Node 只是用来跑 wrangler 和自检脚本，Actions 里用的是 setup-node 装的 22.x，不受影响。

---

## 2. Cloudflare 侧（8 分钟）

### 2.1 登录

```powershell
cd C:\Users\leitao3\WorkBuddy\etf_board\worker
npx wrangler@latest login
```

浏览器会弹出授权页 → 选你的账号 → **Allow**。回到终端看到 `Successfully logged in`。

### 2.2 建 R2 桶（放历史数据）

```powershell
npx wrangler@latest r2 bucket create etf-data
```

> R2 首次使用要在控制台点一次开通，会要求绑卡验证身份但**不扣费**。免费额度 10GB 存储、出站流量全免，当前数据 1.04GB。

预期：

```
Creating bucket 'etf-data'...
✨ Success!
```

报 `bucket already exists` 说明你之前建过，直接用，不用删。

### 2.3 建 KV（放自选）

```powershell
npx wrangler@latest kv namespace create WATCH
```

预期输出里有一行 `id = "a1b2c3..."`，**把这串 id 复制出来**，下一步要用。

> 这条命令每执行一次就新建一个命名空间。重复执行会拿到不同的 id，别连点。

### 2.4 打开两个绑定

编辑 `worker\wrangler.toml`，把文件末尾两段注释去掉，并填上刚才的 id。改完应该是这样：

```toml
name = "etf-board"
main = "src/index.js"
compatibility_date = "2024-11-01"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "etf-data"

[[kv_namespaces]]
binding = "WATCH"
id = "把 2.3 复制的那串 id 填这里"
```

两个 `binding` 的名字**必须**是 `BUCKET` 和 `WATCH`，大小写一致——代码里是按这两个名字取的，写错了 Worker 会当成"没绑定"。

### 2.5 部署

确认当前目录是 `worker\`（有 wrangler.toml 的那个），然后：

```powershell
npx wrangler@latest deploy
```

预期末尾会打印一行域名：

```
Deployed etf-board triggers
  https://etf-board.你的子域.workers.dev
```

**把这个域名记下来**，后面反复用。

> 如果提示 `name already exists` 或覆盖了别的 Worker：改 wrangler.toml 第一行的 `name`，换一个没被占用的名字再 deploy。
>
> 如果报 `Could not resolve "src/index.js"`：你不在 `worker\` 目录里。

### 2.6 先验一次（此时历史数据还是空的）

```powershell
cd C:\Users\leitao3\WorkBuddy\etf_board
node tools\verify.mjs https://etf-board.你的子域.workers.dev
```

此时正确的结果是 **5 通过 1 提醒**：

```
  ✓ 首页 HTML                200   38ms  63.3KB
  ✓ /api/status            200   12ms  r2=true kv=true
  ! R2 历史数据                空
  ✓ /api/all 行情            200  240ms  1717 只  src=sina
  ! /api/hist 单只           JSON: NO_R2 ...
  ✓ /api/watch 自选          200    8ms  exists=false  云端 0 只
  ✓ ETag / 304             "lopnpo"…  → 304
```

**看到 `1717 只` 这一行就算成功了一半**——说明行情链路通了，页面现在就能盯盘。
`R2 历史数据 空` 是预期的，数据还没上传。

如果 `/api/all` 只有几百只：说明竞速又退化成"谁先到用谁"了，回来告诉我。

---

## 3. 生成 R2 的 S3 凭证（3 分钟）

Actions 上传数据走 S3 协议，需要一个专用令牌（不是你的登录密码）。

1. 打开 https://dash.cloudflare.com → 左侧 **R2**
2. 右上角 **Manage R2 API Tokens** → **Create API Token**
3. 权限选 **Object Read & Write**
4. 下方 *Specify bucket* 选 `etf-data`（限定范围，避免令牌能碰别的桶）
5. **Create API Token**

创建完的页面**只显示一次**，抄下三个值：

| 页面上叫 | 后面 Secret 里叫 |
|---|---|
| Access Key ID | `R2_ACCESS_KEY_ID` |
| Secret Access Key | `R2_SECRET_ACCESS_KEY` |
| （页面上的 endpoint 里的那串 32 位） | `R2_ACCOUNT_ID` |

Account ID 也可以从控制台右侧栏或 R2 概览页右下角直接复制，形式和 `a1b2c3d4e5f6...` 类似，32 位十六进制。

> 关掉页面就再也看不到 Secret 了。没抄到就删掉重建一个，不麻烦。
> **这三个值不要发给我，也不要提交进仓库。** 它们等价于这个桶的读写密码。

---

## 4. GitHub 侧（5 分钟）

### 4.1 建空仓库

https://github.com/new

- Repository name: `etf-board`
- 可见性选 **Public**（Actions 分钟数不限；Private 每月 2000 分钟也够，但首次全量会吃掉 25 分钟）
- **不要**勾 "Add a README file"、不要加 .gitignore、不要选 license

建完页面会显示一堆初始化命令，**不要照着做**，用下面的。

### 4.2 推代码

```powershell
cd C:\Users\leitao3\WorkBuddy\etf_board
git branch -M main
git remote add origin https://github.com/你的用户名/etf-board.git
git push -u origin main
```

第一次 push 会弹浏览器让你登录 GitHub（或者让你配 Personal Access Token，跟提示走）。

推完应该看到 30 个文件、2 次提交。

> 没装 Git 的话：在 GitHub 仓库页点 **Add file → Upload files**，把解压出来的文件全选拖进去。**唯一要注意的是 `.github` 目录**——浏览器拖拽有时会漏掉隐藏目录，上传后确认仓库根目录能看到 `.github/workflows/update-data.yml`，没有就手动 **Add file → Create new file**，文件名填 `.github/workflows/update-data.yml`，内容从本地文件复制。

### 4.3 配 4 个 Secret

仓库页 → **Settings** → 左侧 **Secrets and variables** → **Actions** → **New repository secret**，逐个加：

| Name | Secret |
|---|---|
| `R2_ACCESS_KEY_ID` | 第 3 步的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | 第 3 步的 Secret Access Key |
| `R2_ACCOUNT_ID` | 32 位账号 ID |
| `R2_BUCKET` | `etf-data` |

名字必须完全一致，大小写和下划线都对。workflow 里是这么读的：

```yaml
AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
R2_ENDPOINT: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
R2_BUCKET: ${{ secrets.R2_BUCKET }}
```

---

## 5. 首次全量（25 分钟，主要是等）

仓库页 → **Actions** → 左侧 **更新 ETF 数据** → 右侧 **Run workflow** → 绿色按钮。

会依次跑 7 个 step，正常耗时：

| Step | 耗时 | 在干什么 |
|---|---|---|
| 检出代码 / 准备 Node | 20 秒 | — |
| 拉取日线 | 8~10 分钟 | 1717 只 × 约 3500 天，走新浪 `klc_kl` 加密格式解码 |
| 数据完整性断言 | 1 秒 | 少于 1500 只就红掉，不覆盖线上 |
| 安装依赖 | 40 秒 | pandas / numpy / pyarrow |
| 计算 56 指标 + 101 因子 | 4~5 分钟 | 输出 1717 个 parquet + 1717 个 hist.bin |
| 输出体积检查 | 1 秒 | 校验 ETH1 格式标记和文件数 |
| 同步到 R2 | 5~8 分钟 | 约 1.04GB，1717+1717 个对象 |

**第一次跑到"同步到 R2"这一步以前，页面上的 K 线面板会一直提示没数据，这是正常的。**

跑完在 Actions 页面点进这次运行，底部 Summary 会显示：

```
### ETF 数据更新
- 时间：2026-11-04 08:52 UTC
- 产物：1.1G
- 状态：success
```

任何一步红了，看附录 A 对照。

---

## 6. 复验（1 分钟）

```powershell
node tools\verify.mjs https://etf-board.你的子域.workers.dev
```

这次应该 **7 通过 0 提醒**：

```
  ✓ R2 历史数据                2026-11-03  1717 只  ETH1  17 列
  ✓ /api/hist 单只           200  180ms  510300  500 行  36227 字节  20241014~20261103
```

打开网页，点表格任意一行，应该弹出近两年的 K 线 + MA20/MA60 + 成交量 + RSI14。

到这一步就全部通了。

---

## 7. 之后不用管了

- **每个交易日 16:35（北京时间）自动跑一次**，cron 在 `.github/workflows/update-data.yml` 第 9 行，UTC 08:35。
- 收盘 15:00 到 16:35 之间的一个半小时是留给数据源清洗的余量。
- GitHub 的定时任务会漂移，高峰期可能晚几十分钟——数据不是准点更新，别卡着点看。
- 想立刻更新一次：Actions 页面点 Run workflow，任何时候都能手动触发。

### 想改时间

```yaml
- cron: '35 8 * * 1-5'    # UTC。北京时间 = UTC + 8
```

改完 push，GitHub 会立刻用新配置。注意 cron 只认 UTC，别直接写 16:35。

### 想省 R2 的写入量

现在每天全量重传 993MB 的 parquet，但页面只用到 `hist/` 和 `manifest.json`。如果只关心盯盘页，把 workflow 里的 sync 改成：

```yaml
aws s3 sync dist/ "s3://$R2_BUCKET/" \
  --endpoint-url "$R2_ENDPOINT" \
  --no-progress \
  --exclude "etf/*" --exclude "*.parquet"
```

代价是 R2 上没有全历史 Parquet，只有 `hist/` 和 `snapshot.parquet`——在别的机器上做回测时才用得上。日常体积会从 1.04GB 降到 60MB 左右。

---

## 附录 A：报错对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `verify` 里 `/api/all` 只有几百只 | 竞速拿到了不完整快照 | 已在本版修复；若仍出现，看 R2/新浪是否同时限流 |
| `Could not resolve "src/index.js"` | 不在 `worker\` 目录 | `cd worker` 再 deploy |
| `/api/status` 里 `r2=false` | wrangler.toml 的 `[[r2_buckets]]` 还是注释 | 去掉注释，binding 名必须是 `BUCKET` |
| `/api/status` 里 `kv=false` | id 没填或填错 | 重跑 `kv namespace create`，或 `kv namespace list` 查 id |
| `/api/hist` 返回 `NOT_FOUND` | R2 里没有这个 key | Actions 是否成功跑完"同步到 R2" |
| Actions 在 `数据完整性断言` 红掉 | 上游大面积失败，只拉到不到 1500 只 | 等几小时重跑；这是保护机制，宁可红也不覆盖线上 |
| Actions 在 `同步到 R2` 报 403 | 令牌权限不够或 bucket 名不匹配 | 重建令牌，权限必须有 Object Read & Write |
| Actions 报 `InvalidAccessKeyId` | `R2_ACCOUNT_ID` 填成了令牌 ID | 要的是账号 ID（32 位），不是令牌标识 |
| 网页白屏、控制台报 `Cannot access 'HTML'` | 部署了未经 build 的 src | 用 `worker/dist/worker.js`，或重新 `node build.mjs` |
| K 线面板空白但接口 200 | 二进制解析失败 | 前端读 header 的 `cols` 动态映射列，不该发生；报我 |

## 附录 B：费用（2026-11 口径）

| 项目 | 用量 | 免费额度 | 实际 |
|---|---|---|---|
| Workers 请求 | 开一天约 3000 次 | 10 万/天 | 0 |
| Workers CPU | 单请求 < 10ms | 10ms/请求 | 0 |
| R2 存储 | 1.04 GB | 10 GB | 0 |
| R2 出站 | 每天约 200MB | 全免 | 0 |
| R2 Class A（写） | 每天 3434 次 PUT | 100 万/月 | 0 |
| Actions | public 仓库不限 | — | 0 |

全部 0 元。唯一门槛是 R2 开通时要求绑卡验身份，不扣费。

## 附录 C：三个常用维护动作

**指数映射过期**（新 ETF 上市后覆盖率下滑，Actions 覆盖率低于 90% 会打 warning）

```powershell
cd C:\Users\leitao3\WorkBuddy\etf_board
node pipeline\fetch_index_map.mjs      # 1717 只，约 75 秒，增量
node pipeline\gen_idx_data.mjs         # → worker/src/idx_data.js
cd worker
node build.mjs                         # 重新打包
npx wrangler@latest deploy
```

**改完前端代码后**（`worker/src/page.js`）

```powershell
cd worker
node build.mjs
npx wrangler@latest deploy
```

`node build.mjs` 会把 `src/index.js` + `src/page.js` + 指数映射打成单文件，忘了这步等于没改。

**本地预览**（不部署，带 R2/KV 的 mock）

```powershell
cd worker
node build.mjs
node dev_server.mjs        # → http://127.0.0.1:8899
```

`dev_server.mjs` 会把 R2 mock 指到 `../dist`，所以本地要有跑过 compute 的产物。

---

## 附录 D：这一版修了什么

部署前做自检时发现一个会在生产环境稳定复现的缺陷：

东财 `push2delay` 在机房/云 IP 下会被限流，18 页里只回来 6 页（600 条），但原来的竞速规则是"两个源谁先返回且超过 100 条就用谁"——600 条的残缺结果秒杀了新浪完整的 1717 条，页面直接少三分之二标的。

改成按完整性分级：

```js
// 先到者只有 >= 1500 条（完整快照）才直接采信
// 否则等两个源都回来，取条数多的那个
const early = await withTimeout(Promise.race([emP, snP]), EM_TIMEOUT);
if (early && rowsOf(early) >= GOOD_ROWS) body = early;
else body = pickBest(await withTimeout(Promise.all([emP, snP]), WAIT_TOTAL)) || early;
```

实测：修复前 `n=600 src=eastmoney`，修复后 `n=1717 src=sina`，首屏延迟无明显变化（正常情况仍是东财先到直接用）。
