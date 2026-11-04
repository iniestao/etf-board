# 部署清单（不绑卡版）

全程约 35 分钟，其中 15 分钟是等 Actions 跑数据。**不需要信用卡，不需要任何 Secret。**

---

## 0. 这一版改了什么

上一版用 Cloudflare R2 存历史 K 线，而 R2 开通要绑卡验身份。这一版换成 **GitHub 仓库的 `data` 分支**：

```
GitHub Actions（每天 16:35）
   拉 1717 只日线 → 复权 → 算 56 指标 → 导出 1717 个 .bin（62MB）
        ↓ git push --force 到 data 分支（每次单提交，仓库不会膨胀）
Cloudflare Worker 读 raw.githubusercontent.com/…/data/hist/510300.bin
        ↓ 边缘缓存 6 小时
浏览器 DataView 直接解析
```

| | 上一版（R2） | 这一版（GitHub） |
|---|---|---|
| 绑卡 | 需要 | **不需要** |
| 要配 Secret | 4 个 | **0 个** |
| 存储费 | 0（额度内） | 0 |
| 回源速度 | 快 | 稍慢，首次约 200ms，之后走边缘缓存 |
| 上限 | 10GB | 仓库建议 <1GB，当前 62MB |

R2 的代码路径保留了，以后想要更快随时能加，不用改代码。

---

## 1. 准备（3 分钟）

解压 `etf-board-deploy.zip` 到任意目录，例如 `C:\Users\leitao3\WorkBuddy\etf_board`。

压缩包**已带 `.git`**（3 次提交），解压后不用 `git init`，直接 `git remote add` 就能推。

有终端的话确认 Node：

```powershell
node -v      # 要 v22.5+
```

没有终端也能做完，走 2.2 的路线 B。

---

## 2. GitHub 侧（10 分钟）

### 2.1 建空仓库

https://github.com/new

- 名字：`etf-board`
- 可见性：**Public**（Actions 分钟数不限；Private 每月 2000 分钟也够这次用）
- 不要勾 README、不要加 .gitignore、不要选 license

### 2.2 推代码

**路线 A：有终端**

```powershell
cd C:\Users\leitao3\WorkBuddy\etf_board
git branch -M main
git remote add origin https://github.com/你的用户名/etf-board.git
git push -u origin main
```

推完是 32 个文件、3 次提交。

**路线 B：只有浏览器**

仓库页 → **Add file → Upload files** → 把解压出来的所有文件和文件夹拖进去 → Commit。

> 唯一要留意 `.github` 目录。拖拽后确认仓库根目录能看到 `.github/workflows/update-data.yml`。
> 看不到就手动建：**Add file → Create new file**，文件名直接输入
> `.github/workflows/update-data.yml`（斜杠会自动建目录），内容从本地同名文件复制。

### 2.3 开写权限（关键，否则 Actions 推 data 分支会 403）

仓库 → **Settings** → **Actions** → **General** → 拉到最下面 **Workflow permissions**

选 **Read and write permissions** → Save。

很多人漏这步，现象是 Actions 最后一步报 `remote: Permission to … denied`。

### 2.4 先跑一次

仓库 → **Actions** → 左侧 **更新 ETF 数据** → **Run workflow**。

约 15 分钟，6 个 step：

| Step | 耗时 | 干什么 |
|---|---|---|
| 拉取日线 | 8~10 分 | 1717 只 × 约 3500 天，解码新浪加密格式 |
| 数据完整性断言 | 1 秒 | 少于 1500 只直接红掉，不污染线上 |
| 计算指标 | 4~5 分 | 56 指标 + 101 因子 |
| 输出体积检查 | 1 秒 | 校验 ETH1 格式与文件数 |
| **发布到 data 分支** | 1~2 分 | 62MB，孤儿单提交 + force push |

跑完在仓库分支下拉框里能看到 `data`，里面是 `hist/` 和 `manifest.json`。

> 这步不依赖 Cloudflare，可以边跑边去部署 Worker。

---

## 3. Cloudflare 侧（8 分钟）

### 3.1 建 Worker

**路线 A：命令行（推荐，一次到位）**

```powershell
cd C:\Users\leitao3\WorkBuddy\etf_board\worker
npx wrangler@latest login
```

浏览器弹出 → 选账号 → Allow。

编辑 `worker\wrangler.toml`，去掉这两行注释并换成你的用户名：

```toml
[vars]
HIST_BASE = "https://raw.githubusercontent.com/你的用户名/etf-board/data"
```

建 KV 并填 id：

```powershell
npx wrangler@latest kv namespace create WATCH
```

把打印出的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]`，去掉那三行注释。

```powershell
npx wrangler@latest deploy
```

会打印 `https://etf-board.你的子域.workers.dev`，**记下来**。

**路线 B：全网页，不装任何东西**

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Start with Hello World!** → **Deploy**
2. **Edit code** → 编辑器全选删除 → 粘贴 `worker/dist/worker.js` 的**全部内容**（80KB）→ 右上 **Deploy**
3. 回 Worker 页 → **Settings** → **Variables and Secrets** → **Add**
   - 类型 **Text**，名称 `HIST_BASE`
   - 值 `https://raw.githubusercontent.com/你的用户名/etf-board/data`
   - **Deploy** 保存
4. 同页 → **Bindings** → **Add** → **KV Namespace**
   - Variable name 填 `WATCH`（大小写必须一致）
   - 没有 namespace 就先去左侧 **Storage & Databases → KV** 建一个
5. 复制 `https://xxx.workers.dev` 域名

> 粘贴时别让编辑器自动格式化。全选删除后直接 Ctrl+V。若页面白屏，重新粘一次。

### 3.2 立刻验一次

```powershell
node tools\verify.mjs https://etf-board.你的子域.workers.dev
```

应该是 **6 通过 1 提醒**：

```
  ✓ /api/status            200   45ms  历史源=github  kv=true
  ✓ 历史数据                2026-11-04  1717 只  ETH1  17 列  (gh)
  ✓ /api/all 行情           200  380ms  1717 只  src=sina
  ✓ /api/hist 单只          200  210ms  510300  500 行  36227 字节
```

`历史数据` 显示「空」说明 Actions 还没跑完，等它结束再验。

**到这里就完事了。** 打开网页点任意一行，能弹出 K 线 + MA20/MA60 + 成交量 + RSI14。

---

## 4. 之后不用管

- 每个交易日 **16:35（北京时间）** 自动跑，cron 在 `.github/workflows/update-data.yml`（UTC 08:35）。
- 15:00 收盘到 16:35 之间留了一个半小时给数据源清洗。
- GitHub 定时任务会漂移，高峰可能晚几十分钟，别卡点看。
- 想立刻更新：Actions 页点 **Run workflow**。

改时间只动这一行（UTC，北京时间 = UTC + 8）：

```yaml
- cron: '35 8 * * 1-5'
```

---

## 附录 A：报错对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| Actions 最后一步 403 / `Permission denied` | 仓库没开写权限 | 2.3 步：Settings → Actions → General → Read and write |
| `/api/status` 里 `gh=false` | `HIST_BASE` 没设或为空 | 查变量名拼写，值别少 `https://` |
| `历史数据` 显示「空」但 `gh=true` | data 分支还没生成 | 等 Actions 跑完，去分支列表确认有 `data` |
| `/api/hist` 返回 `NOT_FOUND` | data 分支里没这个文件 | 看「发布到 data 分支」是否成功 |
| 网页白屏，控制台 `Cannot access 'HTML'` | 部署了未打包的 `src/index.js` | 用 `worker/dist/worker.js`，或先 `node build.mjs` |
| `Could not resolve "src/index.js"` | 不在 `worker\` 目录 | `cd worker` 再 deploy |
| `/api/all` 只有几百只 | 竞速拿到残缺快照 | 当前版本已修；若复现说明两源同时限流，换时间再试 |
| KV 绑定后 `kv=false` | Variable name 不是 `WATCH` | 绑定名严格等于 `WATCH`，大小写敏感 |
| 「数据完整性断言」红掉 | 上游大面积失败，不足 1500 只 | 等几小时重跑；这是保护机制，宁可红也不覆盖线上 |

## 附录 B：费用

| 项目 | 用量 | 免费额度 | 实际 |
|---|---|---|---|
| Workers 请求 | 开一天约 3000 次 | 10 万/天 | 0 |
| Workers CPU | 单请求 < 10ms | 10ms/请求 | 0 |
| KV 读写 | 自选几 KB | 10 万读/天、1000 写/天 | 0 |
| GitHub 仓库 | 62MB | 建议 <1GB | 0 |
| GitHub Actions | 每天 15 分 | Public 不限 | 0 |

全部 0 元，全程不绑卡。

## 附录 C：改完代码怎么更新

```powershell
cd worker
node build.mjs              # 必须！把 src 打成单文件
npx wrangler@latest deploy
```

忘了 `node build.mjs` 等于没改——页面用的是 `dist/worker.js`。

本地预览（带历史数据 mock，不部署）：

```powershell
cd worker
node build.mjs
node dev_server.mjs         # → http://127.0.0.1:8899
```

## 附录 D：这一版改了什么

| 改动 | 原因 |
|---|---|
| 历史数据从 R2 换成 GitHub `data` 分支 | R2 开通要绑卡，GitHub 不用 |
| Actions 新增「发布到 data 分支」，孤儿提交 + force push | 每天 62MB，累积提交会让仓库涨到几十 GB |
| R2 步骤改为 `if: vars.USE_R2 == 'true'` 可选 | 保留加速路径，不绑卡就跳过 |
| 新浪单页失败重试一次 | 实测偶发少 100 只（1717→1617），1617 仍高于完整性阈值，会被当成完整快照静默上线 |
| 竞速规则改为「满 1500 条才算完整」 | 东财限流只回 600 条时会秒杀新浪的 1717 条，页面少三分之二标的 |
| `HIST_BASE` 统一两种源的读取 | 一条 `histSource()` 决定优先级，前端零改动 |
| raw 不通时自动切 jsDelivr 镜像 | 部分网络访问 raw.githubusercontent.com 会超时；3 秒没响应就换成同内容的 jsDelivr，代码里 5 行 |
| verify 区分「失败」和「提醒」 | 没绑 KV 只是自选不同步，不该算部署失败 |
