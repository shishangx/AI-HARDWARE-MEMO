/*
 * 真机（手机浏览器）环节准备：向 lan.sh 的 8545 链提交加密记录，并生成
 * 指向局域网页面的换机恢复二维码。
 *
 * 提交用 anvil 预置账户模拟"imToken 签名并广播"—— 与真机的差别只有:
 * 签名来自确定性测试账户而非用户钱包。其余（加密、上链、枚举、解密）全同。
 *
 * 产物:
 *   .recover-run/lan-recover-url.txt  手机浏览器打开的恢复 URL
 *   dist-page/qr-recover.svg          该 URL 的二维码（给手机相机扫）
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

const RPC = process.env.LAN_RPC || "http://127.0.0.1:8545";
const LAN_IP = process.env.LAN_IP || "192.168.10.95";
const PAGE_URL = `http://${LAN_IP}:8123/index.html`;
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // lan.sh 已部署
const CHAIN_ID = 31337;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon about";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// 1) 两条"录音" → 设备端真实加密
const recA = join(HERE, "..", ".recover-run", "lan-a.wav");
const recB = join(HERE, "..", ".recover-run", "lan-b.wav");
mkdirSync(join(HERE, "..", ".recover-run"), { recursive: true });
writeFileSync(recA, Buffer.from("手机浏览器恢复联调 · 内容 A".repeat(60)));
writeFileSync(recB, Buffer.from("手机浏览器恢复联调 · 内容 B".repeat(100)));

const outDir = join(ROOT, ".recover-run");
const blobsFile = join(outDir, "lan-blobs.json");
const linkFile = join(outDir, "lan-link.txt");
execFileSync("python3", [
  join(HERE, "make_payload.py"),
  "--contract", CONTRACT, "--chain-id", String(CHAIN_ID), "--rpc", RPC,
  "--mnemonic", MNEMONIC,
  "--file", recA, "--file", recB,
  "--out", linkFile, "--blobs-out", blobsFile,
], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

// 2) 从待签链接反解载荷，与 blobs 组装成 addBatchOnchain 交易
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

const txHash = await rpc("eth_sendTransaction", [{
  from: OWNER, to: CONTRACT, data: enc.data,
  gas: "0x" + (4000000).toString(16),
}]);
let receipt = null;
for (let i = 0; i < 40 && !receipt; i++) {
  receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) await sleep(100);
}
if (!receipt || receipt.status !== "0x1") throw new Error("8545 上链失败");
console.log(`8545 已上链 2 条加密记录 (tx=${txHash})`);

// 3) 换机恢复链接（指向局域网页面 + 局域网 RPC）
execFileSync("python3", [
  join(HERE, "make_payload.py"),
  "--recover", "--owner", OWNER,
  "--contract", CONTRACT, "--chain-id", String(CHAIN_ID),
  "--page-url", PAGE_URL,
  "--out", join(outDir, "lan-recover-link.txt"),
], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

const universal = readFileSync(join(outDir, "lan-recover-link.txt"), "utf8").trim();
const innerUrl = decodeURIComponent(
  new URL(universal).searchParams.get("url"));
const phoneUrl = innerUrl.replace(
  /#/, "?rpc=" + encodeURIComponent(`http://${LAN_IP}:8545`) + "#");

// 4) 二维码（segno 在 VM 里跑，写进 dist-page 由 8098 服务）
const svgScript = [
  "import segno",
  `q = segno.make(${JSON.stringify(phoneUrl)}, error="m")`,
  `q.save("/mnt/mac/${ROOT}/dist-page/qr-recover.svg",`,
  '  kind="svg", scale=8, border=4, dark="#000", light="#fff")',
  "print('qr written')",
].join("\n");
execFileSync("orb", ["-m", "companion-dev", "bash", "-lc", `python3 <<'PY'\n${svgScript}\nPY`],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log(`
────────────────────────────────────────────
真机（手机浏览器）恢复测试就绪
────────────────────────────────────────────
owner:    ${OWNER}
助记词:   ${MNEMONIC}
手机打开: ${phoneUrl}
二维码:   dist-page/qr-recover.svg（8098 服务下: /qr-recover.svg）
────────────────────────────────────────────
`);
