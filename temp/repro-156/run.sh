#!/usr/bin/env bash
# #156 最小复现: 末条消息 role="system" (Claude Code 后台任务通知) 触发上游空响应
#
# 用法:
#   ./run.sh [BASE_URL]        默认 http://127.0.0.1:18080
#
# 判定:
#   user.json   对照组 —— 必须非空; 若为空说明网关/上游本身有问题
#   system.json 待测   —— 空   = 复现了 #156 (网关需 NORMALIZE_INLINE_SYSTEM=0 才能看到)
#                        非空 = 已被网关归一为 user (默认 NORMALIZE_INLINE_SYSTEM=1)
#
# 退出码: 0=已被归一 2=复现空响应 1=连不上或对照组异常
set -uo pipefail

BASE=${1:-http://127.0.0.1:18080}
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if ! curl -s -m 5 --noproxy '*' "$BASE/healthz" | grep -q '^ok$'; then
  echo "ERROR: $BASE/healthz 不可达 — 先起 gateway" >&2
  exit 1
fi

summarize() {
  curl -s -m 180 --noproxy '*' \
    -H 'content-type: application/json' -H 'x-api-key: dummy' \
    --data-binary @"$1" "$BASE/v1/messages" \
  | python3 -c '
import sys, json
events, text, stop, out_tok = 0, "", "", None
for line in sys.stdin.read().splitlines():
    if line.startswith("event:"):
        events += 1
    if not line.startswith("data:"):
        continue
    try:
        d = json.loads(line[5:])
    except Exception:
        continue
    if d.get("type") == "content_block_delta" and d.get("delta", {}).get("type") == "text_delta":
        text += d["delta"]["text"]
    if d.get("type") == "message_delta":
        stop = d.get("delta", {}).get("stop_reason") or stop
        u = d.get("usage") or {}
        if "output_tokens" in u:
            out_tok = u["output_tokens"]
flat = " ".join(text.split())
print(f"{events}\t{len(text)}\t{out_tok}\t{stop}\t{flat[:100]}")
'
}

echo "gateway: $BASE"
echo
declare -A CHARS
for name in user system; do
  IFS=$'\t' read -r events chars tok stop preview <<<"$(summarize "$DIR/$name.json")"
  CHARS[$name]=$chars
  printf '%-7s events=%-4s 可见正文=%-4s字符 output_tokens=%-5s stop_reason=%-9s %s\n' \
    "$name" "$events" "$chars" "$tok" "$stop" "$preview"
done
echo

if [ "${CHARS[user]}" = "0" ]; then
  echo "FAIL: 对照组 user.json 也是空的 — 网关或上游本身有问题, 不是 #156 这个诱因"
  exit 1
fi

if [ "${CHARS[system]}" = "0" ]; then
  echo "复现: 末条 role=system → 上游 0 正文 (TUI 里表现为 Done 但无输出)"
  echo "      开启 NORMALIZE_INLINE_SYSTEM (默认) 即可规避"
  exit 2
fi

echo "已规避: 末条 role=system 被网关归一为 user, 上游正常生成正文"
exit 0
