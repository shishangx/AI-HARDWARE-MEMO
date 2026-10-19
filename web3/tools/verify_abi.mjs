/*
 * 用 cast 逐字节校验手写 ABI 编码器。
 *
 * 手写 ABI 编码最危险的失败模式是"编码出合法但错误的字节" —— 交易能上链、
 * 状态被写坏, 却不会报错。因此必须与权威实现 (solc 生成的 ABI 编码) 对比。
 * 这里用 `cast calldata` 作为参照, 逐字节比对。
 *
 * 用法: node tools/verify_abi.mjs
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MinABI = require(join(HERE, "..", "app", "abi.js"));

const SIG = "addBatch(uint64[],bytes32[],string[],bytes32[],bytes[])";

// 覆盖边界: 空字符串、非 32 字节倍数、多字节 UTF-8、单条与多条
const CASES = [
  {
    name: "单条 · 简单值",
    entries: [{
      timestamp: 1700000000,
      contentHash: "0x" + "11".repeat(32),
      cid: "ar://abc",
      tagHash: "0x" + "22".repeat(32),
      wrappedKey: "0xdeadbeef",
    }],
  },
  {
    name: "单条 · 恰好 32 字节字符串",
    entries: [{
      timestamp: 1,
      contentHash: "0x" + "00".repeat(32),
      cid: "x".repeat(32),
      tagHash: "0x" + "ff".repeat(32),
      wrappedKey: "0x" + "aa".repeat(32),
    }],
  },
  {
    name: "单条 · 空字符串与空字节",
    entries: [{
      timestamp: 0,
      contentHash: "0x" + "ab".repeat(32),
      cid: "",
      tagHash: "0x" + "cd".repeat(32),
      wrappedKey: "",
    }],
  },
  {
    name: "单条 · 多字节 UTF-8 (中文)",
    entries: [{
      timestamp: 1700000001,
      contentHash: "0x" + "0f".repeat(32),
      cid: "ar://记忆片段-01",
      tagHash: "0x" + "1f".repeat(32),
      wrappedKey: "0x0102030405",
    }],
  },
  {
    name: "多条 · 长度不一 (含 33 字节跨界)",
    entries: [
      { timestamp: 100, contentHash: "0x" + "01".repeat(32), cid: "a",
        tagHash: "0x" + "02".repeat(32), wrappedKey: "0x01" },
      { timestamp: 200, contentHash: "0x" + "03".repeat(32), cid: "b".repeat(33),
        tagHash: "0x" + "04".repeat(32), wrappedKey: "0x" + "05".repeat(40) },
      { timestamp: 300, contentHash: "0x" + "06".repeat(32), cid: "中文标签",
        tagHash: "0x" + "07".repeat(32), wrappedKey: "0x" },
    ],
  },
];

function castCalldata(entries) {
  const ts = "[" + entries.map((e) => e.timestamp).join(",") + "]";
  const hashes = "[" + entries.map((e) => e.contentHash).join(",") + "]";
  // 字符串元素必须显式加引号: 否则单个空串会被 cast 解析成"零元素数组",
  // 而不是"含一个空串的数组", 二者长度不同。
  const cids = "[" + entries.map((e) => JSON.stringify(e.cid)).join(",") + "]";
  const tags = "[" + entries.map((e) => e.tagHash).join(",") + "]";
  // 空 bytes 用 0x 表示, 同理避免被当成零元素数组
  const keys = "[" + entries.map((e) => (e.wrappedKey || "0x")).join(",") + "]";
  return execFileSync("cast", ["calldata", SIG, ts, hashes, cids, tags, keys],
    { encoding: "utf8" }).trim();
}

let failed = 0;
for (const c of CASES) {
  const mine = MinABI.encodeAddBatch(c.entries);
  const ref = castCalldata(c.entries);
  const ok = mine === ref;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    console.log(`  自身: ${mine}`);
    console.log(`  cast: ${ref}`);
    // 定位首个不同字节
    for (let i = 0; i < Math.max(mine.length, ref.length); i++) {
      if (mine[i] !== ref[i]) {
        console.log(`  首个差异在第 ${i} 个字符 (字节偏移 ${Math.floor((i - 2) / 2)}): ` +
          `自身=${mine.slice(i, i + 16)} cast=${ref.slice(i, i + 16)}`);
        break;
      }
    }
  }
}

// ---- addBatchOnchain: 编码 + 切片往返 ----
// 这条路径的价值在于"密文只存在于 calldata", 因此切片必须与 cast 编码严格一致,
// 否则恢复出来的密文是错的, 而且不会报错 —— 只能靠校验发现。
const SIG2 = "addBatchOnchain(uint64[],bytes32[],uint32[],bytes)";

function castCalldataOnchain(entries) {
  const ts = "[" + entries.map((e) => e.timestamp).join(",") + "]";
  const hs = "[" + entries.map((e) => e.contentHash).join(",") + "]";
  const lens = "[" + entries.map((e) => (e.payloadHex.length - 2) / 2).join(",") + "]";
  const blob = "0x" + entries.map((e) => e.payloadHex.replace(/^0x/, "")).join("");
  return execFileSync("cast", ["calldata", SIG2, ts, hs, lens, blob],
    { encoding: "utf8" }).trim();
}

const ONCHAIN_CASES = [
  {
    name: "onchain · 单条",
    entries: [{ timestamp: 1700000000, contentHash: "0x" + "aa".repeat(32),
                payloadHex: "0x" + "11".repeat(100) }],
  },
  {
    name: "onchain · 三条不等长",
    entries: [
      { timestamp: 1, contentHash: "0x" + "01".repeat(32), payloadHex: "0x" + "22".repeat(7) },
      { timestamp: 2, contentHash: "0x" + "02".repeat(32), payloadHex: "0x" + "33".repeat(64) },
      { timestamp: 3, contentHash: "0x" + "03".repeat(32), payloadHex: "0x" + "44".repeat(1) },
    ],
  },
];

for (const c of ONCHAIN_CASES) {
  const mine = MinABI.encodeAddBatchOnchain(c.entries).data;
  const ref = castCalldataOnchain(c.entries);
  let ok = mine === ref;
  let note = "";
  if (ok) {
    // 再用切片函数还原, 验证往返一致
    const enc = MinABI.encodeAddBatchOnchain(c.entries);
    const back = MinABI.extractBlobs(mine, enc.sizes);
    const want = c.entries.map((e) => e.payloadHex.toLowerCase());
    ok = back.length === want.length && back.every((b, i) => b === want[i]);
    note = ok ? "（切片往返一致）" : "（切片结果不符）";
  }
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name} ${note}`);
  if (!ok && mine !== ref) {
    for (let i = 0; i < Math.max(mine.length, ref.length); i++) {
      if (mine[i] !== ref[i]) {
        console.log(`  首个差异在第 ${i} 个字符: 自身=${mine.slice(i, i + 16)} cast=${ref.slice(i, i + 16)}`);
        break;
      }
    }
  }
}

// ---- 恢复索引只读方法：calldata 与动态 uint64[] 解码 ----
const INDEX_OWNER = "0x1234567890abcdef1234567890abcdef12345678";
const countMine = MinABI.encodeOnchainBatchCount(INDEX_OWNER);
const countRef = execFileSync("cast", ["calldata", "onchainBatchCount(address)", INDEX_OWNER],
  { encoding: "utf8" }).trim();
let indexCountOk = countMine === countRef;
if (!indexCountOk) failed++;
console.log(`${indexCountOk ? "PASS" : "FAIL"}  index · count calldata`);

const pageMine = MinABI.encodeOnchainBatchBlocksOf(INDEX_OWNER, 12, 100);
const pageRef = execFileSync("cast", ["calldata", "onchainBatchBlocksOf(address,uint256,uint256)",
  INDEX_OWNER, "12", "100"], { encoding: "utf8" }).trim();
let indexPageOk = pageMine === pageRef;
if (!indexPageOk) failed++;
console.log(`${indexPageOk ? "PASS" : "FAIL"}  index · page calldata`);

const encodedCount = execFileSync("cast", ["abi-encode", "f(uint256)", "3"],
  { encoding: "utf8" }).trim();
let decodeCountOk = MinABI.decodeUint(encodedCount) === 3;
if (!decodeCountOk) failed++;
console.log(`${decodeCountOk ? "PASS" : "FAIL"}  index · decode count`);

const encodedBlocks = execFileSync("cast", ["abi-encode", "f(uint64[])", "[1000,1200,1200]"],
  { encoding: "utf8" }).trim();
const decodedBlocks = MinABI.decodeUint64Array(encodedBlocks);
let decodeBlocksOk = JSON.stringify(decodedBlocks) === JSON.stringify([1000, 1200, 1200]);
if (!decodeBlocksOk) failed++;
console.log(`${decodeBlocksOk ? "PASS" : "FAIL"}  index · decode block page`);

const total = CASES.length + ONCHAIN_CASES.length + 4;
console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed ? 1 : 0);
