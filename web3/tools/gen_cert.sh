#!/usr/bin/env bash
# 为局域网地址生成本地 CA 与服务器证书。
#
# 为什么需要
# --------
# imToken 在**明文 http** 下会打开页面但**不注入钱包 provider** ——
# 表现就是点"连接钱包"毫无反应。而免费隧道域名（trycloudflare 等）会被
# imToken 拦截，所以不依赖任何外部资源的唯一路径是：
# **在局域网内用 HTTPS，并让手机信任签发证书的 CA**。
#
# 关键点：证书必须带 **IP SAN**。手机用 IP 访问时，若证书只有域名 SAN，
# 会因"名称不匹配"被判为不安全连接，等于白做。
#
# 用法: gen_cert.sh <IP 或 主机名> [输出目录]
set -euo pipefail

TARGET="${1:-}"
OUT="${2:-}"

if [ -z "$TARGET" ]; then
  echo "用法: gen_cert.sh <IP 或 主机名> [输出目录]" >&2
  echo "例如: gen_cert.sh 192.168.0.151" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$OUT" ] || OUT="$HERE/../.state/certs"
mkdir -p "$OUT"

CA_KEY="$OUT/ca.key"
CA_CRT="$OUT/ca.crt"
SRV_KEY="$OUT/server.key"
SRV_CRT="$OUT/server.crt"
SRV_CSR="$OUT/server.csr"
EXT="$OUT/server.ext"

# 判断目标是 IP 还是域名, 决定用 IP SAN 还是 DNS SAN
if printf '%s' "$TARGET" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  SAN_LINE="IP.1 = $TARGET"
else
  SAN_LINE="DNS.1 = $TARGET"
fi

if [ ! -f "$CA_CRT" ]; then
  echo "生成 CA（有效期 10 年）…"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CA_KEY" -out "$CA_CRT" -days 3650 \
    -subj "/CN=Memo Lab Local CA/O=Memo Lab" >/dev/null 2>&1
else
  echo "复用已有 CA: $CA_CRT"
fi

echo "为 $TARGET 签发服务器证书（有效期 2 年）…"
openssl req -newkey rsa:2048 -nodes \
  -keyout "$SRV_KEY" -out "$SRV_CSR" \
  -subj "/CN=$TARGET/O=Memo Lab" >/dev/null 2>&1

cat > "$EXT" <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
$SAN_LINE
EOF

openssl x509 -req -in "$SRV_CSR" -CA "$CA_CRT" -CAkey "$CA_KEY" \
  -CAcreateserial -out "$SRV_CRT" -days 730 -extfile "$EXT" >/dev/null 2>&1

rm -f "$SRV_CSR" "$EXT"

echo
echo "已生成:"
echo "  CA 证书   $CA_CRT"
echo "  服务器证书 $SRV_CRT"
echo "  服务器私钥 $SRV_KEY"
echo
echo "证书 SAN:"
openssl x509 -in "$SRV_CRT" -noout -ext subjectAltName 2>/dev/null | tail -1
