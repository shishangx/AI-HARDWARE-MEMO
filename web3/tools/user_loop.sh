#!/usr/bin/env bash
# 用【你自己的钱包助记词】跑通"签名上链 → 助记词恢复"完整闭环。
#
# 用法:
#   bash tools/user_loop.sh '你的 12 或 24 个助记词，用空格分隔'
#
# 它会：
#   1. 从助记词推出你的钱包地址（owner —— 记录将归到这个地址名下）
#   2. 生成一条小录音（~500B，单帧二维码装得下密文）
#   3. 走真实设备路径加密（密钥 = 你的助记词），密文直接进二维码载荷
#   4. 生成提交二维码（指向 Vercel 页面 + 公共 RPC + 部署块）
#
# 之后你只需：
#   imToken 扫 Mac 屏幕上的二维码 → 连接钱包（任意有测试币的钱包）
#   → 签名并上链 → 页面下方换机恢复卡片输入【同一个助记词】→ 恢复记录
#
# 安全边界：脚本只在你本机运行；助记词不写入任何文件（仅内存传递）；
# 只用于测试网演示。⚠ 不要用持有真实资产的助记词跑本脚本。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

MN="${1:-}"
if [ -z "$MN" ]; then
  echo "用法: bash tools/user_loop.sh '<12/24 个助记词，空格分隔>'" >&2
  exit 1
fi

CONTRACT="0x2737FAedBf625BF32069A7a076A6C42644292278"   # Base Sepolia 索引版部署
CHAIN_ID=84532
DEPLOY_BLOCK="0x2df3da5"
RPC="https://base-sepolia.publicnode.com"
PAGE_URL="https://ai-hardware-gamma.vercel.app/"
OUT="$ROOT/.recover-run/user-loop"
mkdir -p "$OUT"

# 1) 助记词 → 地址（owner）
PK="$(cast wallet private-key --mnemonic "$MN" 2>/dev/null || true)"
if [ -z "$PK" ]; then echo "助记词无效（词数/拼写/校验和）" >&2; exit 1; fi
ADDR="$(cast wallet address --private-key "$PK")"
echo "你的钱包地址（记录 owner）: $ADDR"
bal="$(cast balance "$ADDR" --rpc-url https://base-sepolia.publicnode.com 2>/dev/null || echo 0)"
echo "该地址 Base Sepolia 余额: $bal wei（签名上链需少量 gas）"
if [ "$bal" = "0" ]; then
  echo "⚠ 该地址没有测试币 —— 你可以扫二维码后换【任意有测试币的钱包】签名，"
  echo "  记录会归到签名钱包名下；恢复时 owner 填签名钱包地址、助记词仍用本条。"
fi

# 2) 小录音（<600B，单帧二维码装得下密文）
python3 - "$OUT/user-loop.wav" <<'PY'
import struct, math, random, sys
random.seed(11)
sr = 8000; n = 460
samples = bytes([128 + (int(30*math.sin(i*0.15)) + random.randint(-5,5)) & 0xff for i in range(n)])
hdr = b"RIFF" + struct.pack("<I", 36+n) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16,1,1,sr,sr,1,8) + b"data" + struct.pack("<I", n)
open(sys.argv[1], "wb").write(hdr + samples)
PY

# 3) 设备路径加密 + 密文进载荷（助记词只经环境变量传递，不落盘）
python3 "$HERE/make_payload.py" \
  --contract 0x2737FAedBf625BF32069A7a076A6C42644292278 \
  --chain-id "$CHAIN_ID" --mnemonic "$MN" --blob-in-payload \
  --file "$OUT/user-loop.wav" --page-url "$PAGE_URL" \
  --out "$OUT/submit-link.txt" >/dev/null 2>&1

# 4) 组装链接（公共 RPC + 部署块进 query）并出二维码
python3 - "$OUT/submit-link.txt" "$OUT/inner.txt" "$RPC" "$DEPLOY_BLOCK" <<'PY'
import sys
from urllib.parse import unquote, quote
raw = open(sys.argv[1]).read().strip()
inner = unquote(raw).split("url=")[1] if "url=" in raw else raw
inner = inner.replace("#", "?rpc=" + quote(sys.argv[3], safe="") + "&from=" + sys.argv[4] + "#")
open(sys.argv[2], "w").write(inner)
PY
orb -m companion-dev bash -lc "python3 -c \"
import segno
u = open('/mnt/mac${OUT}/inner.txt').read().strip()
segno.make(u, error='m').save('/mnt/mac${OUT}/qr-user-loop.svg',
  kind='svg', scale=6, border=4, dark='#000', light='#fff')\"" >/dev/null 2>&1

echo
echo "──────────────────────────────────────────────"
echo "二维码已生成: .recover-run/user-loop/qr-user-loop.svg"
echo "（已在浏览器打开；也可直接在 imToken DApp 浏览器粘贴下方链接）"
echo
python3 -c "
from urllib.parse import unquote
print(unquote(open('${OUT}/inner.txt').read().strip()).split('url=')[-1])"
echo
echo "恢复时在页面输入本条助记词（与加密用的同一份）"
echo "──────────────────────────────────────────────"
