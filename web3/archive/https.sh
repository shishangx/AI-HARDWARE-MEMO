#!/usr/bin/env bash
# 用 HTTPS 暴露上链页面 —— imToken 要求 DApp 页面必须走 HTTPS。
#
# 为什么必须有这一步
# ----------------
# imToken 官方文档明确 "HTTPS is required by default"。明文 http 打开时
# 除了会提示安全风险，**钱包 provider 很可能根本不被注入** ——
# 表现就是页面里点"连接钱包"没有任何反应。
#
# 为什么把页面和 RPC 合成一个端口
# ----------------------------
# HTTPS 页面里的脚本再请求 http:// 的 RPC 会被浏览器当作**混合内容**直接拦截,
# 连请求都不会发出。因此 tools/serve.py 同时提供静态页面与 /rpc 代理,
# 使二者同源; 一条隧道即可承载全部流量。
#
# 用法:
#   web3/https.sh start    # 起链 + 部署 + 同源服务 + HTTPS 隧道
#   web3/https.sh stop
#   web3/https.sh status
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CF="$HERE/bin/cloudflared"
LOCAL_PORT="${LOCAL_PORT:-8080}"
RPC_PORT="${RPC_PORT:-8545}"
# 状态放在项目目录内, 不放 $TMPDIR —— 设备服务跑在虚拟机里, 只能看到
# /mnt/mac/ 挂载的路径; /var/folders/... 在虚拟机内不存在, 会导致读不到页面地址。
STATE_DIR="${HERE}/.state"
URL_FILE="$STATE_DIR/page_url.txt"
CONTRACT_FILE="$STATE_DIR/contract.txt"
ANVIL_LOG="$STATE_DIR/anvil.log"
SERVE_LOG="$STATE_DIR/serve.log"
TUNNEL_LOG="$STATE_DIR/tunnel.log"
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

mkdir -p "$STATE_DIR"
port_open() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

cmd_start() {
  [ -x "$CF" ] || { echo "缺少 $CF，请先下载 cloudflared"; exit 1; }

  # 1) 链
  if port_open "$RPC_PORT"; then
    echo "[1/4] 链已在运行 (:$RPC_PORT)"
  else
    echo "[1/4] 启动本地链…"
    nohup anvil --host 127.0.0.1 --port "$RPC_PORT" --silent >"$ANVIL_LOG" 2>&1 &
    sleep 1
  fi

  # 2) 合约。复用缓存地址前必须确认链上真的有代码 ——
  #    链重启后状态是全新的, 而缓存文件还在, 直接复用会把交易发到空地址:
  #    交易"成功"却没有日志, 表现为"提交成功但读不到记录", 很难定位。
  local contract=""
  if [ -f "$CONTRACT_FILE" ]; then
    local cached; cached="$(cat "$CONTRACT_FILE")"
    local code
    code="$(curl -s --noproxy '*' -m 5 -X POST -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$cached\",\"latest\"]}" \
      "http://127.0.0.1:$RPC_PORT" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",""))' 2>/dev/null)"
    if [ -n "$code" ] && [ "$code" != "0x" ]; then
      contract="$cached"
      echo "[2/4] 复用合约: $contract"
    else
      echo "[2/4] 缓存的地址在链上无合约（链已重启），重新部署…"
    fi
  fi

  if [ -z "$contract" ]; then
    [ -f "$CONTRACT_FILE" ] || echo "[2/4] 部署 MemoryRegistry…"
    local out
    out="$(cd "$HERE" && forge create src/MemoryRegistry.sol:MemoryRegistry \
      --rpc-url "http://127.0.0.1:$RPC_PORT" --private-key "$ANVIL_KEY" --broadcast 2>&1)"
    contract="$(printf '%s' "$out" | sed -n 's/^Deployed to: //p' | head -1)"
    [ -n "$contract" ] || { echo "部署失败："; printf '%s\n' "$out" | tail -15; exit 1; }
    printf '%s' "$contract" > "$CONTRACT_FILE"
    echo "      合约地址: $contract"
  fi

  # 3) 同源服务(页面 + /rpc)
  if port_open "$LOCAL_PORT"; then
    echo "[3/4] 同源服务已在运行 (:$LOCAL_PORT)"
  else
    echo "[3/4] 启动同源服务 (:$LOCAL_PORT)…"
    nohup python3 "$HERE/tools/serve.py" --port "$LOCAL_PORT" \
      --rpc "http://127.0.0.1:$RPC_PORT" >"$SERVE_LOG" 2>&1 &
    sleep 1
  fi
  printf '      自检 /rpc → '
  curl -s -o /dev/null --noproxy '*' -m 3 -w 'HTTP %{http_code}\n' -X POST \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' \
    "http://127.0.0.1:$LOCAL_PORT/rpc" || echo "不可达"

  # 4) HTTPS 隧道
  if [ -f "$TUNNEL_LOG" ] && grep -q 'trycloudflare.com' "$TUNNEL_LOG" 2>/dev/null \
     && pgrep -f "cloudflared.*$LOCAL_PORT" >/dev/null 2>&1; then
    echo "[4/4] 隧道已在运行"
  else
    echo "[4/4] 建立 HTTPS 隧道…"
    : > "$TUNNEL_LOG"
    nohup "$CF" tunnel --url "http://127.0.0.1:$LOCAL_PORT" --no-autoupdate \
      >"$TUNNEL_LOG" 2>&1 &
    for _ in $(seq 1 60); do
      grep -qE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null && break
      sleep 1
    done
  fi

  local url
  url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)"
  if [ -z "$url" ]; then
    echo "隧道地址获取失败，日志末尾："
    tail -15 "$TUNNEL_LOG"
    exit 1
  fi

  local pages="$url/index.html"
  printf '%s' "$pages" > "$URL_FILE"

  echo
  echo "自检（隧道刚建立时边缘节点尚未生效，需等待）:"
  # URL 一出现在日志里就能取出, 但 Cloudflare 边缘真正可用还要几秒;
  # 立即探测会得到 000 而误判为失败。
  local code="" i
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null --noproxy '*' -m 10 -w '%{http_code}' "$pages" 2>/dev/null)"
    [ "$code" = "200" ] && break
    sleep 2
  done
  echo "  页面 → HTTP $code"
  local rcode
  rcode="$(curl -s -o /dev/null --noproxy '*' -m 15 -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' "$url/rpc" 2>/dev/null)"
  echo "  RPC  → HTTP $rcode"
  if [ "$code" != "200" ]; then
    echo "  注意: 边缘节点可能仍在生效，稍等片刻再扫即可"
  fi

  echo
  echo "──────────────────────────────────────────────"
  echo "HTTPS 页面地址: $pages"
  echo
  echo "设备服务启动命令（地址已写入文件，可用 --page-url-file 自动跟随）："
  echo
  echo "  orb -m companion-dev bash -lc \"cd /mnt/mac$HERE/../lab && \\"
  echo "    exec python3 server.py --port 8099 \\"
  echo "      --contract $contract --chain-id 31337 \\"
  echo "      --page-url-file $URL_FILE\""
  echo
  echo "注意: 隧道是公网地址，任何拿到链接的人都能打开该页面。"
  echo "      载荷放在 URL fragment 中不会被发送到服务器，但请知悉这一点。"
  echo "──────────────────────────────────────────────"
}

cmd_stop() {
  pkill -f "cloudflared tunnel --url" 2>/dev/null && echo "隧道已停止" || echo "隧道未运行"
  pkill -f "tools/serve.py --port $LOCAL_PORT" 2>/dev/null && echo "同源服务已停止" || echo "同源服务未运行"
  pkill -f "anvil --host 127.0.0.1 --port $RPC_PORT" 2>/dev/null && echo "链已停止" || echo "链未运行"
}

cmd_status() {
  printf '链 (:%s)        ' "$RPC_PORT"; port_open "$RPC_PORT" && echo "运行中" || echo "未运行"
  printf '同源服务 (:%s)  ' "$LOCAL_PORT"; port_open "$LOCAL_PORT" && echo "运行中" || echo "未运行"
  printf '隧道            '; pgrep -f "cloudflared tunnel --url" >/dev/null 2>&1 && echo "运行中" || echo "未运行"
  [ -f "$URL_FILE" ] && echo "页面地址: $(cat "$URL_FILE")" || echo "页面地址: 未生成"
  [ -f "$CONTRACT_FILE" ] && echo "合约: $(cat "$CONTRACT_FILE")"
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *) echo "用法: https.sh [start|stop|status]"; exit 1 ;;
esac
