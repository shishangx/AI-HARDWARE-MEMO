/*
 * 端到端验证 P0 闭环: 设备产出摘要 → 编码 → 提交上链 → 按 owner 读回。
 *
 * 为什么值得跑: 这条链路上每个环节都可能"静默错误" —— 编码错、事件过滤错、
 * 页码语义错, 都不会报错, 只会让链上数据不可用。所以用本地 anvil 真跑一遍,
 * 而不是只看代码。
 *
 * 覆盖:
 *   1. 合约部署
 *   2. 载荷生成 (走真实的 make_payload.py, 而非在测试里重造)
 *   3. 设备加密 -> 页面解密 (跨语言, 真实管线)
 *   4. 链接解析回载荷 (验证编解码往返一致)
 *   5. ABI 编码并被节点接受
 *   6. eth_sendTransaction 模拟页面提交
 *   7. eth_getLogs 按 owner 过滤枚举  ← 换机恢复的读取路径
 *   8. entriesOf 读回内容             ← 换机恢复的数据路径
 *   9. 密文走 calldata 的写入与取回    ← 不依赖外部存储网络
 *
 * 用法: node tools/e2e.mjs
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
const MemoCrypto = require(join(ROOT, "app", "crypto.js"));

// 用独立端口, 避免与本机其它 anvil (如 lan.sh 起的 8545) 冲突。
// 曾经因为发到了别人那条链上而出现"交易成功但读不到记录"的假失败。
const PORT = Number(process.env.E2E_PORT || 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
// anvil 的确定性账户
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PRIVKEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MEMO_TOPIC =
  "0x07c5c30e8a037ab40cf9ef366a98de4ba42517817c594ce24d2f585917a5d4ba";

let anvil;
let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deploy() {
  const out = execFileSync("forge", [
    "create", "src/MemoryRegistry.sol:MemoryRegistry",
    "--rpc-url", RPC, "--private-key", PRIVKEY, "--broadcast",
  ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error("无法解析部署地址:\n" + out);
  return m[1];
}

/** 从 Universal Link 反解出载荷 —— 同时验证编解码往返 */
function decodeLink(link) {
  const q = new URL(link).searchParams.get("url");
  const hashIdx = q.indexOf("#p=");
  if (hashIdx < 0) throw new Error("链接中缺少 fragment");
  const b64 = q.slice(hashIdx + 3);
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(s + "=".repeat((4 - s.length % 4) % 4), "base64").toString("utf8"));
}

async function main() {
  console.log(`启动本地 EVM (anvil, 端口 ${PORT})…`);
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  if (!await waitForRpc()) throw new Error("anvil 未就绪");

  // 1) 部署
  const contract = deploy();
  console.log(`合约已部署: ${contract}\n`);
  check("合约部署成功", /^0x[0-9a-fA-F]{40}$/.test(contract));

  // 2) 造一个"录音"文件, 走真实的载荷生成器
  const work = mkdtempSync(join(tmpdir(), "memo-e2e-"));
  const recDir = join(work, "recordings");
  mkdirSync(recDir, { recursive: true });
  const recA = join(recDir, "20260921-101500.wav");
  const recB = join(recDir, "20260921-102000.wav");
  writeFileSync(recA, Buffer.from("伪造音频内容 A".repeat(200)));
  writeFileSync(recB, Buffer.from("伪造音频内容 B".repeat(300)));

  const linkFile = join(work, "link.txt");
  const blobsFile = join(work, "blobs.json");
  // 设备侧的密钥来源：助记词 → KEK。设备与页面走的是同一条路，
  // 因此"设备能加密"与"换机后能解密"由同一段代码保证。
  const MNEMONIC = "abandon abandon abandon abandon abandon abandon "
    + "abandon abandon abandon abandon abandon about";
  const kek = await MemoCrypto.kekFromMnemonic(MNEMONIC);
  execFileSync("python3", [
    join(HERE, "make_payload.py"),
    "--contract", contract, "--chain-id", String(CHAIN_ID), "--rpc", RPC,
    "--mnemonic", MNEMONIC,
    "--file", recA, "--file", recB,
    "--out", linkFile, "--blobs-out", blobsFile,
  ], { encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

  const link = execFileSync("cat", [linkFile], { encoding: "utf8" }).trim();
  check("生成 Universal Link", link.startsWith("https://connect.token.im/link/navigate/DappView?url="),
    link.slice(0, 80));

  // 3) 链接 -> 载荷
  const payload = decodeLink(link);
  check("链接可反解出载荷", payload.v === 1 && payload.records.length === 2,
    `records=${payload.records && payload.records.length}`);
  check("载荷中的合约地址一致", payload.contract === contract);

  // 3b) 加密断言：摘要必须**不等于**明文摘要，否则说明加密没生效
  const crypto = await import("node:crypto");
  const plainHash = "0x" + crypto.createHash("sha256").update(readFileSync(recA)).digest("hex");
  check("上链摘要对应密文而非明文（加密已生效）", payload.records[0].h !== plainHash,
    `载荷=${payload.records[0].h}`);
  check("载荷中不含 wrappedKey（避免二维码过密）", !("k" in payload.records[0]));

  // 3c) 设备加密 -> 页面解密。这是"明文不出设备"能否成立的核心验证。
  const blobs = JSON.parse(readFileSync(blobsFile, "utf8"));
  check("密文 sidecar 覆盖全部记录", blobs.length === 2, `blobs=${blobs.length}`);
  const devPlain = await MemoCrypto.decryptRecord(
    MemoCrypto.unhex(blobs[0].blob), kek, payload.records[0].t);
  check("页面侧能解开设备加密的密文（换机恢复的密钥路径成立）",
    Buffer.from(devPlain).toString("utf8") === readFileSync(recA).toString("utf8"),
    `得到 ${devPlain.length} 字节`);
  check("密文摘要与 blob 实际字节一致",
    payload.records[0].h === MemoCrypto.hex(await MemoCrypto.sha256(MemoCrypto.unhex(blobs[0].blob))));

  // 密钥边界：链上密文只认这一份助记词。量子对手能从公钥恢复私钥，但种子→私钥
  // 是单向的，拿不回种子 —— 因此换一份助记词（等价于"拿到了钱包但没有助记词"）
  // 必须打不开。这条链上一个公钥密码环节都没有，所以那类攻击没有落点。
  const wrongKek = await MemoCrypto.kekFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow");
  let wrongMnemonicOpened = false;
  try {
    await MemoCrypto.decryptRecord(MemoCrypto.unhex(blobs[0].blob), wrongKek, payload.records[0].t);
    wrongMnemonicOpened = true;
  } catch { /* 预期：解不开 */ }
  check("换一份助记词无法解开链上密文", !wrongMnemonicOpened);

  // 4) 编码。载荷用紧凑字段(h/c), 提交前需展开成合约的完整字段 ——
  //    这一步由页面上的 expandRecords 完成, 此处等价复现, 以保证测的是真实路径。
  const ZERO32 = "0x" + "00".repeat(32);
  const full = payload.records.map((r) => ({
    timestamp: r.t, contentHash: r.h, cid: r.c,
    tagHash: r.g || ZERO32, wrappedKey: r.k || ZERO32,
  }));
  const data = MinABI.encodeAddBatch(full);
  check("编码出调用数据", data.startsWith("0x2709cfbb"), data.slice(0, 12));

  // 5) 模拟页面提交
  const txHash = await rpc("eth_sendTransaction", [{
    from: OWNER, to: contract, data, gas: "0x" + (3000000).toString(16),
  }]);
  // 回执需要轮询: 刚发完就查常拿到 null, 会造成假失败
  let receipt = null;
  for (let i = 0; i < 40 && !receipt; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (!receipt) await sleep(100);
  }
  check("交易被节点接受并上链", receipt && receipt.status === "0x1",
    `status=${receipt && receipt.status}`);

  // 6) 按 owner 过滤事件 —— 换机恢复的读取路径
  const logs = await rpc("eth_getLogs", [{
    fromBlock: "0x0", toBlock: "latest", address: contract,
    topics: [MEMO_TOPIC, "0x" + OWNER.slice(2).toLowerCase().padStart(64, "0")],
  }]);
  check("按 owner 能枚举到全部记录", logs.length === 2, `logs=${logs.length}`);
  check("事件序号从 0 连续递增",
    logs.length === 2 &&
    BigInt(logs[0].topics[2]) === 0n && BigInt(logs[1].topics[2]) === 1n,
    logs.map((l) => l.topics[2]).join(","));

  // 7) 读回内容 —— 换机恢复的数据路径
  const raw = execFileSync("cast", [
    "call", contract,
    "entriesOf(address,uint256,uint256)((uint64,bytes32,string,bytes32,bytes)[])",
    OWNER, "0", "10", "--rpc-url", RPC,
  ], { cwd: ROOT, encoding: "utf8" });
  const recovered = String(raw).trim();
  check("entriesOf 能读回两条", recovered.includes('"chain"')
    && (recovered.match(/"chain"/g) || []).length === 2,
    recovered.slice(0, 120));
  check("读回的摘要与提交的一致",
    recovered.includes(payload.records[0].h.slice(2))
    && recovered.includes(payload.records[1].h.slice(2)),
    "摘要未出现在读回结果中");

  // 8) 越界读取必须安全返回, 不回滚 —— 否则恢复流程会在最后一条卡住
  let oobOk = true;
  try {
    execFileSync("cast", [
      "call", contract, "entriesOf(address,uint256,uint256)((uint64,bytes32,string,bytes32,bytes)[])",
      OWNER, "99", "10", "--rpc-url", RPC,
    ], { cwd: ROOT, encoding: "utf8" });
  } catch { oobOk = false; }
  check("越界读取返回空而非回滚", oobOk);

  // 9) 密文随 calldata 上链的方案: 走通"写入 → 从链上取回 → 切片还原"
  //    这条路径的价值在于密文只存在于交易里, 因此切片规则一旦错位,
  //    还原出来的是错的数据而且不会报错 —— 必须端到端验证。
  const secrets = ["deadbeef".repeat(8), "0a1b2c3d".repeat(40), "ff".repeat(3)];
  const totalBytes = secrets.reduce((a, s) => a + s.length / 2, 0);
  const entries = secrets.map((s, i) => ({
    timestamp: 1700000000 + i,
    contentHash: "0x" + crypto.createHash("sha256").update("h" + i).digest("hex"),
    payloadHex: "0x" + s,
  }));
  const enc = MinABI.encodeAddBatchOnchain(entries);

  const tx2 = await rpc("eth_sendTransaction", [{
    from: OWNER, to: contract, data: enc.data,
    gas: "0x" + (4000000).toString(16),
  }]);
  let rc2 = null;
  for (let i = 0; i < 40 && !rc2; i++) {
    rc2 = await rpc("eth_getTransactionReceipt", [tx2]);
    if (!rc2) await sleep(100);
  }
  check("密文上链交易成功", rc2 && rc2.status === "0x1", `status=${rc2 && rc2.status}`);

  // 恢复路径: 事件 → txHash → 交易 → 切片
  const topic2 = "0x433330c264aec22fa879cb44629ba5271a2248e87a5d9f461afd45538b6fdbf8";
  const logs2 = await rpc("eth_getLogs", [{
    fromBlock: "0x0", toBlock: "latest", address: contract,
    topics: [topic2, "0x" + OWNER.slice(2).toLowerCase().padStart(64, "0")],
  }]);
  check("能枚举到 MemoOnchain 事件", logs2.length === secrets.length,
    `logs=${logs2.length} 期望=${secrets.length}`);

  // 事件里的 offset/length 是 calldata 内的相对位置, 都应落在 blob 内
  const sizesFromLogs = logs2.map((l) => {
    const body = l.data.replace(/^0x/, "");
    // 非 indexed 字段: timestamp, contentHash, blobOffset, byteLength
    return {
      off: parseInt(body.substr(128, 64), 16),
      len: parseInt(body.substr(192, 64), 16),
    };
  });
  check("事件中的 offset/length 自洽",
    sizesFromLogs.reduce((a, x) => a + x.len, 0) === totalBytes,
    JSON.stringify(sizesFromLogs));

  // 关键一步: 从真实交易里取回密文
  const tx = await rpc("eth_getTransactionByHash", [tx2]);
  check("可取回交易原始 calldata", !!(tx && tx.input && tx.input.length > 100),
    `input 长度=${tx && tx.input && tx.input.length}`);

  let restored = null;
  try {
    restored = MinABI.extractBlobs(tx.input, sizesFromLogs.map((s) => s.len));
  } catch (e) {
    check("切片还原密文", false, e.message);
  }
  if (restored) {
    const want = entries.map((e) => e.payloadHex.toLowerCase());
    const same = restored.length === want.length &&
      restored.every((b, i) => b.toLowerCase() === want[i]);
    check("切片还原的密文与原文逐字节一致", same,
      same ? "" : `\n      得到 ${JSON.stringify(restored.map((r) => r.slice(0, 20)))}` +
                 `\n      期望 ${JSON.stringify(want.map((r) => r.slice(0, 20)))}`);

    // 事件里的相对偏移应是各段起点, 与长度一起自洽
    let cum = 0;
    const offsetsOk = sizesFromLogs.every((s, i) =>
      s.off === cum && s.len === secrets[i].length / 2 && (cum += s.len) >= 0);
    check("事件记录的偏移与长度自洽", offsetsOk, JSON.stringify(sizesFromLogs));
  }

  console.log();
  if (failed === 0) {
    console.log(`换机恢复验证: 新设备凭 owner 地址即可枚举并读回全部 ${logs.length} 条记录；`);
    console.log(`密文路径: 事件 → txHash → 交易 calldata → 切片, 共 ${secrets.length} 段全部还原一致。`);
  }
  console.log(`${passed}/${passed + failed} 通过`);
}

try {
  await main();
} catch (e) {
  console.error("\n执行失败: " + e.message);
  failed++;
} finally {
  if (anvil) anvil.kill("SIGTERM");
  process.exit(failed ? 1 : 0);
}
