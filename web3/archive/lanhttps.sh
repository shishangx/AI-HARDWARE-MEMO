#!/usr/bin/env bash
# 局域网 HTTPS: 让 imToken 在局域网内也能拿到钱包 provider。
#
# 为什么需要它
# ----------
# imToken 要求 HTTPS。明文 http 下**页面能打开，但钱包 provider 不被注入** ——
# 现象就是点"连接钱包"毫无反应。而免费隧道域名会被 imToken 拦截，
# 自有域名不一定有。本方案完全不依赖外部资源：
#   局域网 HTTPS + 本地 CA（手机信任它即可）。
#
# 代价：手机必须安装并信任本 CA（一次性操作，见下方输出）。
#
# 用法:
#   web3/lanhttps.sh start [IP]     # 不传 IP 则自动探测
#   web3/lanhttps.sh ca             # 只打印 CA 安装步骤
#   web3/lanhttps.sh stop
#   web3/lanhttps.sh status
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$HERE/.state"
CERT_DIR="$STATE_DIR/certs"
URL_FILE="$STATE_DIR/page_url.txt"
CONTRACT_FILE="$STATE_DIR/contract.txt"
RPC_PORT="${RPC_PORT:-8545}"
TLS_PORT="${TLS_PORT:-8443}"
DEV_PORT="${DEV_PORT:-8099}"
ANVIL_LOG="$STATE_DIR/anvil.log"
SERVE_LOG="$STATE_DIR/serve_tls.log"
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

mkdir -p "$STATE_DIR"
port_open() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

lan_ip() {
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null)" || true
  [ -n "$ip" ] || ip="$(ipconfig getifaddr en1 2>/dev/null)" || true
  echo "$ip"
}

print_ca_steps() {
  local ca="$CERT_DIR/ca.crt"
  cat <<EOF
──────────────────────────────────────────────
手机需要先信任本机 CA，否则访问会提示"不安全连接"，钱包同样不会被注入。

把 CA 传到手机（AirDrop / 微信 / 邮件均可）：
  $ca

iOS:
  设置 → 通用 → VPN与设备管理 → 安装该描述文件
  再到 设置 → 通用 → 关于本机 → 证书信任设置 → 为 "Memo Lab Local CA" 打开信任

Android:
  设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书 → 选择该文件
  注: Android 7+ 部分应用默认不信任用户 CA，若失败请改用可信域名托管方案
──────────────────────────────────────────────
EOF
}

cmd_start() {
  local ip="${1:-}"
  [ -n "$ip" ] || ip="$(lan_ip)"
  if [ -z "$ip" ]; then
    echo "无法确定局域网 IP，请显式传入，例如: lanhttps.sh start 192.168.0.151"
    exit 1
  fi
  echo "局域网地址: $ip"

  # 1) 证书。已有证书必须确认 SAN 覆盖当前 IP ——
  #    换网络后 IP 会变, 旧证书会因"名称不匹配"被判为不安全连接。
  local need_cert=1
  if [ -f "$CERT_DIR/server.crt" ] \
     && openssl x509 -in "$CERT_DIR/server.crt" -noout -ext subjectAltName 2>/dev/null | grep -qF "$ip"; then
    need_cert=0
  fi
  if [ "$need_cert" = "1" ]; then
    # 变量必须用 ${} 界定: 后面紧跟全角括号时, 非 UTF-8 locale 下 bash 会把
    # 括号的首字节并入变量名, 报 "unbound variable"。
    echo "[1/4] 生成本地 CA 与服务器证书 (SAN: ${ip})"
    bash "$HERE/tools/gen_cert.sh" "$ip" "$CERT_DIR" | tail -6
  else
    echo "[1/4] 复用证书 (SAN 已含 ${ip})"
  fi

  # 2) 链
  if port_open "$RPC_PORT"; then
    echo "[2/4] 链已在运行 (:$RPC_PORT)"
  else
    echo "[2/4] 启动本地链…"
    nohup anvil --host 0.0.0.0 --port "$RPC_PORT" --silent >"$ANVIL_LOG" 2>&1 &
    sleep 1
  fi

  # 3) 合约（复用前校验链上确有代码，链重启后缓存会失效）
  local contract=""
  if [ -f "$CONTRACT_FILE" ]; then
    local cached code
    cached="$(cat "$CONTRACT_FILE")"
    code="$(curl -s --noproxy '*' -m 5 -X POST -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$cached\",\"latest\"]}" \
      "http://127.0.0.1:$RPC_PORT" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",""))' 2>/dev/null)"
    if [ -n "$code" ] && [ "$code" != "0x" ]; then
      contract="$cached"; echo "[3/4] 复用合约: $contract"
    else
      echo "[3/4] 缓存地址在链上无合约（链已重启），重新部署…"
    fi
  fi
  if [ -z "$contract" ]; then
    local out
    out="$(cd "$HERE" && forge create src/MemoryRegistry.sol:MemoryRegistry \
      --rpc-url "http://127.0.0.1:$RPC_PORT" --private-key "$ANVIL_KEY" --broadcast 2>&1)"
    contract="$(printf '%s' "$out" | sed -n 's/^Deployed to: //p' | head -1)"
    [ -n "$contract" ] || { echo "部署失败："; printf '%s\n' "$out" | tail -15; exit 1; }
    printf '%s' "$contract" > "$CONTRACT_FILE"
    echo "[3/4] 部署完成: $contract"
  fi

  # 4) TLS 服务（页面与 /rpc 同源）
  if port_open "$TLS_PORT"; then
    echo "[4/4] TLS 服务已在运行 (:$TLS_PORT)"
  else
    echo "[4/4] 启动 TLS 服务 (:$TLS_PORT)…"
    nohup python3 "$HERE/tools/serve.py" --port "$TLS_PORT" --host 0.0.0.0 \
      --rpc "http://127.0.0.1:$RPC_PORT" \
      --tls-cert "$CERT_DIR/server.crt" --tls-key "$CERT_DIR/server.key" \
      >"$SERVE_LOG" 2>&1 &
    sleep 1.5
  fi

  local page="https://$ip:$TLS_PORT/index.html"
  printf '%s' "$page" > "$URL_FILE"

  echo
  echo "自检（用本地 CA 校验，模拟手机信任后的情况）:"
  local code
  code="$(curl -s -o /dev/null --noproxy '*' -m 10 --cacert "$CERT_DIR/ca.crt" \
    -w '%{http_code}' "$page" 2>/dev/null)"
  echo "  页面 → HTTP $code"
  local rcode
  rcode="$(curl -s -o /dev/null --noproxy '*' -m 10 --cacert "$CERT_DIR/ca.crt" \
    -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' \
    "https://$ip:$TLS_PORT/rpc" 2>/dev/null)"
  echo "  RPC  → HTTP $rcode"
  if [ "$code" != "200" ]; then
    echo "  (若为 000, 检查证书 SAN 是否含 ${ip})"
    tail -5 "$SERVE_LOG" 2>/dev/null
  fi

  echo
  echo "──────────────────────────────────────────────"
  echo "HTTPS 页面地址: $page"
  echo
  echo "设备服务启动命令："
  echo
  echo "  orb -m companion-dev bash -lc \"cd /mnt/mac$HERE/../lab && \\"
  echo "    exec python3 server.py --port $DEV_PORT \\"
  echo "      --contract $contract --chain-id 31337 \\"
  echo "      --page-url-file /mnt/mac$URL_FILE\""
  echo
  print_ca_steps
}

cmd_stop() {
  pkill -f "tools/serve.py --port $TLS_PORT" 2>/dev/null && echo "TLS 服务已停止" || echo "TLS 服务未运行"
  pkill -f "anvil --host 0.0.0.0 --port $RPC_PORT" 2>/dev/null && echo "链已停止" || echo "链未运行"
}

cmd_status() {
  printf '链 (:%s)        ' "$RPC_PORT"; port_open "$RPC_PORT" && echo "运行中" || echo "未运行"
  printf 'TLS 服务 (:%s)  ' "$TLS_PORT"; port_open "$TLS_PORT" && echo "运行中" || echo "未运行"
  [ -f "$URL_FILE" ] && echo "页面地址: $(cat "$URL_FILE")" || echo "页面地址: 未生成"
  [ -f "$CONTRACT_FILE" ] && echo "合约: $(cat "$CONTRACT_FILE")"
  [ -f "$CERT_DIR/ca.crt" ] && echo "CA: $CERT_DIR/ca.crt"
}

case "${1:-start}" in
  start)  shift 2>/dev/null || true; cmd_start "${1:-}" ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  ca)     print_ca_steps ;;
  *) echo "用法: lanhttps.sh [start [IP]|stop|status|ca]"; exit 1 ;;
esac
