#!/usr/bin/env bash
# 生成"未加密/已加密 × 1条/2条"四组链接，供 measure_qr.py 实测二维码密度。
# 之所以单独放一个脚本：在终端里内联这些引号与 heredoc 很容易被 shell 吃掉。
set -eo pipefail
cd "$(dirname "$0")/../.."   # 到 AI-HARDWARE/

W=web3
D=$W/.tmp_qr
rm -rf "$D"; mkdir -p "$D/rec"
head -c 259278 /dev/urandom > "$D/rec/a.wav"
head -c 350000 /dev/urandom > "$D/rec/b.wav"

KEK=$(python3 -c "
import sys; sys.path.insert(0,'lab/crypto')
import pipeline as P
print(P.derive_kek(P.derive_seed_secret(bytes(range(64)))).hex())" 2>/dev/null | tail -1)
echo "KEK 指纹: $(python3 -c "
import sys; sys.path.insert(0,'lab/crypto')
import pipeline as P
print(P.kek_fingerprint(bytes.fromhex('$KEK')))" 2>/dev/null | tail -1)"

gen() {  # gen <输出名> <是否加密> <文件...>
  local name=$1 enc=$2; shift 2
  local extra=()
  [ "$enc" = "1" ] && extra=(--kek "$KEK")
  python3 "$W/tools/make_payload.py" \
    --contract 0x1111111111111111111111111111111111111111 --chain-id 31337 \
    --page-url https://memo.example.invalid/i.html \
    "${extra[@]}" --out "$D/link_$name.txt" "$@" > "$D/log_$name.txt" 2>&1
  printf '%-12s 载荷 %s 字节\n' "$name" \
    "$(grep 'JSON 体积' "$D/log_$name.txt" | head -1 | awk '{print $2}')"
}

gen plain_1 0 --file "$D/rec/a.wav"
gen enc_1   1 --file "$D/rec/a.wav" --blobs-out "$D/blobs_1.json"
gen plain_2 0 --file "$D/rec/a.wav" --file "$D/rec/b.wav"
gen enc_2   1 --file "$D/rec/a.wav" --file "$D/rec/b.wav" --blobs-out "$D/blobs_2.json"

echo
echo "链接文件:"
wc -c "$D"/link_*.txt | sed 's|.*/||'
