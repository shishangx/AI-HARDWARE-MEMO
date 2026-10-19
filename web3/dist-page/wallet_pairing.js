/**
 * 钱包签名配对协议（浏览器 / Node 共用）。
 *
 * 这不是交易签名。钱包对固定 EIP-712 恢复声明签名，签名不广播、不上链；
 * 归一化后的 (r, low-s) 作为 HKDF 输入，链、合约与 owner 共同做上下文绑定。
 * imToken 是否会对同一声明返回可重现签名必须在真机上签两次验证。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./crypto.js"));
  } else {
    root.WalletPairing = factory(root.MemoCrypto);
  }
})(typeof self !== "undefined" ? self : this, function (MemoCrypto) {
  "use strict";

  var KEY_SCHEME = "wallet-signature-v1";
  var PURPOSE = "Derive Private Memo recovery key";
  var INFO = MemoCrypto.utf8("vmemo/wallet-kek/v1");
  var CURVE_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  var HALF_N = CURVE_N >> 1n;

  function address(value, label) {
    var out = String(value || "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(out)) throw new Error((label || "地址") + "无效");
    return out;
  }

  function buildTypedData(context, owner) {
    var chainId = Number(context.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chainId 无效");
    var contract = address(context.contract, "合约地址");
    var who = address(owner, "钱包地址");
    return {
      domain: {
        name: "Private Memo",
        version: "1",
        chainId: chainId,
        verifyingContract: contract,
      },
      primaryType: "RecoveryKey",
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        RecoveryKey: [
          { name: "owner", type: "address" },
          { name: "purpose", type: "string" },
          { name: "version", type: "uint256" },
        ],
      },
      message: { owner: who, purpose: PURPOSE, version: 1 },
    };
  }

  function bigIntBytes(value, length) {
    var out = new Uint8Array(length);
    var n = BigInt(value);
    for (var i = length - 1; i >= 0; i--) {
      out[i] = Number(n & 255n);
      n >>= 8n;
    }
    if (n !== 0n) throw new Error("整数超出范围");
    return out;
  }

  function bytesBigInt(bytes) {
    var out = 0n;
    for (var i = 0; i < bytes.length; i++) out = (out << 8n) | BigInt(bytes[i]);
    return out;
  }

  /** ECDSA 的 s 与 n-s 等价；统一成 low-s，并去掉不参与密钥材料的 v。 */
  function normalizeSignature(signature) {
    var raw = MemoCrypto.unhex(signature);
    if (raw.length !== 65) throw new Error("钱包签名必须是 65 字节");
    var r = raw.slice(0, 32);
    var s = bytesBigInt(raw.slice(32, 64));
    if (s <= 0n || s >= CURVE_N) throw new Error("钱包签名 s 值无效");
    if (s > HALF_N) s = CURVE_N - s;
    return MemoCrypto.concat(r, bigIntBytes(s, 32));
  }

  function contextSalt(context, owner) {
    return MemoCrypto.concat(
      bigIntBytes(Number(context.chainId), 32),
      MemoCrypto.unhex(address(context.contract, "合约地址")),
      MemoCrypto.unhex(address(owner, "钱包地址"))
    );
  }

  async function deriveKek(signature, context, owner) {
    return MemoCrypto.hkdf(normalizeSignature(signature), contextSalt(context, owner), INFO, 32);
  }

  async function requestSignature(provider, context, owner) {
    return provider.request({
      method: "eth_signTypedData_v4",
      params: [address(owner, "钱包地址"), JSON.stringify(buildTypedData(context, owner))],
    });
  }

  async function verifyRepeatability(provider, context, owner) {
    var first = await requestSignature(provider, context, owner);
    var second = await requestSignature(provider, context, owner);
    var a = MemoCrypto.hex(normalizeSignature(first));
    var b = MemoCrypto.hex(normalizeSignature(second));
    if (a !== b) {
      throw new Error("同一 EIP-712 声明的两次签名不一致；该钱包不能用于确定性恢复");
    }
    var kek = await deriveKek(first, context, owner);
    return { kek: kek, fingerprint: await MemoCrypto.kekFingerprint(kek) };
  }

  function encodeCredential(owner, kek, context) {
    var obj = {
      v: 2,
      scheme: KEY_SCHEME,
      chainId: Number(context.chainId),
      contract: address(context.contract, "合约地址"),
      owner: address(owner),
      kek: MemoCrypto.hex(kek),
    };
    var bytes = MemoCrypto.utf8(JSON.stringify(obj));
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var encoded = typeof btoa === "function"
      ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
    return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  return {
    KEY_SCHEME: KEY_SCHEME,
    PURPOSE: PURPOSE,
    buildTypedData: buildTypedData,
    normalizeSignature: normalizeSignature,
    deriveKek: deriveKek,
    requestSignature: requestSignature,
    verifyRepeatability: verifyRepeatability,
    encodeCredential: encodeCredential,
  };
});
