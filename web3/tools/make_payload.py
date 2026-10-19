#!/usr/bin/env python3
"""
设备端：把本地录音变成"待签批次"，并生成可供手机扫描的链接。

产物是两样东西：
  1. 载荷 (payload) —— JSON, 描述这一批要上链的记录
  2. 链接 —— 把载荷放进 URL 的 **fragment (#)** 后编码, 再包成 imToken 能识别的形式

为什么放 fragment 而不是 query: fragment 不会被浏览器发送给服务器,
因此静态托管方无法看到用户的记录摘要。这是本方案"不留用户数据"的具体落点。

关于加密（现状：已实现）
--------------------
本脚本对 **录音明文** 做 AES-256-GCM 加密，然后：
  * contentHash 对**密文**计算（不是明文 —— 上链摘要必须对应实际上链的字节）
  * 密文本体写入 sidecar 文件，不放进载荷：单条 22KB 远超二维码单帧上限 2953 字节
  * 载荷里**不含任何密钥材料**：内容密钥由 KEK + 时间戳派生，无需存储

当前产品方案由钱包对固定 EIP-712 声明的可重现签名派生 KEK；设备通过已认证
通道接收并保存 KEK，恢复时同一钱包再次签署该声明。`--mnemonic` 只保留给旧版
`0x02` 记录和历史测试脚本，不应输入持有真实资产的钱包助记词。

**没有助记词就不能产生可上链的记录** —— 若省略 --mnemonic，脚本会生成未加密记录
并打印警告，仅供开发调试，不可用于真实数据。

用法:
  make_payload.py --contract 0x... --chain-id 31337 [--rpc URL] \
      --mnemonic "十 二 个 单 词 …" --file recordings/a.wav [--name 标题] [--out link.txt]

生成换机恢复链接（页面只带公开定位信息，不携带任何密钥材料）:
  make_payload.py --recover --contract 0x... --chain-id 31337 \
      --owner 0x... --key-scheme wallet-signature-v1 \
      --deploy-block 12345 [--out recover.txt]
"""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time

# 设备侧加密管线（与 web3/app/crypto.js 同格式）
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "lab", "crypto"))
import pipeline as memo_crypto  # noqa: E402

# imToken 官方文档核实的唤起格式:
#   Deep Link      imtokenv2://navigate/DappView?url=<URL编码>
#   Universal Link https://connect.token.im/link/navigate/DappView?url=<URL编码>
# 后者是 HTTPS 链接, 可由手机相机或 imToken 扫码直接触发。
DEEP_LINK_PREFIX = "imtokenv2://navigate/DappView?url="
UNIVERSAL_LINK_PREFIX = "https://connect.token.im/link/navigate/DappView?url="

# 单帧二维码上限: version 40 / 二进制模式 / 最低纠错 = 2953 字节。
# 超出即必须在设备屏幕上做多帧动画二维码 (BC-UR), 不能塞进一张图。
QR_SINGLE_FRAME_MAX = 2953


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def sha256_file(path: str, chunk: int = 65536) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return "0x" + h.hexdigest()


ZERO32 = "0x" + "00" * 32


def build_record(path: str, kek: bytes = None, name: str = None,
                 timestamp: int = None) -> tuple:
    """构造单条待上链记录，返回 (记录, 密文十六进制 或 None)。

    载荷体积直接决定二维码密度, 密度决定手机能否扫得动, 因此这里刻意精简:
    值为"全零占位"的字段一律省略, 由页面补默认值。实测载荷从约 460 字节
    降到约 215 字节, 二维码从 93 模块降到约 70 模块, 才够手机扫。

    加密后 contentHash 是对**密文**的摘要, wrappedKey 是真实的密钥封装,
    因此这两项都不再是占位值。密文本体写 sidecar, 不占载荷空间。
    """
    stat = os.stat(path)
    ts = int(timestamp if timestamp is not None else stat.st_mtime)

    if kek is None:
        # 未加密路径：仅为兼容开发调试，摘要对应明文
        rec = {
            "t": ts,
            "h": sha256_file(path),
            "c": "local://" + os.path.basename(path),
        }
        return rec, None

    with open(path, "rb") as fh:
        plaintext = fh.read()
    enc = memo_crypto.encrypt_record(plaintext, kek, ts)
    # 载荷里不放 wrappedKey：内容密钥由 KEK+时间戳派生，无需存储密钥材料。
    # 实测若每条带上 46 字节封装，2 条记录时二维码会从 85 涨到 101 模块，
    # 在设备屏上每模块只剩 2.75px —— 而 93 模块 @3px 已扫不出来。
    rec = {
        "t": ts,
        "h": enc["contentHash"],
        "c": "chain",   # 密文走交易 calldata, 由 sidecar 提供
    }
    _ = name  # 标题暂不参与索引; 保留参数以免调用方改动
    return rec, enc["blob"].hex()


def build_payload(contract: str, chain_id: int, records, rpc_url: str = None,
                  chain_info: dict = None) -> dict:
    """组装载荷。rpcUrl / issuedAt 不放进载荷 —— 它们不参与链上写入,
    却要占几十字节的二维码空间, 而空间是这里最稀缺的资源。"""
    payload = {
        "v": 1,
        "chainId": int(chain_id),
        "contract": contract,
        "records": records,
    }
    if chain_info:
        # 钱包中未添加该链时, 页面会用 wallet_addEthereumChain 补上
        payload["chainInfo"] = chain_info
    return payload


def build_links(payload: dict, page_url: str) -> dict:
    """把载荷编码进 fragment, 再包成 imToken 链接。

    page_url 单独传入而不放进载荷: 它已经在外层链接里了, 再编码一次只是
    白白增大二维码 —— 而二维码尺寸直接决定手机能否扫得动。
    """
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded = b64url(raw)
    url = page_url + "#p=" + encoded

    # 页面地址需要整体 URL 编码后作为参数传给 imToken
    from urllib.parse import quote
    return {
        "payload_json": raw,
        "payload_size": len(raw),
        "fragment_chars": len(encoded),
        "page_url": url,
        "deep_link": DEEP_LINK_PREFIX + quote(url, safe=""),
        "universal_link": UNIVERSAL_LINK_PREFIX + quote(url, safe=""),
    }


def build_recovery_link(contract: str, chain_id: int, owner: str,
                        deploy_block: str = None, page_url: str = "",
                        key_scheme: str = "wallet-signature-v1") -> dict:
    """换机恢复链接：只带"去哪儿找"，不携带任何钥匙。

    钱包签名与 KEK **不进 URL**。载荷同样放在 fragment 里：fragment 不会发送给
    服务器，因此托管方连"有人在恢复"都看不到。
    deploy_block 走 query 参数（页面从 location.search 读），这样二维码里
    能省下几十字节。

    注意 owner 是**智能账户地址**（费用走 AA 代付，事件里的 owner 是它），
    不是签名用的 EOA 地址 —— 填错会一条记录也枚举不到。
    """
    payload = {
        "v": 1,
        "chainId": int(chain_id),
        "contract": contract,
        "owner": owner,
        "keyScheme": key_scheme,
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    url = page_url + (("?from=" + str(deploy_block)) if deploy_block else "")
    url += "#r=" + b64url(raw)

    from urllib.parse import quote
    return {
        "payload_json": raw,
        "payload_size": len(raw),
        "page_url": url,
        "deep_link": DEEP_LINK_PREFIX + quote(url, safe=""),
        "universal_link": UNIVERSAL_LINK_PREFIX + quote(url, safe=""),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", required=True, help="MemoryRegistry 合约地址")
    ap.add_argument("--chain-id", type=int, required=True)
    ap.add_argument("--rpc", default=None, help="只读 RPC, 供页面侧读取链上索引")
    ap.add_argument("--file", action="append", default=[], help="录音文件, 可多次")
    ap.add_argument("--mnemonic", default=None,
                    help="助记词 (设备侧入口)。省略则生成未加密记录, 仅供调试")
    ap.add_argument("--name", default=None, help="记录标题 (单文件时)")
    ap.add_argument("--page-url", default="https://example.invalid/memo/index.html")
    ap.add_argument("--out", default=None, help="把链接写入文件")
    ap.add_argument("--blobs-out", default=None,
                    help="把密文写入文件 (JSON: [{seq, timestamp, blob}]), 供上链使用")
    ap.add_argument("--blob-in-payload", action="store_true",
                    help="把密文直接塞进载荷（单帧二维码可承载的小录音专用）。"
                         "页面提交时改走 addBatchOnchain，密文随交易上链。"
                         "超过单帧上限则报错退出 —— 大录音必须走多帧动画二维码")
    ap.add_argument("--recover", action="store_true",
                    help="不生成待签批次, 而是生成换机恢复链接")
    ap.add_argument("--owner", default=None, help="恢复模式: 要恢复的地址 (智能账户地址)")
    ap.add_argument("--key-scheme", choices=("wallet-signature-v1", "mnemonic-v1"),
                    default="wallet-signature-v1",
                    help="恢复密钥方案；新记录默认钱包签名，mnemonic-v1 仅兼容旧记录")
    ap.add_argument("--deploy-block", default=None,
                    help="恢复模式: 合约部署块，仅供旧合约兼容扫描使用")
    args = ap.parse_args()

    if args.recover:
        if not args.owner or not re.fullmatch(r"0x[0-9a-fA-F]{40}", args.owner):
            print("--recover 需要 --owner <0x + 40 位十六进制>", file=sys.stderr)
            return 1
        info = build_recovery_link(args.contract, args.chain_id, args.owner,
                                   args.deploy_block, args.page_url, args.key_scheme)
        print("=== 换机恢复链接 ===")
        print("载荷:        %d 字节 (只含合约/链/地址, 不含任何钥匙)" % info["payload_size"])
        print("密钥方案:    " + args.key_scheme)
        print("密钥材料:    不进 URL；钱包签名仅在恢复页本地使用")
        print()
        print(info["universal_link"])
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(info["universal_link"] + "\n")
            print()
            print("已写入: " + args.out)
        return 0

    kek = None
    if args.mnemonic:
        try:
            kek = memo_crypto.kek_from_mnemonic(args.mnemonic)
        except ValueError as exc:
            print("助记词无效: %s" % exc, file=sys.stderr)
            return 1
    else:
        print("警告: 未提供 --mnemonic, 将生成**未加密**记录 (仅限开发调试)",
              file=sys.stderr)

    if not args.file:
        print("至少需要一个 --file", file=sys.stderr)
        return 1

    records, blobs = [], []
    for i, path in enumerate(args.file):
        if not os.path.isfile(path):
            print("文件不存在: " + path, file=sys.stderr)
            return 1
        name = args.name if (args.name and len(args.file) == 1) else os.path.basename(path)
        rec, blob = build_record(path, kek=kek, name=name)
        records.append(rec)
        if blob is not None:
            blobs.append({"seq": i, "timestamp": rec["t"], "blob": blob})

    if getattr(args, "blob_in_payload", False) and blobs:
        # 密文进载荷：页面提交时改走 addBatchOnchain，密文随用户签名的交易上链。
        # 这是"设备→页面"密文传输的最小可行通道（单帧）；大录音仍需多帧动画二维码。
        for i, r in enumerate(records):
            matching = [b["blob"] for b in blobs if b["seq"] == i]
            if not matching:
                print("警告: #%d 无密文（设备侧未加密），跳过附带" % i, file=sys.stderr)
                continue
            r["b"] = matching[0].replace("0x", "")
        # 超过单帧上限必须拒绝：宁可报错也不静默产出扫不出的二维码
        probe = build_payload(args.contract, args.chain_id, records, args.rpc)
        probe_raw = json.dumps(probe, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(probe_raw) > QR_SINGLE_FRAME_MAX:
            print("载荷 %d 字节超过单帧上限 %d —— 请缩短录音（或用 --blobs-out 走"
                  "多帧动画二维码，尚未实现）"
                  % (len(probe_raw), QR_SINGLE_FRAME_MAX), file=sys.stderr)
            return 1

    payload = build_payload(args.contract, args.chain_id, records, args.rpc)
    info = build_links(payload, args.page_url)

    qr_frames = -(-info["fragment_chars"] // QR_SINGLE_FRAME_MAX) or 1

    print("=== 载荷 ===")
    print("记录数:      %d" % len(records))
    print("加密:        %s" % ("是 (AES-256-GCM，密钥来自助记词)" if kek else "否 (明文)"))
    for i, r in enumerate(records):
        print("  #%d  %s  %s" % (i, r["h"][:18] + "…", r["c"]))
    if kek:
        print("KEK 指纹:    %s  (配对时可与手机端比对)" % memo_crypto.kek_fingerprint(kek))
        print("密文总量:    %d 字节 → 走交易 calldata, 不进二维码"
              % sum(len(b["blob"]) // 2 for b in blobs))
    print("JSON 体积:   %d 字节" % info["payload_size"])
    if len(records):
        print("每条载荷均:  %d 字节" % (info["payload_size"] // len(records)))
    print("链接总长:    %d 字符" % len(info["universal_link"]))
    print("单帧 QR 上限: %d 字节 → 需要约 %d 帧%s"
          % (QR_SINGLE_FRAME_MAX, qr_frames,
             " (超出单帧, 需动画二维码/BC-UR)" if qr_frames > 1 else ""))
    print()
    print("=== 链接 ===")
    print("Universal Link:")
    print(info["universal_link"])
    print()
    print("Deep Link:")
    print(info["deep_link"])

    if args.blobs_out and blobs:
        with open(args.blobs_out, "w", encoding="utf-8") as fh:
            json.dump(blobs, fh, ensure_ascii=False, indent=2)
        print()
        print("密文已写入: " + args.blobs_out)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(info["universal_link"] + "\n")
        print()
        print("已写入: " + args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
