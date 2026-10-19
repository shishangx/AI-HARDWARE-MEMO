#!/usr/bin/env bash
# 启动设备模拟器（语音备忘录 → 加密 → 上链二维码）。
#
# 用法（保持此终端窗口开着，关掉窗口服务即停 —— 这是模拟器的运行方式）:
#   bash lab/start_simulator.sh
#
# 前置:
#   · 需要 OrbStack 虚拟机 companion-dev（ASR 模型装在 VM 的 ~/companion-lab）
#   · 默认使用 Base Sepolia 公共 RPC 和已部署测试合约，无需启动本地 anvil
#   · 钱包页面已在可信 HTTPS 域名部署（默认使用 Vercel）
#
# 可用环境变量覆盖默认值:
#   CONTRACT / CHAIN_ID / DEPLOY_BLOCK / PAGE_URL / RPC_URL
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="${LAB_DIR:-$HERE}"
CONTRACT="${CONTRACT:-0x2737FAedBf625BF32069A7a076A6C42644292278}"
CHAIN_ID="${CHAIN_ID:-84532}"
DEPLOY_BLOCK="${DEPLOY_BLOCK:-0x2df3da5}"
PAGE_URL="${PAGE_URL:-https://ai-hardware-gamma.vercel.app/}"
RPC_URL="${RPC_URL:-https://base-sepolia.publicnode.com}"

echo "启动模拟器（按 Ctrl+C 停止）:"
echo "  页面: $PAGE_URL"
echo "  链:   $RPC_URL (chainId=$CHAIN_ID)"
echo
exec orb -m companion-dev bash -lc "cd /mnt/mac$LAB_DIR && \
  export LD_LIBRARY_PATH='/mnt/mac$LAB_DIR/r2t2/build/ubuntu-arm64/bin' && \
  exec python3 server.py --port 8099 \
    --contract $CONTRACT --chain-id $CHAIN_ID --deploy-block $DEPLOY_BLOCK \
    --page-url '$PAGE_URL' --rpc-url '$RPC_URL'"
