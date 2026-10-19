/*
 * 换机恢复的端到端验证：设备加密上链 → 换一台设备 / 只拿手机，仅凭助记词把内容解回来。
 *
 * 为什么单独一个测试：这是本轮需求的核心，也是"防丢失"叙事的验收标准。
 * e2e.mjs 验的是"写入与枚举"，这里验的是**解密**——而解密恰好是最容易
 * "看起来完成了、实际解不开"的一环（设备与页面各算一套密钥也照样各自自洽）。
 *
 * 恢复方的输入只有两样：**助记词**，以及链上公开的东西。没有钱包参与、没有签名、
 * 没有设备参与。这一点是设计的关键：能加密的与能解密的走的是同一条派生路，
 * 因此不需要在设备与手机之间交换任何密钥材料。
 *
 * 覆盖：
 *   1. 设备侧用助记词派生的 KEK 加密 3 条记录，密文随 calldata 上链
 *   2. 恢复侧仅凭助记词重新派生 KEK（不复用设备侧的中间结果）
 *   3. eth_getLogs 按 owner 枚举 → 按 seq 排序并校验连续性
 *   4. 事件 → txHash → 交易 calldata → 按偏移切片还原密文
 *   5. SHA-256(密文) 与链上 contentHash 逐字节核对  ← 不可信中继模型成立的前提
 *   6. 逐条解密并与原始明文比对
 *   7. 失败路径：换一份助记词、密文被篡改、记录被重复、别人的记录不能混进来
 *
 * 用法: node tools/recovery_e2e.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PY_DIR = join(HERE, "..", "..", "lab", "crypto");
const MinABI = require(join(ROOT, "app", "abi.js"));
const MemoCrypto = require(join(ROOT, "app", "crypto.js"));

// 独立端口，避免与本机其它 anvil（8545 被 lan.sh 占用、8546 是 e2e）撞车
const PORT = Number(process.env.RECOVERY_PORT || 8547);
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PRIVKEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// keccak256("MemoOnchain(address,uint256,uint64,bytes32,uint256,uint256)")
const TOPIC_MEMO_ONCHAIN =
  "0x433330c264aec22fa879cb44629ba5271a2248e87a5d9f461afd45538b6fdbf8";

// BIP-39 官方向量：抄写不会抄错，因此测试里可以安全地当常量用
const MNEMONIC = "abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon about";
const WRONG_MNEMONIC = "legal winner thank year wave sausage worth useful "
  + "legal winner thank yellow";

const RECORDINGS = [
  { ts: 1758500000, text: "周一：把 BOM 报价发给供应链，MOQ 是 500" },
  { ts: 1758503600, text: "周二：和张总确认样机外壳的手感，他要哑光" },
  { ts: 1758507200, text: "周三：换机恢复这条链路要先跑通，再谈硬件" },
];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRpc(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await rpc("eth_chainId"); return true; } catch { await sleep(200); }
  }
  return false;
}

async function waitReceipt(txHash) {
  for (let i = 0; i < 40; i++) {
    const r = await rpc("eth_getTransactionReceipt", [txHash]);
    if (r) return r;
    await sleep(100);
  }
  return null;
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

/** 把一条 MemoOnchain 日志解成恢复端需要的字段。 */
function parseOnchainLog(log) {
  const body = log.data.replace(/^0x/, "");
  return {
    txHash: log.transactionHash,
    owner: "0x" + log.topics[1].slice(26),
    seq: Number(BigInt(log.topics[2])),
    timestamp: Number(BigInt("0x" + body.substr(0, 64))),
    contentHash: "0x" + body.substr(64, 64),
    blobOffset: Number(BigInt("0x" + body.substr(128, 64))),
    byteLength: Number(BigInt("0x" + body.substr(192, 64))),
  };
}

/**
 * 恢复端完整流程：只有 mnemonic 与 owner 两个输入。
 * 刻意写成"只吃助记词"，好让"恢复不需要钱包/设备"这件事在代码里就是显然的。
 */
async function recoverAll({ mnemonic, contract, owner }) {
  const kek = await MemoCrypto.kekFromMnemonic(mnemonic);
  const ethCall = (data) => rpc("eth_call", [{ to: contract, data }, "latest"]);
  const total = MinABI.decodeUint(await ethCall(MinABI.encodeOnchainBatchCount(owner)));
  const blocks = [];
  for (let offset = 0; offset < total;) {
    const page = MinABI.decodeUint64Array(await ethCall(
      MinABI.encodeOnchainBatchBlocksOf(owner, offset, Math.min(100, total - offset))
    ));
    if (!page.length) throw new Error("合约批次区块索引提前结束");
    blocks.push(...page);
    offset += page.length;
  }

  const uniqueBlocks = [...new Set(blocks)].sort((a, b) => a - b);
  const logs = [];
  const topicOwner = "0x" + owner.slice(2).toLowerCase().padStart(64, "0");
  for (const block of uniqueBlocks) {
    const blockHex = "0x" + block.toString(16);
    logs.push(...await rpc("eth_getLogs", [{
      fromBlock: blockHex, toBlock: blockHex, address: contract,
      topics: [TOPIC_MEMO_ONCHAIN, topicOwner],
    }]));
  }
  const parsed = logs.map(parseOnchainLog);
  parsed.sort((a, b) => a.seq - b.seq);

  // 切片必须按 txHash 分组：事件里的 seq 是**全局**序号, 而 calldata 里的 blob
  // 只存在于自己那一笔交易。曾用全局 seq 索引单笔交易的 blob 数组 —— 单笔提交
  // 的测试永远测不出, 多笔提交后第二笔起的记录全部"摘要不一致被拒"。
  // 组内按 blobOffset 排序, 与 extractBlobs 的切分顺序一一对应。
  const byTx = new Map();
  const out = [];

  for (const r of parsed) {
    const rec = { seq: r.seq, timestamp: r.timestamp, hashOk: null, plain: null, err: null };
    try {
      if (!byTx.has(r.txHash)) {
        const tx = await rpc("eth_getTransactionByHash", [r.txHash]);
        if (!tx || !tx.input) throw new Error("取不回交易 calldata");
        byTx.set(r.txHash, { input: tx.input, events: [] });
      }
      const g = byTx.get(r.txHash);
      g.events.push(r);
      g.events.sort((a, b) => a.blobOffset - b.blobOffset);
      const blobs = MinABI.extractBlobs(g.input, g.events.map((e) => e.byteLength));
      const blob = MemoCrypto.unhex(blobs[g.events.indexOf(r)]);

      // 完整性校验必须发生在解密之前：链上 contentHash 是可信锚点，
      // 有了它，中继即便被劫持也只能"查不到"，无法塞入伪造内容
      rec.hashOk = MemoCrypto.hex(await MemoCrypto.sha256(blob)) === r.contentHash;
      if (!rec.hashOk) throw new Error("内容摘要与链上不一致");

      const plain = await MemoCrypto.decryptRecord(blob, kek, r.timestamp);
      rec.plain = Buffer.from(plain).toString("utf8");
    } catch (e) {
      rec.err = e.message;
    }
    out.push(rec);
  }
  return {
    records: out,
    continuous: seqsContinuous(out.map((r) => r.seq)),
    logCount: parsed.length,
    indexedBatchCount: total,
    queriedBlockCount: uniqueBlocks.length,
  };
}

/** seq 必须从 0 连续：断号或重复说明枚举结果被过滤或改写过，恢复端要能看出来。 */
function seqsContinuous(seqs) {
  return seqs.every((s, i) => s === i);
}

/** 设备侧：用真实设备实现（Python 管线）加密。 */
function deviceEncrypt(mnemonic, recordings) {
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import pipeline as P
kek = P.kek_from_mnemonic(${JSON.stringify(mnemonic)})
recs = []
for r in ${JSON.stringify(recordings)}:
    enc = P.encrypt_record(r["text"].encode("utf-8"), kek, r["ts"])
    recs.append({"ts": r["ts"], "hash": enc["contentHash"], "blob": enc["blob"].hex()})
print(json.dumps({"fp": P.kek_fingerprint(kek), "records": recs}))
`;
  const out = execFileSync("python3", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: PY_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

async function main() {
  console.log(`启动本地 EVM (anvil, 端口 ${PORT})…`);
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  if (!await waitForRpc()) throw new Error("anvil 未就绪");

  const contract = deploy();
  console.log(`合约已部署: ${contract}\n`);

  // ---------------------------------------------------------- 旧设备：加密
  console.log("【旧设备】用助记词派生的 KEK 加密 3 条录音");
  const dev = deviceEncrypt(MNEMONIC, RECORDINGS);
  check("设备侧产出 3 条密文", dev.records.length === 3);

  // 页面侧独立算一遍指纹：这是配对时可以拿去和设备屏幕比对的同一个值
  const pageKek = await MemoCrypto.kekFromMnemonic(MNEMONIC);
  check("设备与页面派生出同一把 KEK（配对校验通过）",
    (await MemoCrypto.kekFingerprint(pageKek)) === dev.fp, dev.fp);

  // --------------------------------------------------------------- 上链
  const entries = dev.records.map((r) => ({
    timestamp: r.ts,
    contentHash: r.hash,
    payloadHex: "0x" + r.blob,
  }));
  const enc = MinABI.encodeAddBatchOnchain(entries);
  const tx = await rpc("eth_sendTransaction", [{
    from: OWNER, to: contract, data: enc.data, gas: "0x" + (4000000).toString(16),
  }]);
  const rc = await waitReceipt(tx);
  check("密文随 calldata 上链成功", rc && rc.status === "0x1", `status=${rc && rc.status}`);

  // 另一个人也写一批 —— 用来验证恢复不会把别人的记录混进来
  const other = deviceEncrypt(WRONG_MNEMONIC, [RECORDINGS[0]]);
  const enc2 = MinABI.encodeAddBatchOnchain([{
    timestamp: other.records[0].ts,
    contentHash: other.records[0].hash,
    payloadHex: "0x" + other.records[0].blob,
  }]);
  const tx2 = await rpc("eth_sendTransaction", [{
    from: OTHER_OWNER, to: contract, data: enc2.data, gas: "0x" + (4000000).toString(16),
  }]);
  await waitReceipt(tx2);

  // 同一个 owner 再提交**第二笔** —— 真实使用必然是多笔提交（设备多次同步）。
  // 这是为了守住"切片按 txHash 分组"的规则：seq 是全局序号，blob 索引是交易内序号。
  const dev2 = deviceEncrypt(MNEMONIC, [RECORDINGS[0], RECORDINGS[1]]);
  const enc3 = MinABI.encodeAddBatchOnchain(dev2.records.map((r) => ({
    timestamp: r.ts, contentHash: r.hash, payloadHex: "0x" + r.blob,
  })));
  const tx3 = await rpc("eth_sendTransaction", [{
    from: OWNER, to: contract, data: enc3.data, gas: "0x" + (4000000).toString(16),
  }]);
  const rc3 = await waitReceipt(tx3);
  check("多笔提交：第二笔上链成功", rc3 && rc3.status === "0x1", `status=${rc3 && rc3.status}`);

  // -------------------------------------------------- 换机恢复：只有助记词
  console.log("\n【新设备 / 只拿手机】输入助记词，其余全靠链上");
  const rec = await recoverAll({ mnemonic: MNEMONIC, contract, owner: OWNER });

  check("恢复先读取 2 个批次索引，只查询实际命中的区块",
    rec.indexedBatchCount === 2 && rec.queriedBlockCount === 2,
    `batches=${rec.indexedBatchCount} blocks=${rec.queriedBlockCount}`);

  check("只按 owner 枚举到自己的 5 条（别人的记录不会混进来）",
    rec.logCount === 5, `logs=${rec.logCount}`);
  check("seq 连续无断号", rec.continuous);

  const allDecrypted = rec.records.every((r) => r.plain !== null);
  check("5 条记录全部解密成功（含跨两笔交易）", allDecrypted,
    rec.records.map((r) => `#${r.seq}:${r.err || "ok"}`).join(" "));
  check("每条都先通过了内容摘要校验", rec.records.every((r) => r.hashOk === true));

  // 前三条来自第一笔(RECORDINGS 0-2)，后两条来自第二笔(RECORDINGS 0-1)
  const expectedPlain = (i) => RECORDINGS[i < 3 ? i : i - 3].text;
  const plainOk = rec.records.every((r, i) => r.plain === expectedPlain(i));
  check("解出的明文与原始录音逐字节一致", plainOk,
    rec.records.map((r) => JSON.stringify(r.plain)).join("\n      "));

  // 回归保护（2026-09 桌面真跑抓出）：第二笔交易里 blob 的索引是 0/1，
  // 不是全局 seq(3/4)。曾按 seq 索引导致第二笔起的记录全部"摘要不一致被拒"。
  const rawTx3 = await rpc("eth_getTransactionByHash", [tx3]);
  const sizes3 = dev2.records.map((r) => r.blob.length / 2);
  const blobs3 = MinABI.extractBlobs(rawTx3.input, sizes3);
  const h0 = MemoCrypto.hex(await MemoCrypto.sha256(MemoCrypto.unhex(blobs3[0])));
  const h1 = MemoCrypto.hex(await MemoCrypto.sha256(MemoCrypto.unhex(blobs3[1])));
  check("多笔提交：交易内 blob 索引从 0 开始（≠ 全局 seq）",
    h0 === dev2.records[0].hash && h1 === dev2.records[1].hash,
    `blob0=${h0.slice(0, 10)} blob1=${h1.slice(0, 10)}`);

  // ---------------------------------------------- 失败路径（必须同样是结论）
  console.log("\n【失败路径】");

  const wrong = await recoverAll({ mnemonic: WRONG_MNEMONIC, contract, owner: OWNER });
  check("换一份助记词：摘要校验仍然通过（密文没坏）",
    wrong.records.length === 5 && wrong.records.every((r) => r.hashOk === true));
  check("换一份助记词：一条也解不开（密钥不对）",
    wrong.records.every((r) => r.plain === null),
    wrong.records.map((r) => `#${r.seq}:${r.err}`).join(" "));
  // 这两条一起才说明问题：产品上"数据在链上却打不开"绝大多数是密钥问题而非数据丢失，
  // 区分二者正是恢复引导要做的事
  check("可区分『密钥不对』与『数据损坏』",
    wrong.records.every((r) => /解密失败|不匹配/.test(r.err || "")));

  // 篡改密文：必须在校验摘要这一步就被拦下，而不是进入解密
  const kek = await MemoCrypto.kekFromMnemonic(MNEMONIC);
  const rawTx = await rpc("eth_getTransactionByHash", [tx]);
  const sizes = dev.records.map((r) => r.blob.length / 2);
  const blobs = MinABI.extractBlobs(rawTx.input, sizes);
  const genuine = MemoCrypto.unhex(blobs[0]);
  const tampered = MemoCrypto.unhex(blobs[0]);
  tampered[tampered.length - 5] ^= 1;              // 改密文内 1 位，长度不变
  const goodDigest = MemoCrypto.hex(await MemoCrypto.sha256(genuine));
  const badDigest = MemoCrypto.hex(await MemoCrypto.sha256(tampered));
  check("未篡改时摘要与链上一致", goodDigest === dev.records[0].hash);
  check("篡改 1 位后摘要立刻不同（校验能挡住）", goodDigest !== badDigest);
  let tamperOpened = false;
  try {
    await MemoCrypto.decryptRecord(tampered, kek, RECORDINGS[0].ts);
    tamperOpened = true;
  } catch { /* 预期 */ }
  check("篡改后的密文即便绕过摘要校验也解不开（GCM 认证）", !tamperOpened);

  // 连续性守卫：断号或重复都必须被判为非连续
  check("连续性守卫：正常序列通过", seqsContinuous([0, 1, 2]));
  check("连续性守卫：断号被发现", !seqsContinuous([0, 2]));
  check("连续性守卫：重复被发现", !seqsContinuous([0, 1, 1, 2]));
  check("连续性守卫：从非 0 开始被发现", !seqsContinuous([1, 2, 3]));

  // 不存在的 owner：必须是 0 条，而不是报错或返回全部
  const empty = await recoverAll({
    mnemonic: MNEMONIC, contract, owner: "0x0000000000000000000000000000000000000000",
  });
  check("陌生 owner 枚举到 0 条", empty.logCount === 0, `logs=${empty.logCount}`);

  console.log();
  if (failed === 0) {
    console.log(`换机恢复验证通过：新设备只凭助记词就还原了全部 ${rec.records.length} 条录音，`);
    console.log("设备与手机之间没有交换过任何密钥材料，恢复过程也没有用到钱包签名。");
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
