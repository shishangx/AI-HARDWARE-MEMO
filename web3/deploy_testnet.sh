#!/usr/bin/env bash
# 把 MemoryRegistry 部署到公开测试网，让 imToken 能真正使用。
#
# 为什么必须上公网
# --------------
# 实测 imToken 会拒绝两类地址：
#   1. 私有 IP（192.168.x.x 等）—— 安全策略，防 DNS rebinding 与内网探测
#   2. 共享隧道域名（*.trycloudflare.com 等）—— 防钓鱼，整体拉黑
# 手机浏览器能打开它们，但 imToken 会拒绝。
# 因此 imToken 实际只接受 **公网可信域名 + 公网证书**，链也必须在公网。
#
# 好消息：公开测试网自带 HTTPS RPC，因此**连自建 RPC 都不需要**。
# 恢复先通过 eth_call 读取 owner 的批次区块索引，再只对命中区块调用
# eth_getLogs；可走 imToken provider，也可在联调时使用只读 RPC。
#
# 用法:
#   DEPLOY_KEY=0x... deploy_testnet.sh [网络名]
#   deploy_testnet.sh --list
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$HERE/.state"
mkdir -p "$STATE_DIR"

# 预置网络。RPC 均为公开端点，无需 API key。
networks() {
  cat <<'EOF'
sepolia|11155111|https://ethereum-sepolia-rpc.publicnode.com|Sepolia
base-sepolia|84532|https://sepolia.base.org|Base Sepolia
optimism-sepolia|11155420|https://sepolia.optimism.io|Optimism Sepolia
arbitrum-sepolia|421614|https://sepolia-rollup.arbitrum.io/rpc|Arbitrum Sepolia
polygon-amoy|80002|https://rpc-amoy.polygon.technology|Polygon Amoy
EOF
}

if [ "${1:-}" = "--list" ]; then
  echo "可用网络:"
  networks | while IFS='|' read -r key cid rpc name; do
    printf "  %-18s chainId=%-9s %s\n" "$key" "$cid" "$name"
  done
  exit 0
fi

WANT="${1:-sepolia}"
row="$(networks | grep "^$WANT|" || true)"
if [ -z "$row" ]; then
  echo "未知网络: $WANT（用 --list 查看）" >&2
  exit 1
fi
IFS='|' read -r NET_KEY CHAIN_ID RPC_URL NET_NAME <<<"$row"

if [ -z "${DEPLOY_KEY:-}" ]; then
  cat >&2 <<EOF
需要在环境变量里提供部署用私钥（该账户需有测试币）：

  DEPLOY_KEY=0x... $0 $NET_KEY

可通过水龙头领取测试币，例如 Sepolia:
  https://www.alchemy.com/faucets/ethereum-sepolia
  https://faucet.quicknode.com/ethereum/sepolia

注意: 只用专门创建的测试账户，不要用持有真实资产的私钥。
EOF
  exit 1
fi

echo "网络:   $NET_NAME (chainId=$CHAIN_ID)"
echo "RPC:    $RPC_URL"

# 先确认链可达并报告部署者余额，避免因余额不足而困惑
addr="$(cast wallet address --private-key "$DEPLOY_KEY" 2>/dev/null || true)"
[ -n "$addr" ] || { echo "私钥无效" >&2; exit 1; }
bal="$(cast balance "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo 0)"
echo "部署者: $addr"
echo "余额:   $bal wei"
if [ "$bal" = "0" ]; then
  echo
  echo "余额为 0，无法支付 gas。请先领取测试币后重试。" >&2
  exit 1
fi

CHAIN_OK="$(curl -s -m 15 -X POST -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\"}" "$RPC_URL" \
  | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null)"
[ "$CHAIN_OK" = "$CHAIN_ID" ] || { echo "RPC 返回 chainId=$CHAIN_OK，与预期不符" >&2; exit 1; }

echo
echo "部署 MemoryRegistry…"
out="$(cd "$HERE" && forge create src/MemoryRegistry.sol:MemoryRegistry \
  --rpc-url "$RPC_URL" --private-key "$DEPLOY_KEY" --broadcast 2>&1)"
contract="$(printf '%s' "$out" | sed -n 's/^Deployed to: //p' | head -1)"
if [ -z "$contract" ]; then
  echo "部署失败：" >&2; printf '%s\n' "$out" | tail -20 >&2; exit 1
fi

printf '%s' "$contract" > "$STATE_DIR/testnet_contract.txt"
printf '%s' "$RPC_URL"   > "$STATE_DIR/testnet_rpc.txt"
printf '%s' "$CHAIN_ID"  > "$STATE_DIR/testnet_chainid.txt"

# 部署区块用于兼容旧页面/旧合约的扫描回退；索引版恢复不依赖全区间扫描。
sleep 2
deploy_block="$(curl -s -m 15 -X POST -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$(printf '%s' "$out" | sed -n 's/^Transaction hash: //p' | head -1)\"]}" \
  "$RPC_URL" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",{}).get("blockNumber",""))' 2>/dev/null)"
printf '%s' "$deploy_block" > "$STATE_DIR/testnet_block.txt"

echo "已部署: $contract"
echo "部署区块: ${deploy_block:-（未获取到；仅影响旧合约扫描回退）}"
echo

cat <<EOF
──────────────────────────────────────────────
下一步：把页面托管到公网可信域名
──────────────────────────────────────────────

页面只有三个文件，直接上传即可:
  $HERE/app/index.html
  $HERE/app/abi.js
  $HERE/app/crypto.js

如果不清楚静态托管吃哪些文件，用工具自动收集（含缺失检查）:
  bash $HERE/tools/make_deploy_bundle.sh

⚠ crypto.js 是端侧加密管线的页面实现（与设备侧 lab/crypto/pipeline.py 同格式）。
  它已被 index.html 引入：页面 recover 模式只需**助记词 + owner 地址**即可在本地
  派生 KEK 并解密链上密文（无钱包也能恢复）。密钥层次已不含钱包签名 ——
  KEK = HKDF(种子秘密)，种子来自 BIP-39 助记词（见技术方案 §4.4/§4.5）。
  已验证：tools/recovery_e2e.mjs 在真实 EVM 上只凭助记词还原全部记录。
  尚未验证的只剩真机：imToken 内扫码 → 打开页面 → 恢复的全流程。

可选托管（按省事程度排序）:
  · Vercel / Netlify — 拖拽文件夹即可，自带 HTTPS 与可信域名
  · GitHub Pages    — https://<用户名>.github.io/<仓库>/
  · 自有域名        — 最稳

⚠ 不要用共享隧道域名（trycloudflare / ngrok 等），imToken 会拦截。

托管完成后，启动设备服务时给出公网页面地址即可:

  orb -m companion-dev bash -lc "cd /mnt/mac$HERE/../lab && \\
    exec python3 server.py --port 8099 \\
      --contract $contract --chain-id $CHAIN_ID \\
      --deploy-block ${deploy_block:-<部署区块>} \\
      --page-url https://<你的页面地址>/index.html \\
      --rpc-url $RPC_URL"

  --rpc-url 与 --deploy-block 会写进二维码链接的 query 参数。
  · --rpc-url    供"钱包不支持读取"时回退使用（若钱包支持, 可省略以缩短二维码）
  · --deploy-block 仅供旧合约兼容扫描使用；索引版恢复按批次区块精确查询
──────────────────────────────────────────────
EOF
