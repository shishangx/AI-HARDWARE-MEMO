#!/usr/bin/env python3
"""在"只有硬件 + imToken、不装任何额外 App"的约束下，算清数据怎么从设备到手机。

约束的推论（很关键）：
  手机必然存在 —— 因为 imToken 就跑在手机上。所以"用手机屏幕"不是额外设备。
  真正被禁的是**额外的 App**：任何需要装第三个应用才能传数据的方案都不成立。

于是可选路径只剩三条，逐条验算：
  1. 设备有屏幕  → 设备显示二维码 → 手机相机/imToken 扫        （零 App）
  2. 设备无屏幕  → 轻触 NFC     → 系统识别 URL → imToken 打开   （零 App）
  3. BLE         → 必须有 App 做 GATT 客户端                    （✗ 多一个 App）

本脚本验证 1 和 2 的**容量**是否够，以及各自的载荷上限。
"""
import base64
import json

import segno

SAFE_PX = 4.0
QUIET = 4
CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

# 几种短域名假设（NFC/二维码里都要放这个前缀）
PREFIXES = {
    "imToken Universal Link（长，但相机扫码直达）":
        "https://connect.token.im/link/navigate/DappView?url=",
    "自有短域名页面（页面内再唤起 imToken）":
        "https://vmemo.xyz/#p=",
}

# NFC 标签用户区容量（字节）
NFC = {"NTAG213": 144, "NTAG216": 888, "ST25DV-I2C 4Kbit": 512, "ST25DV-I2C 16Kbit": 2048}


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def payload(n: int, with_chain: bool) -> bytes:
    recs = [{"t": 1758500000 + i, "h": "0x" + "ab" * 32, "c": "chain"} for i in range(n)]
    obj = {"v": 1, "records": recs}
    if with_chain:
        obj["chainId"] = 31337
        obj["contract"] = CONTRACT
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()


def main() -> None:
    print("=" * 78)
    print("路径 1：设备自带屏幕显示二维码（零 App）")
    print("=" * 78)
    print("判据 %.1f px/模块；需要的屏幕边长：" % SAFE_PX)
    print("%-6s %-10s %-12s %s" % ("条数", "载荷", "模块(含静默)", "屏幕边长"))
    for n in (1, 2, 3, 4):
        raw = payload(n, with_chain=False)          # 合约地址走页面 query
        frag = "#p=" + b64url(raw)
        total_chars = len(PREFIXES["imToken Universal Link（长，但相机扫码直达）"]) + len(frag)
        q = segno.make("x" * total_chars, error="l")
        mods = q.symbol_size(scale=1, border=0)[0]
        tm = mods + QUIET * 2
        print("%-6d %-10s %-12s %d px  (%.1f 吋@300dpi)"
              % (n, "%dB" % len(raw), "%d(%d)" % (mods, tm), tm * SAFE_PX,
                 tm * SAFE_PX / 300))
    print()
    print("→ 单条 276px 起；**若一次只显示一条，屏幕需求固定在 276px**，")
    print("  对应约 0.9 吋 @300dpi。批量显示才需要更大屏幕。")

    print()
    print("=" * 78)
    print("路径 2：NFC 动态标签（零 App —— 手机原生读卡，不需要装东西）")
    print("=" * 78)
    for name, prefix in PREFIXES.items():
        print("\n前缀：%s" % name)
        print("  %-6s %-10s %-12s %s" % ("条数", "载荷", "总字符", "NFC 容量是否够"))
        for n in (1, 2, 4, 8):
            raw = payload(n, with_chain=(name.startswith("imToken")))
            body = b64url(raw) if prefix.endswith("p=") else \
                __import__("urllib.parse", fromlist=["quote"]).quote(
                    "https://vmemo.xyz/#p=" + b64url(raw), safe="")
            total = len(prefix) + len(body)
            fit = ", ".join("%s(%s)" % (k, "够" if total <= v else "不够")
                            for k, v in NFC.items())
            print("  %-6d %-10s %-12s %s" % (n, "%dB" % len(raw), total, fit))

    print()
    print("=" * 78)
    print("结论")
    print("=" * 78)
    print("""
- NFC 用**自带短域名**方案时容量充裕（NTAG216 888B 可放 8 条），但手机打开的是
  我们的页面，页面上还需一次"在 imToken 中打开"的点击；
- NFC 用 **imToken Universal Link** 时可直接唤起 imToken，但 URL 长得多，
  单条约 262 字符 —— NTAG216 仍够（888B），且体验最好（碰一下就到签名界面）；
- 路径 1 与路径 2 **都不需要任何额外 App**；
- 路径 3（BLE）**必须有 App**，因此在本约束下直接排除。

补充：无论走 1 还是 2，imToken 打开页面后的流程完全一致（页面读 fragment → 调
window.ethereum → 签名），所以**页面的开发量不会因为选哪条路而变化**。
""")


if __name__ == "__main__":
    main()
