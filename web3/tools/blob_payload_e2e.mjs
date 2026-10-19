/*
 * 验证"密文进载荷 → 页面 addBatchOnchain 提交 → 换机恢复解密"的新闭环。
 *
 * 背景：真实用户钱包提交后无法恢复 —— 页面提交走存储版占位，密文从没上过链。
 * 本脚本验证修复：make_payload --blob-in-payload 把小录音密文塞进二维码载荷，
 * 页面据此改走 addBatchOnchain（这里用 anvil 账户等价模拟"钱包签名"），
 * 随后走与页面完全一致的恢复逻辑解密。
 *
 * 用法: node tools/blob_payload_e2e.mjs   （自起 anvil 于 8548）
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MinABI = require(join(ROOT, "app", "abi.js"));
const MemoCrypto = require(join(ROOT, "app", "crypto.js"));

const RPC = "http://127.0.0.1:8548";
const CHAIN_ID = 31337;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon about";
const PAGE_URL = "https://ai-hardware-gamma.vercel.app/";
const MEMO_ONCHAIN_TOPIC =
  "0x433330c264aec22fa879cb44629ba5271a2248e87a5d9f461afd45538b6fdbf8";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const deploy = () => {
  const out = execFileSync("forge", [
    "create", "src/MemoryRegistry.sol:MemoryRegistry",
    "--rpc-url", RPC, "--private-key",
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "--broadcast",
  ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)[1];
};

const anvil = spawn("anvil", ["--port", "8548", "--silent"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

try {
  const contract = deploy();
  check("合约部署", /^0x[0-9a-fA-F]{40}$/.test(contract));

  // 小录音（约 1.2KB）—— 单帧二维码能装下
  const work = mkdtempSync("/tmp/blob-e2e-");
  mkdirSync(work + "/rec");
  const rec = work + "/rec/short.wav";
  writeFileSync(rec, Buffer.from("小录音密文进载荷验证 · ABCDEFGHIJ".repeat(8)));
  const plainText = readFileSync2(rec);
  check("小录音已生成（<2.5KB）", sizeOf(rec) < 2500, `${sizeOf(rec)}B`);

  // 设备路径：密文进载荷
  const linkFile = work + "/link.txt";
  execFileSync("python3", [
    join(HERE, "make_payload.py"),
    "--contract", contract, "--chain-id", String(CHAIN_ID), "--rpc", RPC,
    "--mnemonic", MNEMONIC, "--blob-in-payload",
    "--file", rec, "--out", linkFile,
  ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

  // 反解载荷（等价于页面 b64urlDecode）
  const inner = decodeURIComponent(
    new URL(readFileSync2(linkFile, "utf8")).searchParams.get("url"));
  const frag = inner.slice(inner.indexOf("#p=") + 3);
  const b64 = frag.replace(/-/g, "+").replace(/_/g, "/");
  const payload = JSON.parse(Buffer.from(
    b64 + "=".repeat((4 - b64.length % 4) % 4), "base64").toString("utf8"));
  check("载荷携带密文", payload.records.length === 1 &&
    typeof payload.records[0].b === "string" && payload.records[0].b.length > 100);

  // 页面提交路径：先把二维码短字段展开，再走页面的统一可恢复编码入口。
  // 这里曾因展开后字段叫 blob、提交代码却检查 r.b，而静默走到不可恢复的旧接口。
  const entries = payload.records.map((r) => ({
    timestamp: r.t, contentHash: r.h, blob: r.b,
  }));
  const data = MinABI.encodeRecoverableBatch(entries);
  check("页面选择带密文接口", data.slice(0, 10) === "0x" + MinABI.ADD_ONCHAIN_SELECTOR);
  let missingBlobBlocked = false;
  try {
    MinABI.encodeRecoverableBatch([{ timestamp: 1,
      contentHash: "0x" + "00".repeat(32), blob: "" }]);
  } catch (e) {
    missingBlobBlocked = /不含链上密文/.test(e.message);
  }
  check("缺少密文时阻止不可恢复提交", missingBlobBlocked);
  const txHash = await rpc("eth_sendTransaction", [{
    from: OWNER, to: contract, data,
    gas: "0x" + (4000000).toString(16),
  }]);
  let receipt = null;
  for (let i = 0; i < 40 && !receipt; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (!receipt) await sleep(100);
  }
  check("带密文提交上链成功", receipt && receipt.status === "0x1");

  // 页面恢复路径：枚举 → 切片 → 摘要 → 解密
  const logs = await rpc("eth_getLogs", [{
    fromBlock: "0x0", toBlock: "latest", address: contract,
    topics: [MEMO_ONCHAIN_TOPIC,
      "0x" + OWNER.slice(2).toLowerCase().padStart(64, "0")],
  }]);
  check("恢复页能枚举到（MemoOnchain）", logs.length === 1, `logs=${logs.length}`);

  const ev = logs[0];
  const body = ev.data.replace(/^0x/, "");
  const timestamp = Number(BigInt("0x" + body.substr(0, 64)));
  const contentHash = "0x" + body.substr(64, 64);
  const byteLength = Number(BigInt("0x" + body.substr(192, 64)));
  const tx = await rpc("eth_getTransactionByHash", [ev.transactionHash]);
  const blobs = MinABI.extractBlobs(tx.input, [byteLength]);
  const blob = MemoCrypto.unhex(blobs[0]);
  const digest = MemoCrypto.hex(await MemoCrypto.sha256(blob));
  check("切片摘要与链上一致", digest === contentHash);
  const kek = await MemoCrypto.kekFromMnemonic(MNEMONIC);
  const plain = await MemoCrypto.decryptRecord(blob, kek, timestamp);
  check("用助记词解出原文（页面同一路径）",
    Buffer.from(plain).toString("utf8") === readFileSync2(rec, "utf8"));

  console.log(`\n${passed}/${passed + failed} 通过`);
} finally {
  anvil.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);

// ---- helpers ----
import { readFileSync as _rf, statSync as _ss } from "node:fs";
function readFileSync2(p, enc) { return _rf(p, enc); }
function sizeOf(p) { return _ss(p).size; }
