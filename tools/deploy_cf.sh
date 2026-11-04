#!/usr/bin/env bash
# 一条命令部署到 Cloudflare Workers
# ==================================
# 为什么不用 wrangler：wrangler login 要过 dash.cloudflare.com 的 OAuth，
# 而机房 IP 会被 Cloudflare 的 bot 防护 403 拦掉。api.cloudflare.com 不受影响，
# 所以这里直接调 REST API，只需要一个 API Token。
#
# 用法：
#   CF_TOKEN=你的token bash tools/deploy_cf.sh
#
# token 需要三个权限（My Profile → API Tokens → Create Token → Custom token）：
#   Account · Workers Scripts · Edit
#   Account · Workers KV Storage · Edit
#   Account · Account Settings · Read
#
# 脚本做的事：找 account → 建/复用 KV → 上传 Worker（带 HIST_BASE 和 KV 绑定）
#            → 打开 workers.dev 子域 → 打印访问地址

set -euo pipefail

: "${CF_TOKEN:?请设置 CF_TOKEN 环境变量}"
GITHUB_REPO="${GITHUB_REPO:-iniestao/etf-board}"
BRANCH="${BRANCH:-data}"
SCRIPT_NAME="${SCRIPT_NAME:-etf-board}"
WORKER_JS="$(cd "$(dirname "$0")/.." && pwd)/worker/dist/worker.js"

API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CF_TOKEN}" -H "Content-Type: application/json")

# 统一解析：Cloudflare 无论成败都返回 200 + success 字段
cf() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" "${API}${path}" "${AUTH[@]}" -d "$body"
  else
    curl -s -X "$method" "${API}${path}" "${AUTH[@]}"
  fi
}

py() { python3 -c "$1"; }

echo "[1/5] 校验 token"
V=$(curl -s "${API}/user/tokens/verify" -H "Authorization: Bearer ${CF_TOKEN}")
OK=$(echo "$V" | py "import sys,json;print(json.load(sys.stdin).get('success'))")
if [ "$OK" != "True" ]; then
  echo "  token 无效或权限不足："; echo "$V" | py "import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get('errors'),ensure_ascii=False))"
  exit 1
fi
echo "  OK"

echo "[2/5] 查账号"
AID=$(cf GET /accounts | py "
import sys,json
d=json.load(sys.stdin)
a=d.get('result') or []
if not a: print(''); raise SystemExit
print(a[0]['id'])
")
if [ -z "$AID" ]; then echo "  没有权限读账号，token 是否勾了 Account Settings:Read？"; exit 1; fi
SUB=$(cf GET "/accounts/${AID}/workers/subdomain" | py "import sys,json;print((json.load(sys.stdin).get('result') or {}).get('subdomain',''))")
echo "  account=${AID}  subdomain=${SUB}"

echo "[3/5] KV namespace"
TITLE="etf-board-WATCH"
KID=$(cf GET "/accounts/${AID}/storage/kv/namespaces?per_page=100" | py "
import sys,json
d=json.load(sys.stdin)
for n in (d.get('result') or []):
    if n.get('title')=='$TITLE': print(n['id']); break
")
if [ -z "$KID" ]; then
  KID=$(cf POST "/accounts/${AID}/storage/kv/namespaces" "{\"title\":\"${TITLE}\"}" | py "
import sys,json
d=json.load(sys.stdin)
r=d.get('result') or {}
print(r.get('id',''))
if not r.get('id'): print('  KV 创建失败:', d.get('errors'), file=sys.stderr)
")
  echo "  新建 ${KID}"
else
  echo "  复用 ${KID}"
fi
[ -z "$KID" ] && { echo "  KV 不可用，token 是否勾了 Workers KV Storage:Edit？"; exit 1; }

echo "[4/5] 上传 Worker"
META=$(python3 - "$GITHUB_REPO" "$BRANCH" "$KID" <<'PY'
import json, sys
repo, branch, kid = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "main_module": "worker.js",
    "compatibility_date": "2024-11-01",
    "bindings": [
        {"type": "plain_text", "name": "HIST_BASE",
         "text": f"https://raw.githubusercontent.com/{repo}/{branch}"},
        {"type": "kv_namespace", "name": "WATCH", "namespace_id": kid},
    ],
}))
PY
)
UP=$(curl -s -X PUT "${API}/accounts/${AID}/workers/scripts/${SCRIPT_NAME}" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -F "metadata=${META};type=application/json" \
  -F "worker.js=@${WORKER_JS};type=application/javascript+module")
echo "$UP" | py "
import sys,json
d=json.load(sys.stdin)
print('  上传', 'OK' if d.get('success') else '失败')
if not d.get('success'): print('  ', json.dumps(d.get('errors'),ensure_ascii=False))
"
echo "$UP" | py "import sys,json;raise SystemExit(0 if json.load(sys.stdin).get('success') else 1)"

echo "[5/5] 打开 workers.dev"
cf POST "/accounts/${AID}/workers/scripts/${SCRIPT_NAME}/subdomain" '{"enabled":true}' > /dev/null
URL="https://${SCRIPT_NAME}.${SUB}.workers.dev"
echo ""
echo "访问地址：${URL}"
echo "自检：    node tools/verify.mjs ${URL}"
echo ""
echo "提示：raw 数据刚推上去时 GitHub 有几分钟缓存，K 线可能晚一点才出来。"
