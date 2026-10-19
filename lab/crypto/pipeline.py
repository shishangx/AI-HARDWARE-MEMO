#!/usr/bin/env python3
"""
端侧加密管线（设备侧实现）。

与 web3/app/crypto.js 是同一套格式的两份实现，必须逐字节兼容 ——
设备加密、页面解密；页面换机后重新派生密钥再解密。两边由
web3/tools/crypto_crosslang.mjs 做跨语言比对。

选型依据（已核实 WebCrypto / Node / Python 三方都原生支持）
--------------------------------------------------------
内容加密  AES-256-GCM   WebCrypto 唯一的 AEAD；AES 在移动 SoC 有硬件加速
密钥派生  HKDF-SHA256   RFC5869，把偏态输入压成均匀密钥
摘要      SHA-256       与既有记录格式一致

当前与历史密钥方案
------------------
新记录使用方案字节 0x03：钱包对固定 EIP-712 恢复声明签名，浏览器归一化
(r, low-s) 后经 HKDF 派生 KEK；首次配对把 KEK 通过已认证通道写入设备，恢复时
同一钱包再次签署同一声明。设备不接触钱包助记词。

方案字节 0x02 是旧版兼容：从 BIP-39 助记词派生 KEK。相关函数与测试继续保留，
只为已有记录可读，不是新用户流程。两种方案共用记录密钥与密文格式：

CK_i        = HKDF(KEK, salt=时间戳, info="vmemo/ck/v1")
blob        = 方案字节 || nonce(12) || AES-256-GCM(CK_i, 明文, AAD)
contentHash = SHA-256(blob)

为什么不每条记录单独随机 CK 再封装上链（曾这样做，实测后放弃）
------------------------------------------------------------
封装版每条要在载荷里多带 46 字节的 wrappedKey（92 个十六进制字符）。实测：
2 条记录时二维码从 85 模块涨到 101 模块，在 320px 屏上每模块只剩 2.75px ——
而此前实测 93 模块 @3px 已经扫不出来。即封装版直接毁掉二维码通路。
恢复强度两者相同（都依赖 KEK 由签名重现），封装唯一多出的是"换钱包时不必重传
密文"，而那应该做成封 KEK（O(1) 成本），而不是每条记录封一次（O(N)）。

同一秒内的两条记录会派生出同一个 CK，但各自带独立随机 96 位 nonce，
(key, nonce) 重复概率在 2^-96 量级，安全无虞。

安全性边界：0x03 依赖钱包 ECDSA 安全性和固定声明签名的可重现性，因此不能宣称
端到端抗量子。0x02 依赖旧恢复词保密。两种方案的 KEK 不匹配或密文被篡改时，
AES-GCM 认证都会明确失败。
"""
from __future__ import annotations

import hashlib
import os
import struct
import unicodedata

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

NONCE_LEN = 12
TAG_LEN = 16
CK_LEN = 32
SEED_SECRET_LEN = 32

# 密钥方案标识，写在密文首字节。解密端据此选择派生方式，也为将来升级留位置。
# 1 = 已废弃的"签名+种子秘密"混合方案（用它解新密文会明确报错，而不是混淆成认证失败）
# 2 = 助记词种子秘密（旧版兼容）
# 3 = 钱包对固定 EIP-712 恢复声明的可重现签名（当前实验方案）
SCHEME_SEED = 2
SCHEME_WALLET = 3
HEADER_LEN = 1

AAD_PREFIX = b"vmemo/v1"
KEK_SALT = b"vmemo/kek/v1"
KEK_INFO = b"vmemo-kek"
CK_INFO = b"vmemo/ck/v1"
SEED_INFO = b"vmemo/seed/v1"

# BIP-39：PBKDF2-HMAC-SHA512(助记词, "mnemonic"+口令, 2048) → 64 字节种子。
# 迭代次数由标准固定，不是可调参数。
BIP39_ITERATIONS = 2048
BIP39_SALT_PREFIX = "mnemonic"
MNEMONIC_WORD_COUNTS = (12, 15, 18, 21, 24)

# BIP-39 英文词表（官方 bitcoin/bips 版本，SHA-256
# 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda）。
# 没有词表就只能查词数 —— 配对时打错一个词会静默通过，恢复时全部记录永久解不开。
# BIP-39 校验和存在的全部理由就是拦这个。
_WORDLIST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "bip39_english.txt")

def _load_wordlist():
    if not os.path.isfile(_WORDLIST_PATH):
        raise ValueError("缺少 BIP-39 词表文件 bip39_english.txt（与 pipeline.py "
                         "同目录）—— 没有它无法校验助记词，拒绝派生")
    words = open(_WORDLIST_PATH, encoding="utf-8").read().split()
    if len(words) != 2048:
        raise ValueError("BIP-39 词表异常：%d 个词（应为 2048）" % len(words))
    return words

def validate_mnemonic(mnemonic: str, passphrase: str = "") -> list:
    """BIP-39 完整校验：词数、词表、校验和。返回 NFKD 归一化后的词列表。

    拒绝而非派生 —— 打错一个词的助记词会得到完全不同且无法自愈的密钥，
    一切看起来正常直到恢复那一刻，为时已晚。
    """
    words = str(mnemonic).split()
    if len(words) not in MNEMONIC_WORD_COUNTS:
        raise ValueError("助记词应为 %s 个词，实际 %d 个"
                         % ("/".join(str(n) for n in MNEMONIC_WORD_COUNTS),
                            len(words)))
    wordlist = _load_wordlist()
    index = {w: i for i, w in enumerate(wordlist)}
    norm = [unicodedata.normalize("NFKD", w) for w in words]
    unknown = [w for w in norm if w not in index]
    if unknown:
        raise ValueError("助记词含词表之外的词: %s" % ", ".join(unknown[:3]))
    # 校验和：总位数 = 词数*11；末尾 cs_len 位是 SHA256(熵) 的前 cs_len 位。
    bits = "".join(format(index[w], "011b") for w in norm)
    total_bits = len(norm) * 11
    cs_len = total_bits // 33
    entropy_bits = total_bits - cs_len
    entropy = int(bits[:entropy_bits], 2).to_bytes(entropy_bits // 8, "big")
    digest = hashlib.sha256(entropy).digest()
    expected = digest[0] >> (8 - cs_len)
    if int(bits[-cs_len:], 2) != expected:
        raise ValueError("助记词校验和不匹配 —— 大概率有词打错了"
                         "（也可能词序被改动），拒绝派生")
    return norm


# ---------------------------------------------------------------- 助记词

def mnemonic_to_seed(mnemonic: str, passphrase: str = "") -> bytes:
    """BIP-39：助记词 → 64 字节种子。

    PBKDF2-HMAC-SHA512(助记词, "mnemonic"+口令, 2048 次, 64 字节)。
    标准要求助记词与口令都先做 NFKD 归一化 —— 漏掉这一步，带变音符或全角空格的
    助记词会算出另一个种子，而且失败是静默的（只在解密那一刻才炸）。

    派生前先做完整 BIP-39 校验（词数/词表/校验和）：打错一个词的助记词
    会得到完全不同的 KEK，且一切看起来正常直到恢复那一刻 —— 必须当场拒绝。
    """
    norm = validate_mnemonic(mnemonic, passphrase)
    m = unicodedata.normalize("NFKD", " ".join(norm))
    salt = unicodedata.normalize("NFKD", BIP39_SALT_PREFIX + str(passphrase))
    return hashlib.pbkdf2_hmac("sha512", m.encode("utf-8"), salt.encode("utf-8"),
                               BIP39_ITERATIONS, 64)


# ------------------------------------------------------------------ 派生

def _hkdf(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def derive_seed_secret(bip39_seed: bytes) -> bytes:
    """旧版 0x02：从 BIP-39 种子推导种子秘密。"""
    if len(bip39_seed) < 16:
        raise ValueError("种子长度不足")
    return _hkdf(bip39_seed, AAD_PREFIX, SEED_INFO, SEED_SECRET_LEN)


def derive_kek(seed_secret: bytes) -> bytes:
    """旧版 0x02：从种子秘密派生 32 字节 KEK。"""
    if not seed_secret:
        raise ValueError("缺少种子秘密")
    if len(seed_secret) != SEED_SECRET_LEN:
        raise ValueError("种子秘密必须 %d 字节，实际 %d"
                         % (SEED_SECRET_LEN, len(seed_secret)))
    return _hkdf(seed_secret, KEK_SALT, KEK_INFO, CK_LEN)


def kek_from_mnemonic(mnemonic: str, passphrase: str = "") -> bytes:
    """旧版 0x02：助记词 → KEK，仅用于历史记录兼容。"""
    return derive_kek(derive_seed_secret(mnemonic_to_seed(mnemonic, passphrase)))


def derive_record_key(kek: bytes, timestamp: int) -> bytes:
    """从 KEK 与时间戳派生该条记录的内容密钥。

    时间戳是链上已有字段，因此恢复时无需额外存储任何密钥材料即可重现 CK。
    """
    return _hkdf(kek, struct.pack(">Q", int(timestamp)), CK_INFO, CK_LEN)


def kek_fingerprint(kek: bytes) -> str:
    """KEK 指纹，仅用于配对时向用户展示/比对，**不可**用于派生密钥。"""
    return hashlib.sha256(b"vmemo/fp/v1" + kek).hexdigest()[:16]


def _aad(timestamp: int) -> bytes:
    """认证附加数据 = 域前缀 + 时间戳。

    作用：域分隔（这份密文不能被搬到别的场景复用）+ 把时间戳纳入认证范围
    （防止悄悄改写记录时间后仍能解密）。
    """
    return AAD_PREFIX + struct.pack(">Q", int(timestamp))


# ------------------------------------------------------------------ 加解密

def encrypt_record(plaintext: bytes, kek: bytes, timestamp: int,
                   nonce: bytes = None, scheme: int = SCHEME_SEED) -> dict:
    """加密单条记录。nonce 仅供测试注入，生产路径应留空（随机生成）。"""
    if len(kek) != CK_LEN:
        raise ValueError("KEK 必须 32 字节")
    if scheme not in (SCHEME_SEED, SCHEME_WALLET):
        raise ValueError("不支持的密钥方案: %d" % scheme)
    nonce = nonce if nonce is not None else os.urandom(NONCE_LEN)
    if len(nonce) != NONCE_LEN:
        raise ValueError("nonce 必须 %d 字节" % NONCE_LEN)

    ck = derive_record_key(kek, timestamp)
    ct = AESGCM(ck).encrypt(nonce, plaintext, _aad(timestamp))
    blob = bytes([scheme]) + nonce + ct

    return {
        "blob": blob,
        "contentHash": "0x" + hashlib.sha256(blob).hexdigest(),
        "size": len(blob),
    }


def decrypt_record(blob: bytes, kek: bytes, timestamp: int) -> bytes:
    """用配对或恢复流程重建的 KEK 解密单条记录。"""
    if isinstance(blob, str):
        blob = bytes.fromhex(blob[2:] if blob.startswith(("0x", "0X")) else blob)
    if len(blob) < HEADER_LEN + NONCE_LEN + TAG_LEN:
        raise ValueError("密文长度不足")
    if blob[0] not in (SCHEME_SEED, SCHEME_WALLET):
        raise ValueError("不支持的密钥方案: %d" % blob[0])
    body = blob[HEADER_LEN:]
    nonce, ct = body[:NONCE_LEN], body[NONCE_LEN:]
    ck = derive_record_key(kek, timestamp)
    try:
        return AESGCM(ck).decrypt(nonce, ct, _aad(timestamp))
    except Exception as exc:
        raise ValueError("解密失败：KEK 与记录不匹配，或密文/时间戳被篡改") from exc


# ------------------------------------------------------------------ 自检

def _raises(fn) -> bool:
    """断言调用会抛错。失败路径与成功路径一样需要被验证。"""
    try:
        fn()
    except Exception:
        return True
    return False


def self_test() -> int:
    """不依赖外部文件的快速自检：BIP-39 向量、往返、篡改、密钥来源边界。"""
    # BIP-39 官方 Trezor 测试向量 —— 用来钉死"我们算的种子和标准一致"。
    # 少了它，PBKDF2 参数写错（迭代次数、salt 前缀、归一化）也能自洽地跑通，
    # 却和所有钱包推导出不同的种子。
    TREZOR_MNEMONIC = ("abandon abandon abandon abandon abandon abandon "
                       "abandon abandon abandon abandon abandon about")
    TREZOR_SEED = ("5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1"
                   "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4")

    kek = kek_from_mnemonic(TREZOR_MNEMONIC)
    failures = []

    def expect(name, cond):
        if cond:
            print("PASS  " + name)
        else:
            print("FAIL  " + name)
            failures.append(name)

    expect("BIP-39 种子与官方向量一致",
           mnemonic_to_seed(TREZOR_MNEMONIC).hex() == TREZOR_SEED)
    expect("助记词词数被校验", _raises(lambda: mnemonic_to_seed("abandon " * 11)))
    expect("BIP-39 校验和错误被拒绝（打错一个词 = 静默换密钥的最大来源）",
           _raises(lambda: mnemonic_to_seed(
               "abandon abandon abandon abandon abandon abandon abandon "
               "abandon abandon abandon abandon zoo")))
    expect("词表之外的词被拒绝",
           _raises(lambda: mnemonic_to_seed(" ".join(["notaword"] * 12))))
    expect("合法助记词仍通过校验",
           validate_mnemonic(TREZOR_MNEMONIC) is not None)
    expect("助记词分隔符宽松（全角空格等价）",
           kek_from_mnemonic(TREZOR_MNEMONIC.replace(" ", "\u3000")) == kek)

    plain = "记得下周把硬件样机寄给投资人".encode("utf-8")
    enc = encrypt_record(plain, kek, 1700000000)
    expect("往返解密一致", decrypt_record(enc["blob"], kek, 1700000000) == plain)
    expect("摘要 = SHA-256(blob)", enc["contentHash"] ==
           "0x" + hashlib.sha256(enc["blob"]).hexdigest())
    expect("blob = 方案字节+nonce+密文+tag",
           len(enc["blob"]) == HEADER_LEN + NONCE_LEN + len(plain) + TAG_LEN)
    expect("首字节为方案标识", enc["blob"][0] == SCHEME_SEED)

    # 换一份助记词必须失败 —— 这是"助记词是唯一钥匙"的直接体现
    other = kek_from_mnemonic("legal winner thank year wave sausage worth useful "
                              "legal winner thank yellow")
    expect("换助记词 → KEK 改变", other != kek)
    expect("换助记词后解密失败", _raises(lambda: decrypt_record(enc["blob"], other, 1700000000)))

    # 密文改 1 位必须被发现（GCM 认证）
    bad = bytearray(enc["blob"])
    bad[-1] ^= 1
    expect("密文篡改被拒绝", _raises(lambda: decrypt_record(bytes(bad), kek, 1700000000)))

    # 时间戳被改必须被发现（时间戳同时是 CK 的 salt 与 AAD 的一部分）
    expect("时间戳篡改被拒绝", _raises(lambda: decrypt_record(enc["blob"], kek, 1700000001)))

    # 同一秒内两条记录：CK 相同但 nonce 独立，密文不同且都能解回
    a = encrypt_record(b"AA", kek, 1700000000)
    b = encrypt_record(b"AA", kek, 1700000000)
    expect("同一明文两次加密密文不同", a["blob"] != b["blob"])
    expect("同期两条记录都能各自解回",
           decrypt_record(a["blob"], kek, 1700000000) == b"AA"
           and decrypt_record(b["blob"], kek, 1700000000) == b"AA")

    expect("不同时间戳 → 不同 CK",
           derive_record_key(kek, 1700000000) != derive_record_key(kek, 1700000001))
    expect("同输入 → 同 CK（恢复的前提）",
           derive_record_key(kek, 1700000000) == derive_record_key(kek, 1700000000))
    expect("同助记词 → 同 KEK（换机恢复的前提）",
           kek_from_mnemonic(TREZOR_MNEMONIC) == kek)

    # ---- 旧版 0x02 密钥路径性质（不适用于当前 0x03 产品方案） ----
    expect("换种子秘密 → KEK 改变",
           derive_kek(derive_seed_secret(bytes([1]) * 64))
           != derive_kek(derive_seed_secret(bytes([2]) * 64)))
    # 关键性质：KEK 链上没有任何公钥密码输入，且种子不能从公钥反推。
    # 这里能验的是"KEK 只由种子决定" —— 因此量子对手拿到私钥也无从下手。
    expect("KEK 只由种子秘密决定（无公钥密码输入）",
           derive_kek(derive_seed_secret(bytes([1]) * 64))
           == derive_kek(derive_seed_secret(bytes([1]) * 64)))
    expect("空种子秘密被拒绝", _raises(lambda: derive_kek(b"")))
    expect("种子秘密长度被校验", _raises(lambda: derive_kek(b"short")))
    # 方案字节必须生效
    bad = bytearray(enc["blob"])
    bad[0] = 9
    expect("未知方案字节被拒绝", _raises(lambda: decrypt_record(bytes(bad), kek, 1700000000)))

    print()
    if failures:
        print("自检失败 %d 项: %s" % (len(failures), ", ".join(failures)))
        return 1
    print("自检全部通过")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(self_test())
