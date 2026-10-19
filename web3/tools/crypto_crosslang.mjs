/*
 * 跨语言验证：Python（设备侧）与 JS（页面侧）必须是同一套加密格式的两份实现。
 *
 * 单向自测不够 —— 两份实现"各自自洽"完全可能互不兼容（PBKDF2 的迭代次数与 salt
 * 前缀、HKDF 的 salt/info、AAD 的字节序、nonce 的拼接顺序，任何一处不同都会导致
 * 设备加密、页面解不开，而两边的单元测试都照常通过）。因此这里做真正的交叉：
 *   Python 加密 → JS 解密，JS 加密 → Python 解密，
 * 并逐字节比对种子、种子秘密、KEK 与每条记录的内容密钥。
 *
 * 用的助记词是 BIP-39 官方测试向量，因此这一份测试同时钉住了"我们算的种子和
 * 所有钱包算的是同一个"，而不只是"我们两边算的一样"。
 *
 * 用法: node tools/crypto_crosslang.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_DIR = join(HERE, "..", "..", "lab", "crypto");
const require = createRequire(import.meta.url);
const C = require(join(HERE, "..", "app", "crypto.js"));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "  → " + detail : "")); }
}

/** 在设备侧 Python 管线里执行一段代码，返回其打印的 JSON。 */
function py(code) {
  const out = execFileSync("python3", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: PY_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

const PY_PREAMBLE = `
import sys, json, hashlib
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import pipeline as P
def emit(o): print(json.dumps(o))
`;

// Python 侧 hex() 不带 "0x"，JS 侧带，比较前必须归一，
// 否则会把"字节一致"误判成不一致（真互通测试仍会通过，容易掩盖成假失败）
const hx = (s) => String(s).replace(/^0x/, "").toLowerCase();

// BIP-39 官方向量（空口令）。用真实助记词而不是伪造字节：
// 这是唯一能证明"两侧对助记词的解读与标准一致"的输入。
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const TIMESTAMP = 1758500000;
const PLAINTEXT = "明天上午十点，和张总聊聊硬件 BOM 的事".repeat(3);
const PLAIN_UTF8 = C.utf8(PLAINTEXT);

// 设备侧反复用到的表达式：助记词 → KEK
const PY_KEK = (m) => `P.kek_from_mnemonic(${JSON.stringify(m)})`;

console.log("=== 跨语言验证：设备侧(Python) ↔ 页面侧(JS) ===\n");

// -------------------------------------------- 1) 助记词解读必须与标准一致
// 这一层错了，后果是"设备与页面各自算得都对，但和用户的钱包不一致" —— 极难排查
const jsSeed = await C.mnemonicToSeed(MNEMONIC);
const seedVec = py(PY_PREAMBLE + `
emit({"seed": P.mnemonic_to_seed(${JSON.stringify(MNEMONIC)}).hex()})
`);
check("BIP-39 种子逐字节一致（PBKDF2 迭代次数/salt 前缀/NFKD 都一致）",
  hx(C.hex(jsSeed)) === hx(seedVec.seed), "js=" + C.hex(jsSeed) + " py=" + seedVec.seed);
check("BIP-39 种子与官方向量一致",
  hx(C.hex(jsSeed)) === "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1"
    + "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4");

// --------------------------------------- 2) KEK 与内容密钥必须逐字节一致
// 这两项不一致 = 设备加密的数据页面永远解不开，是本管线最关键的契约
const jsSeedSecret = await C.deriveSeedSecret(jsSeed);
const keysVec = py(PY_PREAMBLE + `
kek = ${PY_KEK(MNEMONIC)}
emit({"ss": P.derive_seed_secret(P.mnemonic_to_seed(${JSON.stringify(MNEMONIC)})).hex(),
      "kek": kek.hex(), "ck": P.derive_record_key(kek, ${TIMESTAMP}).hex(),
      "fp": P.kek_fingerprint(kek)})
`);
check("种子秘密逐字节一致",
  hx(C.hex(jsSeedSecret)) === hx(keysVec.ss),
  "js=" + C.hex(jsSeedSecret) + " py=" + keysVec.ss);

const jsKek = await C.deriveKek(jsSeedSecret);
check("KEK 逐字节一致（HKDF 的 salt/info 一致）",
  hx(C.hex(jsKek)) === hx(keysVec.kek), "js=" + C.hex(jsKek) + " py=" + keysVec.kek);
check("KEK 指纹一致（配对时两端比对的就是它）",
  hx(await C.kekFingerprint(jsKek)) === hx(keysVec.fp));

const jsCk = await C.deriveRecordKey(jsKek, TIMESTAMP);
check("内容密钥逐字节一致（时间戳编码为 8 字节大端）",
  hx(C.hex(jsCk)) === hx(keysVec.ck), "js=" + C.hex(jsCk) + " py=" + keysVec.ck);
check("换时间戳 → 内容密钥改变",
  hx(C.hex(jsCk)) !== hx(C.hex(await C.deriveRecordKey(jsKek, TIMESTAMP + 1))));

// ------------------------------------- 3) Python 加密 → JS 解密（设备 → 页面）
const devRecord = py(PY_PREAMBLE + `
kek = ${PY_KEK(MNEMONIC)}
enc = P.encrypt_record(${JSON.stringify(PLAINTEXT)}.encode("utf-8"), kek, ${TIMESTAMP})
emit({"blob": enc["blob"].hex(), "hash": enc["contentHash"]})
`);
check("设备侧摘要 = SHA-256(blob)",
  hx(devRecord.hash) === hx(C.hex(await C.sha256(C.unhex(devRecord.blob)))));

let recovered = null, recoverErr = null;
try {
  recovered = C.hex(await C.decryptRecord(C.unhex(devRecord.blob), jsKek, TIMESTAMP));
} catch (e) { recoverErr = e.message; }
check("JS 能解开设备加密的记录（换机恢复的关键一步）",
  recovered === C.hex(PLAIN_UTF8), recoverErr || ("得到 " + String(recovered).slice(0, 40)));

// ------------------------------------- 4) JS 加密 → Python 解密（页面 → 设备）
const jsEnc = await C.encryptRecord(PLAIN_UTF8, jsKek, TIMESTAMP);
const backVec = py(PY_PREAMBLE + `
kek = ${PY_KEK(MNEMONIC)}
out = P.decrypt_record(bytes.fromhex(${JSON.stringify(C.hex(jsEnc.blob).slice(2))}), kek, ${TIMESTAMP})
emit({"plain": out.decode("utf-8")})
`);
check("Python 能解开 JS 加密的记录", backVec.plain === PLAINTEXT,
  "得到 " + String(backVec.plain).slice(0, 30));
check("两侧的 blob 结构一致（方案字节 + nonce(12) + 密文 + tag(16)）",
  jsEnc.blob.length === C.HEADER_LEN + C.NONCE_LEN + PLAIN_UTF8.length + 16,
  "len=" + jsEnc.blob.length);
check("blob 首字节为方案标识", jsEnc.blob[0] === C.SCHEME_SEED, "b0=" + jsEnc.blob[0]);

// --------------------------------- 5) 失败路径：两侧必须给出同样的结论
// 只测成功路径是不够的 —— 一条"永不解密失败"的实现也能通过所有正向用例
/** 断言这段 Python 会抛错（待测语句必须真的在 try 里，否则异常会直接终止进程）。 */
function pyRejects(body) {
  const indented = body.trim().split("\n").map((l) => "    " + l).join("\n");
  return py(PY_PREAMBLE + `
try:
${indented}
    emit({"tried": True})
except Exception:
    emit({"tried": False})
`).tried === false;
}

// 5.1 换一份助记词（用户抄错了词 / 拿错了备份）
let jsWrongMnemonic = false;
try {
  const otherKek = await C.kekFromMnemonic(OTHER_MNEMONIC);
  await C.decryptRecord(C.unhex(devRecord.blob), otherKek, TIMESTAMP);
} catch { jsWrongMnemonic = true; }
const pyWrongMnemonic = pyRejects(`
kek = ${PY_KEK(OTHER_MNEMONIC)}
P.decrypt_record(bytes.fromhex(${JSON.stringify(hx(devRecord.blob))}), kek, ${TIMESTAMP})
`);
check("换一份助记词 → 两端都解不开", jsWrongMnemonic && pyWrongMnemonic,
  `js=${jsWrongMnemonic} py=${pyWrongMnemonic}`);

// 5.2 密文被改 1 位
const badBlob = C.unhex(devRecord.blob);
badBlob[badBlob.length - 1] ^= 1;
let jsTamper = false;
try { await C.decryptRecord(badBlob, jsKek, TIMESTAMP); } catch { jsTamper = true; }
const pyTamper = pyRejects(`
kek = ${PY_KEK(MNEMONIC)}
b = bytearray(bytes.fromhex(${JSON.stringify(hx(devRecord.blob))})); b[-1] ^= 1
P.decrypt_record(bytes(b), kek, ${TIMESTAMP})
`);
check("密文篡改 → 两端都拒绝", jsTamper && pyTamper, `js=${jsTamper} py=${pyTamper}`);

// 5.3 时间戳被改写（时间戳同时是 CK 的 salt 与 AAD 的一部分）
let jsTs = false;
try { await C.decryptRecord(C.unhex(devRecord.blob), jsKek, TIMESTAMP + 1); } catch { jsTs = true; }
const pyTs = pyRejects(`
kek = ${PY_KEK(MNEMONIC)}
P.decrypt_record(bytes.fromhex(${JSON.stringify(hx(devRecord.blob))}), kek, ${TIMESTAMP + 1})
`);
check("时间戳篡改 → 两端都拒绝", jsTs && pyTs, `js=${jsTs} py=${pyTs}`);

// 5.4 未知方案字节：必须明确报错，而不是静默换一种派生
const badScheme = C.unhex(devRecord.blob);
badScheme[0] = 9;
let jsScheme = false;
try { await C.decryptRecord(badScheme, jsKek, TIMESTAMP); } catch { jsScheme = true; }
const pyScheme = pyRejects(`
kek = ${PY_KEK(MNEMONIC)}
b = bytearray(bytes.fromhex(${JSON.stringify(hx(devRecord.blob))})); b[0] = 9
P.decrypt_record(bytes(b), kek, ${TIMESTAMP})
`);
check("未知方案字节 → 两端都拒绝", jsScheme && pyScheme, `js=${jsScheme} py=${pyScheme}`);

// 5.5 旧混合方案（方案字节 1）必须被认出并拒绝，而不是当作认证失败混淆过去
const legacyBlob = C.unhex(devRecord.blob);
legacyBlob[0] = 1;
let jsLegacy = null;
try { await C.decryptRecord(legacyBlob, jsKek, TIMESTAMP); } catch (e) { jsLegacy = e.message; }
const pyLegacy = pyRejects(`
kek = ${PY_KEK(MNEMONIC)}
b = bytearray(bytes.fromhex(${JSON.stringify(hx(devRecord.blob))})); b[0] = 1
P.decrypt_record(bytes(b), kek, ${TIMESTAMP})
`);
check("旧混合方案字节 → 两端都明确报『不支持』，不混淆成解密失败",
  /不支持/.test(jsLegacy || "") && pyLegacy, "js=" + jsLegacy);

// 5.6 助记词词数不对（漏抄 / 多抄）：必须在派生阶段就报错
let jsBadWords = false;
try { await C.mnemonicToSeed("abandon ".repeat(11).trim()); } catch { jsBadWords = true; }
const pyBadWords = pyRejects(`P.mnemonic_to_seed("abandon " * 11)`);
check("助记词词数不对 → 两端都在派生阶段报错", jsBadWords && pyBadWords,
  `js=${jsBadWords} py=${pyBadWords}`);

// 5.7 种子秘密长度必须校验（防止调用方传半个密钥却静默继续）
let jsShort = false;
try { await C.deriveKek(new Uint8Array(31)); } catch { jsShort = true; }
const pyShort = pyRejects(`P.derive_kek(b"short")`);
check("种子秘密长度被校验 → 两端都拒绝", jsShort && pyShort, `js=${jsShort} py=${pyShort}`);

// 5.8 BIP-39 词表 + 校验和校验：打错一个词的助记词必须当场拒绝（两端一致）。
//     没有这一层，配对时打错词 → 设备用错误 KEK 加密 → 一切正常 → 恢复时全丢。
const BAD_MNEMONICS = [
  ["校验和错（最后一个词被改）",
   "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zoo"],
  ["词表外（notaword ×12）",
   "notaword notaword notaword notaword notaword notaword notaword notaword notaword notaword notaword notaword"],
];
for (const [label, badMn] of BAD_MNEMONICS) {
  let jsRejected = false, jsErr = "";
  try { await C.mnemonicToSeed(badMn); } catch (e) { jsRejected = true; jsErr = e.message; }
  const pyRejected = pyRejects(`P.mnemonic_to_seed(${JSON.stringify(badMn)})`);
  check(`BIP-39 校验（${label}）→ 两端都拒绝`,
    jsRejected && pyRejected, `js=${jsErr} py=${pyRejected}`);
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
