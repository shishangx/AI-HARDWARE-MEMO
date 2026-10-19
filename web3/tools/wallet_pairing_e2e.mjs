/* 钱包签名配对协议的离线验证；不需要真实私钥或 RPC。 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MemoCrypto = require(join(ROOT, "app", "crypto.js"));
const WalletPairing = require(join(ROOT, "app", "wallet_pairing.js"));

const CONTEXT = {
  chainId: 84532,
  contract: "0x2737FAedBf625BF32069A7a076A6C42644292278",
};
const OWNER = "0x0bd54e59FF6b564cDD2c8a816D1d6EA0d99A132C";
const OTHER_OWNER = "0x0d4537Dc80738Be1e245E69710d25D84a9f8f16d";
const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const PAIRING_PAYLOAD_B64 =
  "eyJ2IjoxLCJjaGFpbklkIjo4NDUzMiwiY29udHJhY3QiOiIweDI3MzdGQWVkQmY2MjVCRjMyMDY5QTdhMDc2QTZDNDI2NDQyOTIyNzgiLCJrZXlTY2hlbWUiOiJ3YWxsZXQtc2lnbmF0dXJlLXYxIn0";

function word(n) { return BigInt(n).toString(16).padStart(64, "0"); }
const r = "11".repeat(32);
const low = "0x" + r + word(1) + "1b";
const high = "0x" + r + word(N - 1n) + "1c";
const different = "0x" + "22".repeat(32) + word(1) + "1b";

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); }
}

const pairingPayload = JSON.parse(MemoCrypto.b64urlDecode(PAIRING_PAYLOAD_B64));
check("真实配对二维码载荷可解码",
  pairingPayload.chainId === CONTEXT.chainId &&
  pairingPayload.contract.toLowerCase() === CONTEXT.contract.toLowerCase() &&
  pairingPayload.keyScheme === WalletPairing.KEY_SCHEME);
check("百分号编码的配对载荷可解码",
  MemoCrypto.b64urlDecode("%65" + PAIRING_PAYLOAD_B64.slice(1)) ===
    MemoCrypto.b64urlDecode(PAIRING_PAYLOAD_B64));
check("钱包追加的 fragment 导航参数不会污染载荷",
  MemoCrypto.b64urlDecode(PAIRING_PAYLOAD_B64 + "%3Ffrom%3Dimtoken") ===
    MemoCrypto.b64urlDecode(PAIRING_PAYLOAD_B64) &&
  MemoCrypto.b64urlDecode(PAIRING_PAYLOAD_B64 + "&channel=wallet") ===
    MemoCrypto.b64urlDecode(PAIRING_PAYLOAD_B64));
let malformedPayloadRejected = false;
try { MemoCrypto.b64urlDecode(PAIRING_PAYLOAD_B64 + "!"); }
catch (e) { malformedPayloadRejected = /无效字符/.test(e.message); }
check("配对载荷中的非法字符会被拒绝", malformedPayloadRejected);

const normalizedLow = MemoCrypto.hex(WalletPairing.normalizeSignature(low));
const normalizedHigh = MemoCrypto.hex(WalletPairing.normalizeSignature(high));
check("ECDSA high-s / low-s 归一化一致", normalizedLow === normalizedHigh);

const typed = WalletPairing.buildTypedData(CONTEXT, OWNER);
check("EIP-712 域绑定链与合约",
  typed.domain.chainId === CONTEXT.chainId &&
  typed.domain.verifyingContract === CONTEXT.contract.toLowerCase());
check("EIP-712 消息绑定 owner 与恢复用途",
  typed.message.owner === OWNER.toLowerCase() && /recovery key/i.test(typed.message.purpose));

const kekA = await WalletPairing.deriveKek(low, CONTEXT, OWNER);
const kekB = await WalletPairing.deriveKek(high, CONTEXT, OWNER);
const kekOther = await WalletPairing.deriveKek(low, CONTEXT, OTHER_OWNER);
check("等价签名派生同一 KEK", MemoCrypto.hex(kekA) === MemoCrypto.hex(kekB));
check("不同 owner 不能派生同一 KEK", MemoCrypto.hex(kekA) !== MemoCrypto.hex(kekOther));

let calls = 0;
const stableProvider = { request: async ({ method }) => {
  check("使用 eth_signTypedData_v4", method === "eth_signTypedData_v4");
  calls++;
  return calls === 1 ? low : high;
}};
const verified = await WalletPairing.verifyRepeatability(stableProvider, CONTEXT, OWNER);
check("两次等价签名通过可重现性验证",
  MemoCrypto.hex(verified.kek) === MemoCrypto.hex(kekA));

let unstableCalls = 0, unstableRejected = false;
try {
  await WalletPairing.verifyRepeatability({ request: async () => {
    unstableCalls++;
    return unstableCalls === 1 ? low : different;
  }}, CONTEXT, OWNER);
} catch (e) {
  unstableRejected = /不一致/.test(e.message);
}
check("两次签名不一致时拒绝配对", unstableRejected);

const credential = WalletPairing.encodeCredential(OWNER, kekA, CONTEXT);
const decoded = JSON.parse(Buffer.from(
  credential.replace(/-/g, "+").replace(/_/g, "/") +
  "=".repeat((4 - credential.length % 4) % 4), "base64").toString("utf8"));
check("配对凭据绑定链、合约、owner、方案和 KEK",
  decoded.owner === OWNER.toLowerCase() && decoded.scheme === WalletPairing.KEY_SCHEME &&
  decoded.chainId === CONTEXT.chainId && decoded.contract === CONTEXT.contract.toLowerCase() &&
  /^0x[0-9a-f]{64}$/.test(decoded.kek) && !credential.includes(low.slice(2, 20)));

// Python 设备端用方案 3 加密，浏览器端以同一 KEK 解密。
const python = [
  "import json,sys",
  "sys.path.insert(0, sys.argv[1])",
  "import pipeline as p",
  `k=bytes.fromhex('${MemoCrypto.hex(kekA).slice(2)}')`,
  "e=p.encrypt_record('钱包签名恢复闭环'.encode(),k,1700000000,nonce=bytes(range(12)),scheme=p.SCHEME_WALLET)",
  "print(json.dumps({'blob':e['blob'].hex(),'hash':e['contentHash']}))",
].join(";");
const py = JSON.parse(execFileSync("python3", ["-c", python,
  join(ROOT, "..", "lab", "crypto")], { encoding: "utf8" }));
const plain = await MemoCrypto.decryptRecord(MemoCrypto.unhex(py.blob), kekA, 1700000000);
check("Python 方案 3 密文可由浏览器解密",
  new TextDecoder().decode(plain) === "钱包签名恢复闭环");
check("方案 3 摘要一致",
  MemoCrypto.hex(await MemoCrypto.sha256(MemoCrypto.unhex(py.blob))) === py.hash);

console.log(`\n${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
