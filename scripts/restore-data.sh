#!/usr/bin/env bash
# 从 GitHub Release 恢复本地数据（沙箱被换掉之后用这个）
#
#   ./scripts/restore-data.sh                 # 恢复最新 tag
#   ./scripts/restore-data.sh data-2026-11-06 # 指定版本
#
# 只下载 + 校验 + 解压，不碰代码。代码本身走 git clone / git pull。
set -euo pipefail

OWNER=iniestao
REPO=etf-board
TAG=${1:-data-2026-11-06}
BASE="https://github.com/$OWNER/$REPO/releases/download/$TAG"

# 仓库根目录（脚本在 scripts/ 下）
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEST="$ROOT/factor_lab"
mkdir -p "$DEST"

# 文件名:解压后落点:期望 SHA256（空表示跳过校验）
MANIFEST="
stocks.db.gz:$DEST/stocks.db:ccbfa8503b80d7b84dec55c40dcfa8014827486fe570ad7d9490684a18c52e71
pcf.db.gz:$DEST/pcf.db:
out_pcf_daily.csv.gz:$DEST/out_pcf_daily.csv:
"

echo "==> 恢复 $TAG 到 $DEST"
for line in $MANIFEST; do
  [ -z "$line" ] && continue
  name=${line%%:*}; rest=${line#*:}
  target=${rest%%:*}; want=${rest#*:}

  if [ -f "$target" ] && [ -z "${FORCE:-}" ]; then
    echo "  跳过 $name（$target 已存在，要覆盖请加 FORCE=1）"
    continue
  fi

  tmp="/tmp/$name"
  echo "  下载 $name ..."
  curl -fL --retry 3 --retry-delay 3 -o "$tmp" "$BASE/$name"

  if [ -n "$want" ]; then
    got=$(sha256sum "$tmp" | awk '{print $1}')
    if [ "$got" != "$want" ]; then
      echo "  !! SHA256 不符" >&2
      echo "     期望 $want" >&2
      echo "     实际 $got" >&2
      rm -f "$tmp"; exit 1
    fi
    echo "  校验通过"
  fi

  case "$name" in
    *.gz) gunzip -c "$tmp" > "$target" ;;
    *)    cp "$tmp" "$target" ;;
  esac
  rm -f "$tmp"
  echo "  -> $target ($(du -h "$target" | cut -f1))"
done

echo "==> 完成。数据已就位："
ls -lh "$DEST"/stocks.db "$DEST"/pcf.db "$DEST"/out_pcf_daily.csv 2>/dev/null | awk '{print "   ", $5, $9}'
