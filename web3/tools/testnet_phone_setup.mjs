/*
 * 公网真机环节（Base Sepolia + Vercel）：
 *   1. 走真实设备路径加密 3 条录音（make_payload.py --mnemonic）
 *   2. cast send 本地签名把密文上链（公共 RPC 不支持 eth_sendTransaction）
 *   3. 生成换机恢复链接与二维码（指向 Vercel 页面，含合约/链号/owner/部署块）
 *
 * 私钥从 .state/testnet-key.txt 读入，不经过命令行回显。
 * 产物：.recover-run/testnet-*.txt / qr-testnet-recover.svg
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MinABI = require(join(ROOT, "app", "abi.js"));

const STATE = join(ROOT, ".state");
const RPC = readFileSync(join(STATE, "testnet_rpc.txt"), "utf8").trim();
const CHAIN_ID = Number(readFileSync(join(STATE, "testnet_chainid.txt"), "utf8"));
const CONTRACT = readFileSync(join(STATE, "testnet_contract.txt"), "utf8").trim();
const DEPLOY_BLOCK = readFileSync(join(STATE, "testnet_block.txt"), "utf8").trim();
const KEY = (readFileSync(join(STATE, "testnet-key.txt"), "utf8")
  .match(/0x[0-9a-fA-F]{64}/) || [])[0];
if (!KEY) throw new Error("找不到私钥（.state/testnet-key.txt）");
const OWNER = execFileSync("cast", ["wallet", "address", "--private-key", KEY],
  { encoding: "utf8" }).match(/0x[0-9a-fA-F]{40}/)[0];
const DEPLOY_BLOCK_NUM = parseInt(DEPLOY_BLOCK, 16) || 0;

// 页面用根路径（Vercel 对 /index.html 做 404 归一化）
const PAGE_URL = process.env.PAGE_URL || "https://ai-hardware-gamma.vercel.app/";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon about";

// 1) 真实设备路径加密
const outDir = join(ROOT, ".recover-run");
mkdirSync(outDir, { recursive: true });
const recA = join(outDir, "tn-a.wav"), recB = join(outDir, "tn-b.wav"), recC = join(outDir, "tn-c.wav");
writeFileSync(recA, Buffer.from("真机恢复联调 · 内容 A（Base Sepolia）".repeat(40)));
writeFileSync(recB, Buffer.from("真机恢复联调 · 内容 B（Base Sepolia）".repeat(70)));
writeFileSync(recC, Buffer.from("真机恢复联调 · 内容 C（Base Sepolia）".repeat(110)));
const blobsFile = join(outDir, "tn-blobs.json");
const linkFile = join(outDir, "tn-link.txt");
execFileSync("python3", [
  join(HERE, "make_payload.py"),
  "--contract", CONTRACT, "--chain-id", String(CHAIN_ID),
  "--mnemonic", MNEMONIC,
  "--file", recA, "--file", recB, "--file", recC,
  "--out", linkFile, "--blobs-out", blobsFile,
], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

// 2) 组装 addBatchOnchain，本地签名上链（公共 RPC 不代发交易）
const inner = decodeURIComponent(
  new URL(readFileSync(linkFile, "utf8").trim()).searchParams.get("url"));
const frag = inner.slice(inner.indexOf("#p=") + 3);
const b64 = frag.replace(/-/g, "+").replace(/_/g, "/");
const payload = JSON.parse(Buffer.from(
  b64 + "=".repeat((4 - b64.length % 4) % 4), "base64").toString("utf8"));
const blobs = JSON.parse(readFileSync(blobsFile, "utf8"));
const entries = payload.records.map((r, i) => ({
  timestamp: r.t, contentHash: r.h,
  payloadHex: "0x" + String(blobs[i].blob).replace(/^0x/, ""),
}));
const enc = MinABI.encodeAddBatchOnchain(entries);

const out = execFileSync("cast", ["send", CONTRACT,
  "--rpc-url", RPC, "--private-key", KEY,
  enc.data],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const txHash = (out.match(/transactionHash\s+(0x[0-9a-fA-F]{64})/) || [])[1];
if (!txHash) throw new Error("无法解析交易哈希:\n" + out.slice(-400));
console.log(`Base Sepolia 已上链 3 条加密记录 (tx=${txHash})`);

// 3) 换机恢复链接 + 二维码（.recover-run，不进部署包）
execFileSync("python3", [
  join(HERE, "make_payload.py"),
  "--recover", "--owner", OWNER,
  "--contract", CONTRACT, "--chain-id", String(CHAIN_ID),
  "--deploy-block", String(DEPLOY_BLOCK_NUM),
  "--page-url", PAGE_URL,
  "--out", join(outDir, "tn-recover-link.txt"),
], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

const universal = readFileSync(join(outDir, "tn-recover-link.txt"), "utf8").trim();
const innerUrl = decodeURIComponent(new URL(universal).searchParams.get("url"));

const svgScript = [
  "import segno",
  `u = open('/mnt/mac${outDir}/tn-recover-inner.txt').read().strip()`,
  `segno.make(u, error='m').save('/mnt/mac${outDir}/qr-testnet-recover.svg',`,
  "  kind='svg', scale=8, border=4, dark='#000', light='#fff')",
  "print('qr ok')",
].join("\n");
writeFileSync(join(outDir, "tn-recover-inner.txt"), innerUrl);
execFileSync("orb", ["-m", "companion-dev", "bash", "-lc",
  `python3 <<'PY'\n${svgScript}\nPY`],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log(`
────────────────────────────────────────────
公网真机（imToken）恢复测试就绪
────────────────────────────────────────────
owner:    ${OWNER}
合约:     ${CONTRACT} (chainId=${CHAIN_ID}, 部署块=${DEPLOY_BLOCK_NUM})
助记词:   ${MNEMONIC}
页面:     ${PAGE_URL}
二维码:   .recover-run/qr-testnet-recover.svg
────────────────────────────────────────────
`);
