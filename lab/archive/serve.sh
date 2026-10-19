#!/usr/bin/env bash
# 启动 / 停止本地 LLM 推理服务 (llama-server, OpenAI 兼容 API)
set -uo pipefail

LAB="$HOME/companion-lab"
SERVER="$LAB/llama.cpp/build/bin/llama-server"
MODEL="$LAB/models/llm/Qwen3-0.6B-Q4_K_M.gguf"
PORT="${PORT:-8080}"
LOG=/tmp/llama-server.log

case "${1:-start}" in
  start)
    if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "服务已在运行: http://127.0.0.1:$PORT"
      exit 0
    fi
    nohup "$SERVER" -m "$MODEL" --host 127.0.0.1 --port "$PORT" \
      -t 6 -c 2048 > "$LOG" 2>&1 &
    echo -n "启动中"
    for _ in $(seq 1 60); do
      if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        echo " 就绪: http://127.0.0.1:$PORT"
        exit 0
      fi
      echo -n "."
      sleep 1
    done
    echo " 超时，请查看 $LOG"
    exit 1
    ;;
  stop)
    pkill -f 'llama-server.*Qwen3' && echo "已停止" || echo "未在运行"
    ;;
  status)
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 \
      && echo "运行中 (端口 $PORT)" || echo "未运行"
    ;;
  log)
    tail -20 "$LOG"
    ;;
  *)
    echo "用法: serve.sh [start|stop|status|log]"
    exit 1
    ;;
esac
