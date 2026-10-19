#!/usr/bin/env bash
# 收集页面静态文件到一个文件夹，直接拖到 Vercel / Netlify 或用 git push 到 GitHub Pages。
#
# 为什么需要它：imToken 里**没有控制台**，页面一旦缺文件就是白屏、无法排查。
# 所以这里在打包前先把 index.html 里的每个 <script src> / <link href> 都验一遍，
# 缺哪个当场报出来，而不是等手机扫码后才发现。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../app"
OUT="${1:-$HERE/../dist-page}"

[ -d "$APP" ] || { echo "找不到 app 目录: $APP" >&2; exit 1; }
[ -f "$APP/index.html" ] || { echo "缺少 index.html" >&2; exit 1; }

echo "检查 index.html 的资源引用…"
missing=0
# 抽出本地资源名（跳过 http(s):// 与 协议相对地址；
# 再跳过 JS 运行时拼接的引用 —— 如 href="' + row.dataUrl + '"，不是静态文件）
refs="$(grep -oE '(src|href)="[^"]+"' "$APP/index.html" \
        | sed -E 's/.*="([^"]+)"/\1/' \
        | grep -vE '^(https?:)?//|^data:|^#|^mailto:' \
        | grep -v "[ '+]" || true)"
if [ -n "$refs" ]; then
  while IFS= read -r r; do
    [ -z "$r" ] && continue
    if [ -f "$APP/$r" ]; then
      printf '  ✓ %s\n' "$r"
    else
      printf '  ✗ %s  ← 文件不存在，页面在 imToken 里会白屏\n' "$r" >&2
      missing=1
    fi
  done <<<"$refs"
fi
[ "$missing" -eq 0 ] || { echo; echo "有缺失文件，先补齐再部署。" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT"
# 逐文件复制而不是 cp -r：避免把 .DS_Store 之类也带上
for f in index.html styles.css main.js abi.js crypto.js wallet_pairing.js qrcode.js bip39_english.txt vercel.json; do
  [ -f "$APP/$f" ] && cp "$APP/$f" "$OUT/$f" && printf '  打包 %s\n' "$f"
done

echo
echo "已生成: $OUT"
ls -la "$OUT" | tail -n +2 | awk '{printf "  %8s  %s\n", $5, $9}'
echo
cat <<'EOF'
下一步：
  · Vercel / Netlify —— 把整个文件夹拖进去，得到 https://<项目>.vercel.app/
  · GitHub Pages   —— push 到仓库后启用 Pages，得到 https://<用户>.github.io/<仓库>/index.html

⚠ Vercel 每次部署都是完整快照。即使只改一个文件，也必须上传本目录全部九个文件。
⚠ 不要用共享隧道域名（trycloudflare / ngrok 等），imToken 会拦截。
⚠ 上传的是公开代码，不含任何用户数据；载荷在 URL 的 # 之后，不会发给托管方。
EOF
