#!/usr/bin/env python3
"""实测加密对二维码密度的影响（需 segno，在 VM 内运行）。

加密会往载荷里塞 wrappedKey（每条 46 字节 → 92 个十六进制字符），
而二维码密度是本项目最紧的资源：历史上载荷 460 字节时密度过高、
手机扫不出来。所以这个增长必须实测，不能靠猜。
"""
import sys

import segno

D = sys.argv[1] if len(sys.argv) > 1 else "."

print("%-18s %10s %6s %7s" % ("场景", "链接长度", "版本", "模块数"))
print("-" * 46)
rows = {}
for mode, label in (("plain", "未加密"), ("enc", "已加密")):
    for n in (1, 2):
        with open("%s/link_%s_%d.txt" % (D, mode, n), encoding="utf-8") as fh:
            url = fh.read().strip()
        q = segno.make(url, error="l")
        rows[(mode, n)] = (len(url), int(q.version), int(q.symbol_size()[0]))
        print("%-18s %10d %6d %7d" % ("%s / %d 条" % (label, n),
                                      len(url), int(q.version), int(q.symbol_size()[0])))

print()
print("加密带来的增量：")
for n in (1, 2):
    p, e = rows[("plain", n)], rows[("enc", n)]
    print("  %d 条记录: 模块 %d → %d  (+%d, +%.0f%%)"
          % (n, p[2], e[2], e[2] - p[2], 100 * (e[2] - p[2]) / p[2]))

# 参考：历史上 93 模块 @3px 已无法解码，73 模块 @4.7px 可解码。
# 设备屏幕约 320px 宽时，可用像素 ≈ 300（留边框）。
print()
print("设备屏幕 320px 宽（可用 ≈300px）下的单模块像素：")
for n in (1, 2):
    e = rows[("enc", n)]
    px = 300.0 / (e[2] + 8)   # 8 = 4 模块静默区 × 2
    verdict = "充足" if px >= 4.0 else ("偏紧" if px >= 3.2 else "过密")
    print("  %d 条加密: %d 模块 → 每模块 %.2f px  (%s)" % (n, e[2], px, verdict))
