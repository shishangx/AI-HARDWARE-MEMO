#!/usr/bin/env bash
# 在局域网内启动上链测试环境（手机可扫码的真实链路）。
#
# 为什么需要这个脚本
# ----------------
# 设备服务跑在 OrbStack 虚拟机里，虚拟机自认为的"本机地址"是 VM 内部地址
# （如 192.168.139.33），**手机根本访问不到**。手机需要的是 Mac 在局域网里的地址，
# 而那个地址只有在 Mac 上才看得到。所以由本脚本在 Mac 上探测并注入。
#
# 与本脚本的关系：
#   - anvil 与静态页面服务跑在 **Mac** 上（forge/anvil 装在 Mac，且 Mac 地址手机可达）
#   - 设备模拟器（录音/识别）跑在 **orb 虚拟机** 里（需要 sherpa-onnx）
#
# 用法:
#   web3/lan.sh start    启动链 + 部署合约 + 启动页面服务，并打印后续命令
#   web3/lan.sh stop     停止上述服务
#   web3/lan.sh status   查看状态与地址
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HERE/app"
PAGE_PORT="${PAGE_PORT:-8123}"
RPC_PORT="${RPC_PORT:-8545}"
DEV_PORT="${DEV_PORT:-8099}"          # 设备模拟器的端口（跑在 orb 里）
STATE_DIR="${TMPDIR:-/tmp}/memo-lan"
CONTRACT_FILE="$STATE_DIR/contract.txt"
ANVIL_LOG="$STATE_DIR/anvil.log"
PAGE_LOG="$STATE_DIR/page.log"

# anvil 的确定性测试账户，仅本地使用
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

mkdir -p "$STATE_DIR"

lan_ip() {
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null)" || true
  [ -n "$ip" ] || ip="$(ipconfig getifaddr en1 2>/dev/null)" || true
  echo "$ip"
}

port_open() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

cmd_start() {
  local ip; ip="$(lan_ip)"
  if [ -z "$ip" ]; then
    echo "无法确定局域网 IP（en0/en1 都没有地址）。请确认已连接 Wi-Fi。"
    exit 1
  fi
  echo "Mac 局域网地址: $ip"
  echo

  # 1) anvil —— 必须绑 0.0.0.0，否则手机连不上 RPC
  if port_open "$RPC_PORT"; then
    echo "[1/3] 链已在运行 (端口 $RPC_PORT)"
  else
    echo "[1/3] 启动本地链 (0.0.0.0:$RPC_PORT)…"
    nohup anvil --host 0.0.0.0 --port "$RPC_PORT" --silent >"$ANVIL_LOG" 2>&1 &
    for _ in $(seq 1 40); do
      curl -s -o /dev/null -m 1 -X POST -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' \
        "http://127.0.0.1:$RPC_PORT" && break
      sleep 0.25
    done
  fi

  # 2) 部署合约
  local contract=""
  if [ -f "$CONTRACT_FILE" ]; then
    contract="$(cat "$CONTRACT_FILE")"
    echo "[2/3] 复用已部署合约: $contract"
  else
    echo "[2/3] 部署 MemoryRegistry…"
    local out
    out="$(cd "$HERE" && forge create src/MemoryRegistry.sol:MemoryRegistry \
      --rpc-url "http://127.0.0.1:$RPC_PORT" --private-key "$ANVIL_KEY" --broadcast 2>&1)"
    contract="$(printf '%s' "$out" | sed -n 's/^Deployed to: //p' | head -1)"
    if [ -z "$contract" ]; then
      echo "部署失败："; printf '%s\n' "$out" | tail -20; exit 1
    fi
    printf '%s' "$contract" > "$CONTRACT_FILE"
    echo "      合约地址: $contract"
  fi

  # 3) 静态页面服务 —— 同样绑 0.0.0.0
  if port_open "$PAGE_PORT"; then
    echo "[3/3] 页面服务已在运行 (端口 $PAGE_PORT)"
  else
    echo "[3/3] 启动页面服务 (0.0.0.0:$PAGE_PORT)…"
    nohup python3 -m http.server "$PAGE_PORT" --bind 0.0.0.0 -d "$APP_DIR" \
      >"$PAGE_LOG" 2>&1 &
    sleep 1
  fi

  local page_url="http://$ip:$PAGE_PORT/index.html"
  local rpc_url="http://$ip:$RPC_PORT"

  echo
  echo "自检:"
  printf '  页面 %s → ' "$page_url"
  curl -s -o /dev/null -m 3 -w 'HTTP %{http_code}\n' "$page_url" || echo "不可达"
  printf '  RPC  %s → ' "$rpc_url"
  curl -s -o /dev/null -m 3 -w 'HTTP %{http_code}\n' \
    -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' "$rpc_url" || echo "不可达"

  echo
  echo "──────────────────────────────────────────────"
  echo "下一步：在另一个终端启动设备模拟器"
  echo
  echo "  orb -m companion-dev bash -lc \"cd /mnt/mac$HERE/../lab && \\"
  echo "    exec python3 server.py --port $DEV_PORT \\"
  echo "      --contract $contract --chain-id 31337 \\"
  echo "      --page-url '$page_url' --rpc-url '$rpc_url'\""
  echo
  echo "然后在 Mac 上打开设备界面: http://localhost:$DEV_PORT"
  echo "（手机也可以直接打开 http://$ip:$DEV_PORT 来看设备界面）"
  echo "──────────────────────────────────────────────"
  echo
  echo "注意: 手机与 Mac 必须在同一 Wi-Fi 下。"
}

cmd_stop() {
  echo "停止本地链与页面服务…"
  pkill -f "anvil --host 0.0.0.0 --port $RPC_PORT" 2>/dev/null && echo "  链已停止" || echo "  链未运行"
  pkill -f "http.server $PAGE_PORT" 2>/dev/null && echo "  页面服务已停止" || echo "  页面服务未运行"
}

cmd_status() {
  local ip; ip="$(lan_ip)"
  echo "Mac 局域网地址: ${ip:-未获取到}"
  printf '  链 (:%s)      ' "$RPC_PORT"; port_open "$RPC_PORT" && echo "运行中" || echo "未运行"
  printf '  页 面 (:%s)   ' "$PAGE_PORT"; port_open "$PAGE_PORT" && echo "运行中" || echo "未运行"
  printf '  设备 (:%s)    ' "$DEV_PORT"; port_open "$DEV_PORT" && echo "运行中" || echo "未运行（在 orb 内启动）"
  if [ -f "$CONTRACT_FILE" ]; then
    echo "  合约: $(cat "$CONTRACT_FILE")"
    [ -n "$ip" ] && echo "  页面地址: http://$ip:$PAGE_PORT/index.html"
    [ -n "$ip" ] && echo "  RPC 地址: http://$ip:$RPC_PORT"
  else
    echo "  合约: 尚未部署"
  fi
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *) echo "用法: lan.sh [start|stop|status]"; exit 1 ;;
esac
