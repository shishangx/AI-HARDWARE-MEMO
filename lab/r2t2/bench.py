#!/usr/bin/env python3
"""Benchmark the native llama.cpp backend shipped by Confucius4-R2T2."""

import argparse
import importlib
import json
import os
import platform
import resource
import sys
import time
import wave

import numpy as np


PROMPT = (
    "<|im_start|>system\n<|im_end|>\n"
    "<|im_start|>user\n"
    "<|audio_start|><|audio_pad|><|audio_end|>"
    "<|im_end|>\n<|im_start|>assistant\n"
    "language {language}<asr_text>"
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--native-dir", required=True,
                        help="Directory containing qwen3asr_native extension")
    parser.add_argument("--model", required=True)
    parser.add_argument("--mmproj", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--ctx", type=int, default=4096)
    parser.add_argument("--batch", type=int, default=1024)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--cpu-only", action="store_true")
    return parser.parse_args()


def max_rss_bytes():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if platform.system() == "Darwin" else value * 1024


def main():
    args = parse_args()
    sys.path.insert(0, args.native_dir)
    native = importlib.import_module("qwen3asr_native")

    with wave.open(args.audio, "rb") as wav:
        sample_rate = wav.getframerate()
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    if sample_rate != 16000 or channels != 1 or sample_width != 2:
        raise SystemExit(
            "expected mono 16kHz signed 16-bit PCM WAV, got "
            f"{sample_rate}Hz, {channels} channel(s), {sample_width * 8}-bit"
        )
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0

    started = time.perf_counter()
    backend = native.Qwen3ASRNative(
        args.model, args.mmproj, args.ctx, args.batch, args.threads,
        not args.cpu_only, -1,
    )
    load_seconds = time.perf_counter() - started
    rss_after_load = max_rss_bytes()

    timings = []
    result = None
    prompt = PROMPT.format(language=args.language)
    for _ in range(args.runs):
        started = time.perf_counter()
        result = backend.generate_once(np.asarray(audio), prompt, 256)
        timings.append(time.perf_counter() - started)

    audio_seconds = len(audio) / sample_rate
    print(json.dumps({
        "platform": platform.platform(),
        "machine": platform.machine(),
        "ctx": args.ctx,
        "batch": args.batch,
        "threads": args.threads,
        "cpu_only": args.cpu_only,
        "model_bytes": os.path.getsize(args.model),
        "mmproj_bytes": os.path.getsize(args.mmproj),
        "audio_seconds": audio_seconds,
        "load_seconds": load_seconds,
        "infer_seconds": timings,
        "stable_rtf": timings[-1] / audio_seconds,
        "max_rss_after_load_bytes": rss_after_load,
        "max_rss_final_bytes": max_rss_bytes(),
        "text": result["text"].strip(),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
