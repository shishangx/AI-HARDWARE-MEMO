#!/usr/bin/env python3
"""
VAD 驱动的低延迟语音识别 (单进程 / 流式)。

设计要点
--------
1. 模型只加载一次。旧实现每识别一句就新起一个 sherpa-onnx-offline 进程,
   实测每次都要付出约 500ms 的模型加载开销 (推理本身只要几十毫秒)。
2. VAD 是流式的。音频按块喂给 VAD, 由 VAD 自己维护状态并吐出完整语音段,
   单个语音段的结束点就是句尾。旧实现每读一小段就把整个缓冲重跑一次
   VAD, 开销随句子长度平方增长, 在低功耗板子上会拖不动。
3. 只有 VAD 判定为语音的片段才送进识别器。paraformer 这类非自回归模型
   总会输出内容, 混入静音会产生 "我的我我我我我我" 的重复幻觉
   (实测 8 秒纯静音即触发)。

用法:
  mic_rt.py --tokens T --model M --vad V --model-type paraformer|sense-voice
  mic_rt.py ... --file x.wav     # 按实时节奏回放, 无麦克风时验证分段逻辑
  mic_rt.py ... --out s.jsonl    # 同时把每句写成结构化记录 (追加式)

输出格式 (JSONL, 每行一个 JSON 对象):
  {"type":"session", "started_at":..., "model":..., ...}   # 首行, 会话元信息
  {"type":"seg", "i":0, "t":0.36, "dur":4.72, "text":"..."} # 每句一条
追加写入, 崩溃时已写内容不丢; 下游可按行流式消费。
"""
import argparse
import datetime
import json
import re
import signal
import subprocess
import sys
import time
import wave
from collections import Counter

import numpy as np
import sherpa_onnx

RATE = 16000
BYTES_PER_SAMPLE = 2
RECORD_VERSION = 1


def is_hallucination(text: str) -> bool:
    """检测 paraformer 在静音/噪声上的重复幻觉。

    实测: 8 秒纯静音会被识别成 "我的我我我我我我我我的我了"。
    依据是单个字符占比异常高, 或出现长串重复。
    """
    if len(text) < 4:
        return False
    if re.search(r"(.)\1{3,}", text):
        return True
    top = max(Counter(text).values())
    return top / len(text) > 0.5


def build_recognizer(tokens: str, model: str, model_type: str, threads: int):
    if model_type == "sense-voice":
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            tokens=tokens, model=model,
            num_threads=threads, use_itn=True, language="auto")
    return sherpa_onnx.OfflineRecognizer.from_paraformer(
        tokens=tokens, paraformer=model, num_threads=threads)


def build_vad(vad_model: str, threshold: float, trailing: float,
              vad_min_speech: float, max_utt: float):
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = vad_model
    cfg.silero_vad.threshold = threshold
    # min_silence_duration 就是"句尾判定": 静音超过它才算一句说完
    cfg.silero_vad.min_silence_duration = trailing
    # 低于此长度的声音不当作语音, 避免噪声触发
    cfg.silero_vad.min_speech_duration = vad_min_speech
    cfg.silero_vad.max_speech_duration = max_utt
    cfg.sample_rate = RATE
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)


def stream_from_mic(device: str, chunk_bytes: int):
    """启动 arecord 并以块为单位产出 PCM。

    arecord 必须显式回收: 若父进程被 SIGTERM 杀死而 Python 默认处理
    不执行 finally, 子进程会变成孤儿并持续占用声卡 (表现为下次启动
    "Device or resource busy")。故注册信号处理做清理。
    """
    proc = subprocess.Popen(
        ["arecord", "-D", device, "-f", "S16_LE", "-r", str(RATE),
         "-c", "1", "-t", "raw", "-q"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )

    def cleanup(_signum=None, _frame=None):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        raise SystemExit(0)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, cleanup)

    try:
        while True:
            data = proc.stdout.read(chunk_bytes)
            if not data:
                break
            yield data
    finally:
        cleanup()


def stream_from_file(path: str, chunk_bytes: int):
    """按实时节奏回放 wav, 用于无麦克风时验证分段逻辑。"""
    with wave.open(path, "rb") as w:
        frames = w.readframes(w.getnframes())
    for i in range(0, len(frames), chunk_bytes):
        time.sleep(chunk_bytes / (RATE * BYTES_PER_SAMPLE))
        yield frames[i:i + chunk_bytes]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokens", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--vad", required=True)
    ap.add_argument("--model-type", default="paraformer")
    ap.add_argument("--device", default="plughw:0,0")
    ap.add_argument("--file", default=None, help="模拟回放, 不占用麦克风")
    ap.add_argument("--chunk", type=float, default=0.1, help="读取块时长(秒)")
    ap.add_argument("--trailing", type=float, default=1.0,
                    help="判定说完所需尾部静音(秒); 调小更快但可能截断句子")
    ap.add_argument("--min-speech", type=float, default=0.4,
                    help="短于此长度的语音段丢弃(秒)")
    ap.add_argument("--vad-threshold", type=float, default=0.5,
                    help="VAD 语音判定阈值, 噪声环境可调高 (如 0.65)")
    ap.add_argument("--vad-min-speech", type=float, default=0.15,
                    help="VAD 报告一段语音所需的最短时长(秒)")
    ap.add_argument("--max-utt", type=float, default=15.0, help="单句上限(秒)")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--out", default=None,
                    help="结构化记录输出路径 (JSONL, 追加写入); 省略则只打印")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    chunk_bytes = max(1, int(args.chunk * RATE * BYTES_PER_SAMPLE))

    if not args.quiet:
        print("加载模型...", flush=True)
    recognizer = build_recognizer(args.tokens, args.model,
                                  args.model_type, args.threads)
    vad = build_vad(args.vad, args.vad_threshold, args.trailing,
                    args.vad_min_speech, args.max_utt)

    source = (stream_from_file(args.file, chunk_bytes) if args.file
              else stream_from_mic(args.device, chunk_bytes))

    def transcribe(samples: np.ndarray) -> str:
        stream = recognizer.create_stream()
        stream.accept_waveform(RATE, samples)
        recognizer.decode_stream(stream)
        return stream.result.text.strip()

    # 结构化记录: 追加式 JSONL。崩溃时已落盘的行仍然有效,
    # 下游 (LLM 抽取 / 加密 / 上链) 可按行流式消费。
    out_fh = (open(args.out, "a", encoding="utf-8") if args.out else None)
    if out_fh:
        out_fh.write(json.dumps({
            "type": "session",
            "version": RECORD_VERSION,
            "started_at": datetime.datetime.now().astimezone()
                          .isoformat(timespec="seconds"),
            "model_type": args.model_type,
            "sample_rate": RATE,
            "vad_trailing": args.trailing,
        }, ensure_ascii=False) + "\n")
        out_fh.flush()

    seq = 0

    def drain() -> None:
        """取出 VAD 已封口的语音段, 识别后打印并写入结构化记录。"""
        nonlocal seq
        while not vad.empty():
            seg = vad.front
            seg_samples = np.array(seg.samples, dtype=np.float32)
            t_start = seg.start / RATE      # 流内绝对起点(秒)
            vad.pop()
            dur = len(seg_samples) / RATE
            if dur < args.min_speech:
                continue
            text = transcribe(seg_samples)
            if not text or is_hallucination(text):
                continue
            print(f"[{time.strftime('%T')}] {text}", flush=True)
            if out_fh:
                out_fh.write(json.dumps({
                    "type": "seg", "i": seq,
                    "t": round(t_start, 3), "dur": round(dur, 3),
                    "text": text,
                }, ensure_ascii=False) + "\n")
                out_fh.flush()
            seq += 1

    started = False
    try:
        for block in source:
            if not started:
                started = True
                if not args.quiet:
                    hint = "(回放模式)" if args.file else "(请说话，停顿后出字)"
                    print(f"VAD 实时识别已启动 {hint}", flush=True)

            # VAD 逐块吃音频并自行维护状态; 每吐出一段就是一个完整的语音段
            samples = np.frombuffer(block, dtype=np.int16).astype(np.float32)
            samples /= 32768.0
            vad.accept_waveform(samples)
            drain()

        # 流结束: 冲刷 VAD 内部缓冲, 否则最后一句会被丢掉
        vad.flush()
        drain()
    except KeyboardInterrupt:
        pass
    finally:
        if out_fh:
            out_fh.close()
        if not args.quiet:
            print("已停止。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
