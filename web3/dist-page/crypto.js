/**
 * 语音备忘录的端侧加密管线（浏览器 / Node 共用同一份实现）。
 *
 * 为什么用 WebCrypto 而不是第三方库
 * --------------------------------
 * 解密必须在 imToken 的 DApp 浏览器里发生，所以只能用 WebCrypto 提供的原语。
 * 为了"设备端与页面用的是同一套东西"，Node 侧也走同一份代码（Node 19+ 自带
 * globalThis.crypto.subtle），这样就只有一份实现需要校验。
 *
 * 算法选型（依据 W3C WebCrypto 规范与本机实测）
 * ---------------------------------------------
 * 内容加密  AES-256-GCM  —— WebCrypto 唯一的 AEAD，AES 在移动 SoC 上有硬件加速
 * 密钥派生  HKDF-SHA256  —— RFC5869，见下面对"密钥从哪来"的说明
 * 摘要      SHA-256      —— 与设备侧记录格式一致
 *
 * 当前方案与兼容方案
 * ------------------
 * 新记录使用方案字节 0x03。wallet_pairing.js 从固定 EIP-712 恢复声明的
 * (r, low-s) 经 HKDF 派生 KEK；首次配对把 KEK 写入设备，恢复时同一钱包再次签名。
 * 页面和设备都不接触钱包助记词。
 *
 * 方案字节 0x02 是旧版兼容，从 BIP-39 助记词派生 KEK。相关函数继续保留，仅用于
 * 已有记录。0x03 依赖 secp256k1/ECDSA，不能宣称端到端抗量子。
 *
 * 方案字节为什么必要：让解密端知道该用哪种派生，也给未来升级留位置；它同时被 AAD
 * 绑定，改写会导致认证失败，而不是静默换用另一种派生。
 *
 * 为什么每条记录不单独随机 CK 再封装上链（曾这样做，实测后放弃）
 * ------------------------------------------------------------
 * 封装版每条要在载荷里多带 46 字节的 wrappedKey（92 个十六进制字符）。实测：
 * 2 条记录时二维码从 85 模块涨到 101 模块，在 320px 屏上每模块只剩 2.75px ——
 * 而此前实测 93 模块 @3px 已经扫不出来。即封装版直接毁掉二维码通路。
 * 恢复强度两者相同（都依赖 KEK 可重现），封装唯一多出的是"换钱包时不必
 * 重传密文"，而那应该做成封 KEK（O(1) 成本），而不是每条记录封一次（O(N)）。
 *
 * 同一秒内的两条记录会派生出同一个 CK，但各自带独立随机 96 位 nonce，
 * (key, nonce) 重复概率在 2^-96 量级，安全无虞。
 *
 * AAD = "vmemo/v1" || timestamp(8, 大端)
 *   作用有两个：域分隔（这份密文不能被搬到别的场景复用），以及把时间戳
 *   绑进认证范围（防止悄悄改写记录时间）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MemoCrypto = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var NONCE_LEN = 12;
  var TAG_LEN = 16;
  var CK_LEN = 32;
  var SEED_SECRET_LEN = 32;

  // 密钥方案标识，写在密文首字节。解密端据此选择派生方式，也为将来升级留位置。
  // 1 = 已废弃的"签名+种子秘密"混合方案（用它解新密文会明确报错，而不是混淆成认证失败）
  // 2 = 助记词种子秘密（旧版兼容）
  // 3 = 钱包对固定 EIP-712 恢复声明的可重现签名（当前实验方案）
  var SCHEME_SEED = 2;
  var SCHEME_WALLET = 3;
  var HEADER_LEN = 1;

  var AAD_PREFIX = utf8("vmemo/v1");
  var KEK_SALT = utf8("vmemo/kek/v1");
  var KEK_INFO = utf8("vmemo-kek");
  var CK_INFO = utf8("vmemo/ck/v1");
  var SEED_INFO = utf8("vmemo/seed/v1");

  // BIP-39：PBKDF2-HMAC-SHA512(助记词, "mnemonic"+口令, 2048) → 64 字节种子。
  // 迭代次数由标准固定，不是可调参数。
  var BIP39_ITERATIONS = 2048;
  var BIP39_SALT_PREFIX = "mnemonic";
  var MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24];

  // BIP-39 英文词表（官方 bitcoin/bips 版本，SHA-256
  // 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda）。
  // 没有词表就只能查词数 —— 配对/恢复时打错一个词会静默通过，恢复时全部
  // 记录永久解不开。BIP-39 校验和存在的全部理由就是拦这个。
  var WORDLIST_CACHE = null;
  function loadWordlist(done) {
    if (WORDLIST_CACHE) return done(WORDLIST_CACHE);
    if (typeof require === "function" && typeof module === "object" && module.exports) {
      try {
        WORDLIST_CACHE = require("fs").readFileSync(
          require("path").join(__dirname, "bip39_english.txt"), "utf8"
        ).split(/\r?\n/).filter(Boolean);
        return done(WORDLIST_CACHE);
      } catch (e) { return done(null, e); }
    }
    fetch("bip39_english.txt").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function (t) {
      WORDLIST_CACHE = t.split(/\r?\n/).filter(Boolean);
      done(WORDLIST_CACHE);
    }).catch(function (e) {
      done(null, new Error("词表加载失败（bip39_english.txt 未部署？）: " + e.message));
    });
  }

  /** BIP-39 完整校验：词数/词表/校验和。返回 NFKD 归一化词列表（异步）。
   *  打错一个词的助记词会得到完全不同且无法自愈的密钥 —— 必须当场拒绝。 */
  async function validateMnemonic(mnemonic) {
    var words = String(mnemonic == null ? "" : mnemonic).trim().split(/\s+/);
    if (words.length === 1 && words[0] === "") words = [];
    if (MNEMONIC_WORD_COUNTS.indexOf(words.length) < 0) {
      throw new Error("助记词应为 " + MNEMONIC_WORD_COUNTS.join("/") +
        " 个词，实际 " + words.length + " 个");
    }
    var list = await new Promise(function (res, rej) {
      loadWordlist(function (l, e) { if (l) res(l); else rej(e); });
    });
    if (list.length !== 2048) {
      throw new Error("BIP-39 词表异常：" + list.length + " 个词（应为 2048）");
    }
    var index = {};
    for (var i = 0; i < list.length; i++) index[list[i]] = i;
    var norm = words.map(function (w) { return w.normalize("NFKD"); });
    var unknown = norm.filter(function (w) { return !(w in index); });
    if (unknown.length) {
      throw new Error("助记词含词表之外的词: " + unknown.slice(0, 3).join(", "));
    }
    var bits = norm.map(function (w) {
      return index[w].toString(2).padStart(11, "0");
    }).join("");
    var total = norm.length * 11;
    var csLen = Math.floor(total / 33);
    var entBits = bits.slice(0, total - csLen);
    var entBytes = new Uint8Array(entBits.length / 8);
    for (var j = 0; j < entBytes.length; j++) {
      entBytes[j] = parseInt(entBits.substr(j * 8, 8), 2);
    }
    var digest = new Uint8Array(await sha256(entBytes));
    var expected = digest[0] >>> (8 - csLen);
    if (parseInt(bits.slice(total - csLen), 2) !== expected) {
      throw new Error("助记词校验和不匹配 —— 大概率有词打错了，拒绝派生");
    }
    return norm;
  }

  function subtle() {
    var c = (typeof globalThis !== "undefined" && globalThis.crypto) ||
            (typeof self !== "undefined" && self.crypto) ||
            (typeof window !== "undefined" && window.crypto);
    if (!c || !c.subtle) throw new Error("WebCrypto 不可用：需要 HTTPS 环境");
    return c.subtle;
  }

  function utf8(s) {
    return new TextEncoder().encode(s);
  }

  function hex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return "0x" + out;
  }

  function unhex(s) {
    var h = String(s).trim();
    if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
    if (h.length % 2 !== 0) throw new Error("十六进制长度必须是偶数");
    if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error("不是合法的十六进制");
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  /**
   * 严格解码 Base64URL，不依赖部分钱包 WebView 行为不一致的 window.atob()。
   * URL fragment 偶尔会被钱包再次百分号编码，因此先还原该层编码。
   */
  function b64urlDecode(value) {
    var s = String(value == null ? "" : value).trim();
    if (s.indexOf("%") >= 0) {
      try {
        s = decodeURIComponent(s);
      } catch (e) {
        throw new Error("Base64URL 百分号编码无效");
      }
    }

    // imToken 的 DApp 导航可能把自身参数附加到 fragment 值之后。它们不是
    // 设备载荷的一部分，必须先按 URL 边界切掉，再执行严格 Base64URL 校验。
    var suffixAt = s.search(/[?&#\/]/);
    if (suffixAt >= 0) s = s.slice(0, suffixAt);

    s = s.replace(/=+$/, "");
    if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) {
      var invalid = s.match(/[^A-Za-z0-9_-]/);
      var code = invalid ? invalid[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") : "";
      throw new Error("Base64URL 含无效字符" + (code ? " (U+" + code + ")" : ""));
    }
    if (s.length % 4 === 1) {
      throw new Error("Base64URL 长度无效");
    }

    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var bytes = [];
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < s.length; i++) {
      buffer = (buffer << 6) | alphabet.indexOf(s.charAt(i));
      bits += 6;
      while (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >>> bits) & 0xff);
      }
      buffer &= bits ? (1 << bits) - 1 : 0;
    }
    if (buffer !== 0) {
      throw new Error("Base64URL 填充位无效");
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    } catch (e) {
      throw new Error("Base64URL 不是有效的 UTF-8 文本");
    }
  }

  function concat() {
    var total = 0;
    for (var i = 0; i < arguments.length; i++) total += arguments[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < arguments.length; j++) {
      out.set(arguments[j], off);
      off += arguments[j].length;
    }
    return out;
  }

  function u64be(n) {
    var b = new Uint8Array(8);
    var v = BigInt(n);
    for (var i = 7; i >= 0; i--) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return b;
  }

  async function sha256(bytes) {
    return new Uint8Array(await subtle().digest("SHA-256", bytes));
  }

  async function hkdf(ikm, salt, info, length) {
    var base = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    var bits = await subtle().deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt, info: info },
      base,
      length * 8
    );
    return new Uint8Array(bits);
  }

  /**
   * BIP-39：助记词 → 64 字节种子。
   * PBKDF2-HMAC-SHA512(助记词, "mnemonic"+口令, 2048 次, 64 字节)。
   * 标准要求助记词与口令都先做 NFKD 归一化 —— 漏掉这一步，带变音符或全角空格的
   * 助记词会算出另一个种子，而且失败是静默的（只在解密那一刻才炸）。
   * @param {string} mnemonic 12/15/18/21/24 个单词
   * @param {string} [passphrase] BIP-39 可选口令（本产品不使用，留作兼容）
   */
  async function mnemonicToSeed(mnemonic, passphrase) {
    // 派生前先做完整 BIP-39 校验（词数/词表/校验和）：打错一个词的助记词
    // 会得到完全不同的 KEK，且一切看起来正常直到恢复那一刻 —— 必须当场拒绝。
    var norm = await validateMnemonic(mnemonic);
    var pw = utf8(norm.join(" ").normalize("NFKD"));
    var salt = utf8((BIP39_SALT_PREFIX + (passphrase || "")).normalize("NFKD"));
    var base = await subtle().importKey("raw", pw, "PBKDF2", false, ["deriveBits"]);
    var bits = await subtle().deriveBits(
      { name: "PBKDF2", salt: salt, iterations: BIP39_ITERATIONS, hash: "SHA-512" },
      base, 512
    );
    return new Uint8Array(bits);
  }

  /**
   * 旧版 0x02：从 BIP-39 种子推导种子秘密。
   * @param {Uint8Array} bip39Seed BIP-39 种子（64 字节）
   */
  async function deriveSeedSecret(bip39Seed) {
    var seed = bip39Seed instanceof Uint8Array ? bip39Seed : unhex(bip39Seed);
    if (seed.length < 16) throw new Error("种子长度不足");
    return hkdf(seed, AAD_PREFIX, SEED_INFO, SEED_SECRET_LEN);
  }

  /**
   * 旧版 0x02：从种子秘密派生 KEK。
   */
  async function deriveKek(seedSecret) {
    var ss = seedSecret instanceof Uint8Array ? seedSecret : unhex(seedSecret);
    if (ss.length !== SEED_SECRET_LEN) {
      throw new Error("种子秘密必须 " + SEED_SECRET_LEN + " 字节，实际 " + ss.length);
    }
    return hkdf(ss, KEK_SALT, KEK_INFO, CK_LEN);
  }

  /**
   * 旧版 0x02：助记词 → KEK，仅用于历史记录兼容。
   */
  async function kekFromMnemonic(mnemonic, passphrase) {
    return deriveKek(await deriveSeedSecret(await mnemonicToSeed(mnemonic, passphrase)));
  }

  /**
   * KEK 指纹，仅用于配对时向用户展示/比对，**不可**用于派生密钥。
   * 配对与诊断时可比较指纹；指纹本身不用于派生密钥。
   */
  async function kekFingerprint(kek) {
    var k = kek instanceof Uint8Array ? kek : unhex(kek);
    return hex(await sha256(concat(utf8("vmemo/fp/v1"), k))).slice(2, 18);
  }

  /**
   * 从 KEK 与时间戳派生该条记录的内容密钥。时间戳在链上有，恢复时可取。 */
  async function deriveRecordKey(kek, timestamp) {
    return hkdf(kek, u64be(timestamp), CK_INFO, CK_LEN);
  }

  function aad(timestamp) {
    return concat(AAD_PREFIX, u64be(timestamp));
  }

  /**
   * 加密一条记录。
   * @param {Uint8Array} plaintext 明文（设备上的原始录音/文本，绝不出设备）
   * @param {Uint8Array} kek      deriveKek() 的产物
   * @param {number|bigint} timestamp 记录时间（秒）
   * @returns {{blob: Uint8Array, contentHash: string}}
   */
  async function encryptRecord(plaintext, kek, timestamp, scheme) {
    scheme = scheme == null ? SCHEME_SEED : Number(scheme);
    if (scheme !== SCHEME_SEED && scheme !== SCHEME_WALLET) {
      throw new Error("不支持的密钥方案: " + scheme);
    }
    var ck = await deriveRecordKey(kek, timestamp);
    var nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    var ckKey = await subtle().importKey("raw", ck, "AES-GCM", false, ["encrypt", "decrypt"]);
    var ct = new Uint8Array(await subtle().encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(timestamp) },
      ckKey,
      plaintext
    ));
    var blob = concat(new Uint8Array([scheme]), nonce, ct);
    return { blob: blob, contentHash: hex(await sha256(blob)) };
  }

  /**
   * 解密一条记录。KEK 由当前钱包签名方案或旧助记词兼容方案重建。
   * @param {Uint8Array} blob nonce || ciphertext+tag
   * @param {Uint8Array} kek  deriveKek() 的产物
   * @param {number|bigint} timestamp
   */
  async function decryptRecord(blob, kek, timestamp) {
    var b = typeof blob === "string" ? unhex(blob) : blob;
    if (b.length < HEADER_LEN + NONCE_LEN + TAG_LEN) throw new Error("密文长度不足");
    if (b[0] !== SCHEME_SEED && b[0] !== SCHEME_WALLET) {
      throw new Error("不支持的密钥方案: " + b[0]);
    }
    var body = b.slice(HEADER_LEN);
    var ck = await deriveRecordKey(kek, timestamp);
    var key = await subtle().importKey("raw", ck, "AES-GCM", false, ["decrypt"]);
    try {
      return new Uint8Array(await subtle().decrypt(
        { name: "AES-GCM", iv: body.slice(0, NONCE_LEN), additionalData: aad(timestamp) },
        key,
        body.slice(NONCE_LEN)
      ));
    } catch (e) {
      throw new Error("解密失败：KEK 与记录不匹配，或密文/时间戳被篡改");
    }
  }

  return {
    NONCE_LEN: NONCE_LEN,
    CK_LEN: CK_LEN,
    SEED_SECRET_LEN: SEED_SECRET_LEN,
    SCHEME_SEED: SCHEME_SEED,
    SCHEME_WALLET: SCHEME_WALLET,
    HEADER_LEN: HEADER_LEN,
    utf8: utf8,
    hex: hex,
    unhex: unhex,
    b64urlDecode: b64urlDecode,
    concat: concat,
    sha256: sha256,
    hkdf: hkdf,
    mnemonicToSeed: mnemonicToSeed,
    deriveSeedSecret: deriveSeedSecret,
    deriveKek: deriveKek,
    kekFromMnemonic: kekFromMnemonic,
    kekFingerprint: kekFingerprint,
    deriveRecordKey: deriveRecordKey,
    encryptRecord: encryptRecord,
    decryptRecord: decryptRecord,
  };
});
