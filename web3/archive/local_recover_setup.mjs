/*
 * 本地真跑"换机恢复"的前半段：起链、部署、上链加密记录、生成恢复链接。
 *
 * 与 e2e.mjs 的区别：e2e 跑完就关链；本脚本把 anvil 留在后台，
 * 让真实浏览器（模拟手机）打开恢复页面走完最后一公里 ——
 * 这正是本地能验到的最接近 imToken 真机的形态。
 *
 * 用法: node tools/local_recover_setup.mjs
 * 产物: 终端打印 inner 页面 URL / owner / 助记词 / RPC，anvil 继续运行。
 * 清理: kill $(lsof -ti :8547)
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MinABI = require(join(ROOT, "app", "abi.js"));

const PORT = Number(process.env.RECOVER_PORT || 8547);
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PRIVKEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon about";
// 与 lab/server.py 演示态无关；页面 URL 托管在 8098（本脚本不负责托管）
const PAGE_URL = "http://localhost:8098/index.html";

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

async function waitForRpc(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await rpc("eth_chainId"); return true; } catch { await sleep(200); }
  }
  return false;
}

function deploy() {
  const out = execFileSync("forge", [
    "create", "src/MemoryRegistry.sol:MemoryRegistry",
    "--rpc-url", RPC, "--private-key", PRIVKEY, "--broadcast",
  ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error("无法解析部署地址:\n" + out);
  return m[1];
}

/** 从 Universal Link 反解出 inner 页面 URL（含 fragment） */
function decodeLink(link) {
  return decodeURIComponent(new URL(link).searchParams.get("url"));
}

// ---- 主流程 ----
const anvil = spawn("anvil", ["--port", String(PORT), "--silent"],
  { stdio: "ignore", detached: true });
anvil.unref();
if (!await waitForRpc()) throw new Error("anvil 未就绪");
console.log(`anvil 已启动: ${RPC} (清理: kill $(lsof -ti :${PORT}))`);

const contract = deploy();
console.log(`合约已部署: ${contract}`);

// 造两条"录音"，走真实的设备端工具加密
const work = mkdtempSync(join(tmpdir(), "memo-recover-"));
const recDir = join(work, "recordings");
mkdirSync(recDir, { recursive: true });
const recA = join(recDir, "20260923-100100.wav");
const recB = join(recDir, "20260923-100200.wav");
writeFileSync(recA, Buffer.from("本地联调录音内容 A（设备真实加密路径）".repeat(50)));
writeFileSync(recB, Buffer.from("本地联调录音内容 B".repeat(80)));

const outDir = join(ROOT, ".recover-run");
mkdirSync(outDir, { recursive: true });
const blobsFile = join(outDir, "blobs.json");
execFileSync("python3", [
  join(HERE, "make_payload.py"),
  "--contract", contract, "--chain-id", String(CHAIN_ID), "--rpc", RPC,
  "--mnemonic", MNEMONIC,
  "--file", recA, "--file", recB,
  "--out", join(outDir, "link.txt"), "--blobs-out", blobsFile,
], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

const blobs = JSON.parse(readFileSync(blobsFile, "utf8"));
// 密文进 calldata：页面在恢复模式自己切片取回，不依赖外部存储
const records = blobs.map((b, i) => ({
  timestamp: Number(b.timestamp ?? b.t),
  contentHash: b.contentHash ?? b.h,
  payloadHex: "0x" + String(b.blob).replace(/^0x/, ""),
}));

// make_payload 的 blobs.json 里没有 hash —— 从 link.txt 的待签批次取。
// 为避免依赖其输出格式，这里直接从 blobs 重新按记录序取：它本身带 seq/timestamp。
const submitLinkFile = join(outDir, "link.txt");
const submitLink = readFileSync(submitLinkFile, "utf8").trim();
const innerSubmit = decodeLink(submitLink);
const frag = innerSubmit.slice(innerSubmit.indexOf("#p=") + 3);
const b64 = frag.replace(/-/g, "+").replace(/_/g, "/");
const submitPayload = JSON.parse(Buffer.from(
  b64 + "=".repeat((4 - b64.length % 4) % 4), "base64").toString("utf8"));

const entries = submitPayload.records.map((r, i) => ({
  timestamp: r.t,
  contentHash: r.h,
  payloadHex: "0x" + String(blobs[i].blob).replace(/^0x/, ""),
}));

const enc = MinABI.encodeAddBatchOnchain(entries);
const txHash = await rpc("eth_sendTransaction", [{
  from: OWNER, to: contract, data: enc.data,
  gas: "0x" + (4000000).toString(16),
}]);
let receipt = null;
for (let i = 0; i < 40 && !receipt; i++) {
  receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) await sleep(100);
}
if (!receipt || receipt.status !== "0x1") throw new Error("上链失败");
console.log(`已上链 ${entries.length} 条加密记录 (tx=${txHash})`);

// 生成恢复链接（走真实的设备端工具）
execFileSync("python3", [
  join(HERE, "make_payload.py"),
  "--recover", "--owner", OWNER,
  "--contract", contract, "--chain-id", String(CHAIN_ID),
  "--deploy-block", "1", "--page-url", PAGE_URL,
  "--out", join(outDir, "recover-link.txt"),
], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

const universal = readFileSync(join(outDir, "recover-link.txt"), "utf8").trim();
const innerUrl = decodeLink(universal);
// 本机联调：anvil 不在页面上，需要显式指 RPC（真机上由钱包或公共 RPC 提供）
const localUrl = innerUrl.replace(
  /#/, "?rpc=" + encodeURIComponent(RPC) + "#");

console.log(`
────────────────────────────────────────────
本地换机恢复联调环境已就绪
────────────────────────────────────────────
owner:      ${OWNER}
助记词:     ${MNEMONIC}
inner 页面: ${innerUrl}
本机可开:   ${localUrl}
文件目录:   ${outDir}
────────────────────────────────────────────
`);
