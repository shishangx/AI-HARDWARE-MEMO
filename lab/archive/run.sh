#!/usr/bin/env bash
# 端侧伴聊硬件本地调试环境 (OrbStack arm64 Linux)
# 注意: sherpa-onnx 的识别结果输出到 stderr，不能丢弃 stderr。
set -uo pipefail

LAB="$HOME/companion-lab"
SHERPA="$LAB/sherpa-onnx"
LLAMA="$LAB/llama.cpp/build/bin/llama-cli"
LLM="$LAB/models/llm/Qwen3-0.6B-Q4_K_M.gguf"

export LD_LIBRARY_PATH="$SHERPA/lib"

# 模型档案: 用 MODEL_ID 环境变量选择
# 流式模型用 sherpa-onnx, 离线模型用 sherpa-onnx-offline
# 默认 paraformer-small: 实测体积最小(80M)、速度最快(RTF 0.005-0.01)、准确率最好
MODEL_ID="${MODEL_ID:-paraformer-small}"
NUM_THREADS="${NUM_THREADS:-4}"
PORT="${PORT:-8080}"
# 会话记录目录: 默认放在本脚本同级的 sessions/, 使文件直接落在 macOS 侧可见
SESSIONS="${SESSIONS:-$(cd "$(dirname "$0")" && pwd)/sessions}"

case "$MODEL_ID" in
  bilingual-2023)
    MODEL="$LAB/models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
    BIN="$SHERPA/bin/sherpa-onnx"
    ARGS=(--tokens="$MODEL/tokens.txt"
          --encoder="$MODEL/encoder-epoch-99-avg-1.int8.onnx"
          --decoder="$MODEL/decoder-epoch-99-avg-1.onnx"
          --joiner="$MODEL/joiner-epoch-99-avg-1.int8.onnx")
    SIZE="190M"
    ;;
  small-bilingual)
    MODEL="$LAB/models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16"
    BIN="$SHERPA/bin/sherpa-onnx"
    ARGS=(--tokens="$MODEL/tokens.txt"
          --encoder="$MODEL/encoder-epoch-99-avg-1.int8.onnx"
          --decoder="$MODEL/decoder-epoch-99-avg-1.onnx"
          --joiner="$MODEL/joiner-epoch-99-avg-1.int8.onnx")
    SIZE="48M"
    ;;
  sensevoice)
    MODEL="$LAB/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"
    BIN="$SHERPA/bin/sherpa-onnx-offline"
    ARGS=(--tokens="$MODEL/tokens.txt"
          --sense-voice-model="$MODEL/model.int8.onnx"
          --sense-voice-use-itn=1)
    SIZE="233M"
    ;;
  paraformer-small)
    MODEL="$LAB/models/sherpa-onnx-paraformer-zh-small-2024-03-09"
    BIN="$SHERPA/bin/sherpa-onnx-offline"
    ARGS=(--tokens="$MODEL/tokens.txt"
          --paraformer="$MODEL/model.int8.onnx")
    SIZE="80M"
    ;;
  *) echo "未知 MODEL_ID: $MODEL_ID (可用: bilingual-2023 small-bilingual sensevoice paraformer-small)"; exit 1 ;;
esac

ARGS+=(--num-threads="$NUM_THREADS")

# 行缓冲很关键: grep 默认块缓冲会让流式输出卡住数秒, 看起来"不实时"
clean() {
  stdbuf -oL -eL grep --line-buffered -viE \
    'cpuid_info|OnlineRecognizerConfig|OfflineRecognizerConfig|FeatureExtractorConfig|VadModelConfig|SileroVadModelConfig|TenVadModelConfig|ProviderConfig|SenseVoice|ALSA lib|Expression .alsa_|^ +|^$'
}

usage() {
  cat <<'EOF'
用法: run.sh <命令> [参数]

命令:
  mic              从 Mac 麦克风识别 (Ctrl-C 停止)
                   流式模型=边说边出字
                   离线模型=VAD 边界, 说完一句出整句 (TRAILING=1.0 可调)
  file <wav>        识别指定 WAV 文件
  samples          识别模型自带的测试音频
  bench            fp32 / int8 速度对比 (仅 bilingual-2023)
  asr <wav>         仅识别，输出纯文本
  pipeline <wav>    完整链路: 语音 -> ASR -> 大模型伴聊回复
  compare <wav>     跨模型对比体积/速度/准确率
  llm [问题]        与 Qwen3-0.6B 对话 (需先启动 serve.sh)
  llm-bench        LLM 生成速度基准
  check            自检环境

模型选择: MODEL_ID=<名称> run.sh ...
  paraformer-small  中英双语 (80M, 默认, 实测最快最准)
  sensevoice        中英日韩粤 (233M, 准确率接近, 附带情绪标签)
  small-bilingual   中英双语流式 (48M, 支持边说边出字)
  bilingual-2023    2023 社区双语流式 (190M, 方言场景表现差)

其它: NUM_THREADS=4 控制线程数
EOF
}

case "${1:-}" in
  mic)
    case "$MODEL_ID" in
      bilingual-2023|small-bilingual)
        # 流式模型: 边说边出字
        echo "开始流式识别，请说话 (Ctrl-C 停止)..."
        "$SHERPA/bin/sherpa-onnx-alsa" "${ARGS[@]}" plughw:0,0 2>&1 | clean
        ;;
      *)
        # 离线模型: VAD 边界识别 (不是固定分片, 按语言边界切分)
        # 不用 PortAudio 版工具, 因其按 hw 语义要求原生 16kHz
        MT=paraformer
        [ "$MODEL_ID" = "sensevoice" ] && MT=sense-voice
        mkdir -p "$SESSIONS"
        exec python3 "$(dirname "$0")/mic_rt.py" \
          --tokens "$MODEL/tokens.txt" \
          --model "$MODEL/model.int8.onnx" \
          --model-type "$MT" \
          --vad "$LAB/models/silero_vad.onnx" \
          --threads "$NUM_THREADS" \
          --trailing "${TRAILING:-1.0}" \
          --vad-threshold "${VAD_THRESHOLD:-0.5}" \
          --out "${OUT:-$SESSIONS/session-$(date +%Y%m%d-%H%M%S).jsonl}"
        ;;
    esac
    ;;
  struct)
    # 把会话记录整理成结构化 memo (模型服务由 structure.py 按需启停)
    F="${2:-}"
    if [ -z "$F" ]; then
      F=$(ls -t "$SESSIONS"/*.jsonl 2>/dev/null | head -1)
      [ -n "$F" ] || { echo "会话目录为空: $SESSIONS (先跑 run.sh mic)"; exit 1; }
      echo "使用最近会话: $(basename "$F")"
    fi
    exec python3 "$(dirname "$0")/structure.py" "$F"
    ;;
  ui)
    # 设备模拟器 (浏览器界面)。前台运行, Ctrl-C 停止。
    exec python3 "$(dirname "$0")/server.py" --port "${UI_PORT:-8099}"
    ;;
  file)
    [ $# -ge 2 ] || { echo "缺少 WAV 路径"; exit 1; }
    "$BIN" "${ARGS[@]}" "$2" 2>&1 | clean
    ;;  samples)
    for w in "$MODEL"/test_wavs/*.wav; do
      echo "--- $(basename "$w") ---"
      "$BIN" "${ARGS[@]}" "$w" 2>&1 | clean | grep -E 'RTF|^\{'
    done
    ;;
  bench)
    [ "$MODEL_ID" = "bilingual-2023" ] || { echo "bench 仅支持 bilingual-2023"; exit 1; }
    for q in "" ".int8"; do
      label=$([ -z "$q" ] && echo "fp32" || echo "int8")
      echo "--- $label ---"
      "$SHERPA/bin/sherpa-onnx" \
        --tokens="$MODEL/tokens.txt" \
        --encoder="$MODEL/encoder-epoch-99-avg-1${q}.onnx" \
        --decoder="$MODEL/decoder-epoch-99-avg-1${q}.onnx" \
        --joiner="$MODEL/joiner-epoch-99-avg-1${q}.onnx" \
        "$MODEL/test_wavs/0.wav" 2>&1 | grep -E 'RTF'
    done
    ;;
  asr)
    [ $# -ge 2 ] || { echo "缺少 WAV 路径"; exit 1; }
    # 识别结果在 stderr，需保留后再过滤日志
    "$BIN" "${ARGS[@]}" "$2" 2>&1 \
      | grep -oE '^\{.*' | python3 -c "import json,sys; print(json.load(sys.stdin)['text'])" 2>/dev/null \
      || echo "(识别失败)"
    ;;
  compare)
    [ $# -ge 2 ] || { echo "缺少 WAV 路径"; exit 1; }
    WAV="$2"
    printf '%-18s %7s %8s  %s\n' "模型" "体积" "RTF" "识别结果"
    for id in small-bilingual bilingual-2023 sensevoice paraformer-small; do
      case $id in
        bilingual-2023) D=sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20 ;;
        small-bilingual) D=sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16 ;;
        sensevoice) D=sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09 ;;
        paraformer-small) D=sherpa-onnx-paraformer-zh-small-2024-03-09 ;;
      esac
      if [ ! -d "$LAB/models/$D" ]; then
        printf '%-18s %7s %8s  %s\n' "$id" "-" "-" "(未下载)"
        continue
      fi
      SZ=$(MODEL_ID=$id bash "$0" size 2>/dev/null)
      OUT=$(MODEL_ID=$id bash "$0" raw "$WAV" 2>/dev/null)
      # 流式为 "RTF) = a/b = c", 离线为 "RTF): a / b = c", 均取行尾数字
      RTF=$(printf '%s' "$OUT" | grep -iE 'real time factor' | tail -1 | grep -oE '[0-9.]+$')
      TXT=$(printf '%s' "$OUT" | grep -oE '^\{.*' | tail -1 \
            | python3 -c "import json,sys; print(json.load(sys.stdin).get('text','').strip())" 2>/dev/null)
      printf '%-18s %7s %8s  %s\n' "$id" "$SZ" "${RTF:--}" "${TXT:-失败}"
    done
    ;;
  raw)
    [ $# -ge 2 ] || exit 1
    "$BIN" "${ARGS[@]}" "$2" 2>&1
    ;;
  size)
    # 只统计实际加载的模型文件, 而非整个目录 (目录可能含 fp32/多 chunk 变体)
    for a in "${ARGS[@]}"; do
      f="${a#*=}"
      [ -f "$f" ] && stat -c %s "$f"
    done | awk '{s+=$1} END {printf "%.0fM", (s+0)/1048576}'
    ;;
  pipeline)
    [ $# -ge 2 ] || { echo "缺少 WAV 路径"; exit 1; }
    echo "[1/2] 语音识别中..."
    TEXT=$(bash "$0" asr "$2")
    echo "      识别结果: $TEXT"
    echo "[2/2] 生成伴聊回复中..."
    bash "$0" llm "$TEXT"
    ;;
  llm)
    Q="${2:-你好，请用一句话介绍你自己。}"
    # 走 llama-server 的 OpenAI 兼容 API，避免 llama-cli 直接写 /dev/tty
    curl -s "http://127.0.0.1:${PORT:-8080}/v1/chat/completions" \
      -H 'Content-Type: application/json' \
      -d "$(python3 -c "
import json,sys
print(json.dumps({
  'messages':[{'role':'system','content':'你是一个温柔的倾听者，回复简短温暖，不超过40字。'},
              {'role':'user','content':sys.argv[1]}],
  'chat_template_kwargs':{'enable_thinking':False},
  'max_tokens':80,'temperature':0.7}))" "$Q")" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'].strip())"
    ;;
  llm-bench)
    "$LAB/llama.cpp/build/bin/llama-bench" -m "$LLM" -p 32 -n 128 -t 6 2>&1 | tail -6
    ;;
  check)
    echo "架构:   $(uname -m)"
    echo -n "二进制: "; [ -x "$SHERPA/bin/sherpa-onnx" ] && echo OK || echo MISSING
    echo -n "模型:   "; [ -f "$MODEL/tokens.txt" ] && echo OK || echo MISSING
    echo "声卡:"
    arecord -l 2>&1 | grep -E '^card' | sed 's/^/  /' || echo "  未检测到"
    ;;
  *)
    usage
    exit 1
    ;;
esac
