#!/usr/bin/env bash
# 换 Wi-Fi 后一键刷新局域网联调环境。
#
# 为什么需要它：二维码/证书/模拟器配置里编码的是"生成那一刻"的地址 ——
# IP 会随 Wi-Fi 变，所以每换一次网都要重建。本脚本把这些全部自动化：
#
#   1. 探测当前局域网 IP 与 mDNS 主机名（<主机名>.local，换网不变）
#   2. 重签自签证书（SAN 同时含 IP 与 <主机名>.local）
#   3. 重启 HTTPS 页面服务（静态 dist-page + /rpc 同源反代 → 8545）
#   4. 重新生成换机恢复链接与二维码（.local 优先 —— 换网后二维码仍有效；IP 版兜底）
#   5. 重启 VM 内设备模拟器（指向当前 IP 的链与页面）
#
# 注意：8545 的 anvil（lan.sh 起的）不需要重启 —— 它绑 0.0.0.0，IP 变了照样通。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PAGE_PORT=8443
RPC_PORT=8545

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 || true)"
if [ -z "$IP" ]; then echo "拿不到局域网 IP（Wi-Fi 没连?）" >&2; exit 1; fi
HOST="$(scutil --get LocalHostName | sed 's/\.local$//')"
LOCAL_HOST="${HOST}.local"

echo "当前环境: IP=$IP  主机名=$LOCAL_HOST"

# 1) 证书（SAN 覆盖两种寻址方式）
mkdir -p "$ROOT/.lan-tls"
openssl req -x509 -newkey rsa:2048 -keyout "$ROOT/.lan-tls/key.pem" \
  -out "$ROOT/.lan-tls/cert.pem" -days 30 -nodes \
  -subj "/CN=${LOCAL_HOST}" \
  -addext "subjectAltName=DNS:${LOCAL_HOST},DNS:localhost,IP:${IP},IP:127.0.0.1" \
  2>/dev/null

# 2) 重启 HTTPS 页面服务
kill "$(lsof -ti :$PAGE_PORT)" 2>/dev/null || true
sleep 1
nohup node "$HERE/https_page_server.mjs" "$PAGE_PORT" "http://127.0.0.1:$RPC_PORT" \
  >/tmp/memo-https.log 2>&1 &
sleep 1

# 3) 恢复链接（.local 优先）+ 二维码（VM 里的 segno；写入 .recover-run，
#    不要放 dist-page —— make_deploy_bundle 会整目录重建）
OUT="$ROOT/.recover-run"; mkdir -p "$OUT"
for NAME in local ip; do
  if [ "$NAME" = local ]; then PAGE_URL="https://${LOCAL_HOST}:${PAGE_PORT}/index.html"
  else PAGE_URL="https://${IP}:${PAGE_PORT}/index.html"; fi
  python3 "$HERE/make_payload.py" --recover \
    --owner 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
    --contract 0x5FbDB2315678afecb367f032d93F642f64180aa3 --chain-id 31337 \
    --page-url "$PAGE_URL" --out "$OUT/${NAME}-recover-link.txt" >/dev/null 2>&1
  python3 - "$OUT/${NAME}-recover-link.txt" "$OUT/${NAME}-inner.txt" <<'PY'
import sys
from urllib.parse import unquote
inner = unquote(open(sys.argv[1]).read().strip()).split("url=")[1]
open(sys.argv[2], "w").write(inner)
PY
  orb -m companion-dev bash -lc "python3 -c \"
import segno
u = open('/mnt/mac${OUT}/${NAME}-inner.txt').read().strip()
segno.make(u, error='m').save('/mnt/mac${OUT}/qr-${NAME}-recover.svg',
  kind='svg', scale=10, border=4, dark='#000', light='#fff')\"" >/dev/null 2>&1
done

# 4) 重启 VM 设备模拟器（指向当前 IP 的链 + .local 页面）
orb -m companion-dev bash -lc "pkill -f 'server.py --port 8099' 2>/dev/null; true" || true
orb -m companion-dev bash -lc "cd /mnt/mac${ROOT%/web3}/lab && (setsid python3 server.py \
  --port 8099 --contract 0x5FbDB2315678afecb367f032d93F642f64180aa3 --chain-id 31337 \
  --page-url 'https://${LOCAL_HOST}:${PAGE_PORT}/index.html' \
  --rpc-url 'http://${IP}:${RPC_PORT}' \
  --mnemonic 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' \
  >/tmp/sim.log 2>&1 &)" >/dev/null 2>&1

echo
echo "──────────────────────────────────────────────"
echo "环境已按当前网络刷新（换 Wi-Fi 后重跑本脚本即可）"
echo
echo "手机恢复页（IP 版，手机实测可用）: https://${IP}:${PAGE_PORT}/index.html"
echo "  → 二维码: .recover-run/qr-ip-recover.svg"
echo "主机名版（iOS 相机打不开 .local，仅 Mac 自测用）: https://${LOCAL_HOST}:${PAGE_PORT}/index.html"
echo "  → 二维码: .recover-run/qr-local-recover.svg"
echo "页面源码:      http://192.168.2.104:8123/index.html（见 .recover-run/ip-inner.txt 实际 IP）"
echo "助记词:        abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
echo "清理:          kill \$(lsof -ti :${PAGE_PORT} :$((PAGE_PORT+1)))"
echo "──────────────────────────────────────────────"
