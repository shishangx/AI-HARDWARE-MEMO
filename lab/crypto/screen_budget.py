#!/usr/bin/env python3
"""算清"设备自带屏幕显示二维码"到底需要多大屏幕。

决定要不要给设备加屏幕的关键事实：一条记录最小要多少模块，以及对应的像素需求。
两条对照：
  A. 现状 —— 合约地址与 chainId 都塞在载荷里
  B. 优化 —— 二者移到页面 URL 的 query（每次部署只定一次，与 rpc/from 同理）

优化能否成立，决定了小屏（128/240px）是否可行。
"""
import base64
import json

import segno

# 实测可扫的门槛：93 模块 @3px 扫不出，73 模块 @4.7px 可以。
# 取偏保守的 4.0 px/模块作为"可靠"判据。
SAFE_PX = 4.0
QUIET = 4          # QR 规范要求的静默区，单位是模块

CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
CHAIN_ID = 31337


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def payload_a(n: int) -> bytes:
    """A: 合约与 chainId 在载荷里（现状）。"""
    recs = [{"t": 1758500000 + i, "h": "0x" + "ab" * 32, "c": "chain"} for i in range(n)]
    return json.dumps({"v": 1, "chainId": CHAIN_ID, "contract": CONTRACT, "records": recs},
                      separators=(",", ":"), ensure_ascii=False).encode()


def payload_b(n: int) -> bytes:
    """B: 合约与 chainId 移到 query，载荷只剩记录。"""
    recs = [{"t": 1758500000 + i, "h": "0x" + "ab" * 32, "c": "chain"} for i in range(n)]
    return json.dumps({"v": 1, "records": recs},
                      separators=(",", ":"), ensure_ascii=False).encode()


def measure(name: str, frag: str, prefix_len: int) -> tuple:
    """frag 是 fragment 部分；prefix_len 是 Universal Link 前缀等固定部分长度。"""
    total = prefix_len + len(frag)
    q = segno.make("x" * total, error="l")   # 用等长占位串估模块数（内容不影响容量）
    mods = q.symbol_size(scale=1, border=0)[0]
    total_mods = mods + QUIET * 2
    px = total_mods * SAFE_PX
    return mods, total_mods, px


# Universal Link 前缀 + URL 编码后的页面地址，实测约 108 字符
PREFIX = 108


def main() -> None:
    print("判据：每模块 ≥ %.1f px 视为可靠（实测 93 模块 @3px 失败、73 模块 @4.7px 成功）"
          % SAFE_PX)
    print()
    print("%-4s %-26s %-10s %-10s %s" % ("条数", "方案", "载荷", "模块数", "需要的屏幕边长"))
    print("-" * 76)
    screen_sizes = {"小屏 128px": 128, "OLED 240px": 240, "1.5\" 320px": 320, "2.4\" 480px": 480}
    for n in (1, 2, 4, 8):
        for tag, fn in (("A 现状", payload_a), ("B 合约移出", payload_b)):
            raw = fn(n)
            frag = "#p=" + b64url(raw)
            mods, tm, px = measure(tag, frag, PREFIX)
            verdict = ", ".join("%s %s" % (k, "可行" if v >= px else "不够")
                                for k, v in screen_sizes.items())
            print("%-4d %-26s %-10s %-10s %.0fpx   %s"
                  % (n, tag, "%dB" % len(raw), "%d(%d)" % (mods, tm), px, verdict))
        print()

    # 单条记录的构成明细，说明"还能不能再省"
    raw = payload_b(1)
    print("方案 B 单条载荷明细：")
    print("  %s" % raw.decode())
    print()
    print("不可再省的部分：contentHash 是 32 字节（64 hex），它是完整性的锚点。")
    print("可再省的部分：时间戳可用更短编码；字段名已极简。")


if __name__ == "__main__":
    main()
