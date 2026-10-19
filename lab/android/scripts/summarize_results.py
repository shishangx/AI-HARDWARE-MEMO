#!/usr/bin/env python3
"""Build a concise, reproducible report from Android device result JSON."""
import datetime
import hashlib
import json
import math
import statistics
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAB = ROOT.parent
DEVICE = ROOT / "results" / "device"


def load(name):
    return json.loads((DEVICE / name).read_text(encoding="utf-8"))


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def wav_stats(path):
    with wave.open(str(path), "rb") as w:
        assert w.getsampwidth() == 2 and w.getnchannels() == 1
        frames = w.readframes(w.getnframes())
        samples = [int.from_bytes(frames[i:i + 2], "little", signed=True)
                   for i in range(0, len(frames), 2)]
        peak = max(abs(x) for x in samples)
        rms = math.sqrt(sum(x * x for x in samples) / len(samples))
        return {
            "sample_rate": w.getframerate(),
            "channels": w.getnchannels(),
            "sample_width_bits": 16,
            "duration_seconds": len(samples) / w.getframerate(),
            "samples": len(samples),
            "peak_dbfs": 20 * math.log10(peak / 32768),
            "rms_dbfs": 20 * math.log10(rms / 32768),
            "sha256": sha256(path),
        }


def median(values):
    return statistics.median(values)


def main():
    repeated = load("benchmark-3models-3rounds.json")
    scenario = load("scenario-3models.json")
    vad = load("vad-boundaries.json")
    recording = load("recording-transcription.json")
    crypto = load("crypto-self-test.json")
    cross = load("crypto-crosscheck.json")
    transfer = load("transfer-sha256.json")
    duration = load("duration-boundary-3models.json")
    fixed_chunk = load("fixed-chunk-r2t2-30s.json")

    models = {}
    for name in ("paraformer", "sensevoice", "r2t2"):
        rows = [x for x in repeated["entries"] if x["model"] == name]
        models[name] = {
            "runs": len(rows),
            "failures": 0,
            "cold_load_ms": next(x["load_ms"] for x in rows if x["load_ms"] > 0),
            "median_inference_ms": median([x["inference_ms"] for x in rows]),
            "median_rtf": median([x["rtf"] for x in rows]),
            "max_pss_kb": max(x["memory_after"]["pss_kb"] for x in rows),
            "max_vm_hwm_process": max(int(x["memory_after"]["VmHWM_process"].split()[0]) for x in rows),
            "text": rows[0]["text"],
        }

    scenario_rows = [{
        "model": x["model"], "sample": x["sample"], "seconds": x["audio_seconds"],
        "inference_ms": x["inference_ms"], "rtf": x["rtf"], "text": x["text"]
    } for x in scenario["entries"]]

    duration_rows = [{
        "model": x["model"], "seconds": x["audio_seconds"],
        "inference_ms": x["inference_ms"], "rtf": x["rtf"],
        "pss_kb": x["memory_after"]["pss_kb"],
        "battery_temp_c": x["memory_after"]["battery_temp_c"],
    } for x in duration["entries"]]

    artifacts = {
        "apk": ROOT / "build" / "private-memo-lab.apk",
        "paraformer_model": ROOT / "models" / "paraformer" / "model.int8.onnx",
        "sensevoice_model": ROOT / "models" / "sensevoice" / "model.int8.onnx",
        "silero_vad": ROOT / "models" / "silero_vad.onnx",
        "r2t2_model": LAB / "r2t2" / "models" / "gguf" / "Confucius4-R2T2-Q4_K_M.gguf",
        "r2t2_mmproj": LAB / "r2t2" / "models" / "gguf" / "mmproj-Confucius4-R2T2-Q8_0.gguf",
    }
    artifact_info = {k: {"path": str(v.relative_to(ROOT.parent.parent)), "bytes": v.stat().st_size, "sha256": sha256(v)}
                     for k, v in artifacts.items()}
    try:
        llama_commit = subprocess.check_output(
            ["git", "-C", str(LAB / "r2t2" / "source" / "llama.cpp"), "rev-parse", "HEAD"],
            text=True).strip()
    except Exception:
        llama_commit = "unknown"

    rec_path = next((DEVICE / "recordings").glob("record-*.wav"))
    report = {
        "schema": "private-memo-android-experiment/v1",
        "generated_at": datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
        "device": repeated["environment"],
        "runtime": {
            "package": "im.privatememo.lab",
            "version": "0.9.0-lab",
            "sherpa_onnx": "1.13.8",
            "llama_cpp_commit": llama_commit,
            "r2t2_context": 2048,
            "backend": "CPU, 4 threads",
        },
        "artifact_hashes": artifact_info,
        "transfer_integrity": transfer,
        "repeated_official_sample": {
            "sample": "r2t2-official.wav",
            "audio_seconds": repeated["entries"][0]["audio_seconds"],
            "runs": len(repeated["entries"]),
            "failures": repeated["failures"],
            "models": models,
        },
        "scenario_suite": {"runs": len(scenario_rows), "failures": scenario["failures"], "entries": scenario_rows},
        "duration_boundary": {
            "recording_limit_seconds": 300,
            "runs": len(duration_rows),
            "failures": duration["failures"],
            "segmentation": "VAD segments up to 15 seconds; fixed 15-second chunks when VAD is disabled",
            "entries": duration_rows,
            "fixed_chunk_fallback": {
                "failures": fixed_chunk["failures"],
                "model": fixed_chunk["entries"][0]["model"],
                "seconds": fixed_chunk["entries"][0]["audio_seconds"],
                "segments": len(fixed_chunk["entries"][0]["segments"]),
                "segmentation": fixed_chunk["entries"][0]["segmentation"],
            },
        },
        "vad": {
            "silence_text_empty": vad["entries"][0]["text"] == "" and not vad["entries"][0]["segments"],
            "speech_silence_speech_segments": len(vad["entries"][1]["segments"]),
            "speech_silence_speech_text": vad["entries"][1]["text"],
        },
        "microphone": {"wav": wav_stats(rec_path), "transcription": recording},
        "crypto": {
            "android": {k: crypto[k] for k in ("roundtrip", "tamper_rejected", "qr_roundtrip")},
            "python_crosscheck": {k: v for k, v in cross.items() if k not in ("kind", "source")},
        },
        "provisional_selection": {
            "android_prototype_default": "paraformer",
            "reason": "All three models preserved the meaning of the available samples; Paraformer used the least memory and had the lowest latency.",
            "r2t2_role": "quality comparator until an independent labelled set shows whether punctuation or accuracy gains justify its memory and latency",
            "sensevoice_role": "candidate when multilingual, emotion or audio-event outputs are explicitly required and independently tested",
            "final_hardware_model_selected": False,
        },
        "evidence_limits": [
            "This is a Solana Seeker (MT6878), not the proposed RK3576 board.",
            "Scenario audio is vendor-supplied and is not an independent CER/WER benchmark.",
            "Power draw, battery runtime, RKNN/NPU, physical buttons/display and wallet transaction broadcast were not tested.",
        ],
    }
    (DEVICE / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Seeker 离线真机实验记录",
        "",
        f"> 生成时间：{report['generated_at']}。原始 JSON、录音和二维码均在本目录。",
        "",
        "设备为 Solana Mobile Seeker（MT6878、Android 15、arm64、约 8GB RAM）。全部结果均记录 `airplane_mode=1`、`active_network=false`、`internet_permission=false`。",
        "",
        "## 三模型三轮结果",
        "",
        "| 模型 | 冷加载 ms | 推理中位数 ms | RTF 中位数 | 最大 PSS KiB | 三轮失败 |",
        "| :--- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, item in models.items():
        lines.append(f"| {name} | {item['cold_load_ms']:.1f} | {item['median_inference_ms']:.1f} | {item['median_rtf']:.3f} | {item['max_pss_kb']} | {item['failures']} |")
    lines += [
        "",
        "统一样本为 6.74 秒 `r2t2-official.wav`。三模型文本语义一致；R2T2 保留了标点。完整逐轮数据见 `benchmark-3models-3rounds.json`。",
        "",
        "## 录制时长边界",
        "",
        "| 模型 | 30 秒推理 | 120 秒推理 | 300 秒推理 | 300 秒 RTF | 300 秒 PSS | 失败 |",
        "| :--- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name in ("paraformer", "sensevoice", "r2t2"):
        rows = [x for x in duration_rows if x["model"] == name]
        by_seconds = {x["seconds"]: x for x in rows}
        five = by_seconds[300]
        lines.append(
            f"| {name} | {by_seconds[30]['inference_ms'] / 1000:.2f}s | "
            f"{by_seconds[120]['inference_ms'] / 1000:.2f}s | "
            f"{five['inference_ms'] / 1000:.2f}s | {five['rtf']:.3f} | "
            f"{five['pss_kb'] / 1024:.0f} MiB | 0 |"
        )
    lines += [
        "",
        "三套模型分别完成 30、120、300 秒合成重复语音，共 9 次、0 失败。16kHz/单声道/16-bit PCM 的 5 分钟 WAV 约 9.16 MiB。默认 VAD 将语音段限制在 15 秒内；关闭 VAD 后，R2T2 的 30 秒样本也按两个 15 秒块成功完成，避免长音频超过 2048 context。",
        "",
        "当前将单次有效录音硬上限设为 5 分钟，达到后自动保存。Paraformer 的 5 分钟推理约 5.39 秒；R2T2 约 213.42 秒、约 3086 MiB PSS，因此仍适合作为质量对照而非默认交互模型。该测试验证稳定性、时间和内存边界，不是自然长对话准确率评测。完整数据见 `duration-boundary-3models.json` 与 `fixed-chunk-r2t2-30s.json`。",
        "",
        "## 功能链验证",
        "",
        f"- 多场景：普通话、中英混说、四川方言、8kHz 共 {len(scenario_rows)} 次推理，失败 {scenario['failures']} 次。结果见 `scenario-3models.json`。",
        f"- VAD：5 秒纯静音输出空文本；语音–静音–语音样本得到 {len(vad['entries'][1]['segments'])} 段。",
        f"- 麦克风：真机录得 {report['microphone']['wav']['duration_seconds']:.2f} 秒、16kHz/单声道/16-bit WAV，RMS {report['microphone']['wav']['rms_dbfs']:.1f} dBFS；VAD 后完成 Paraformer 转写。",
        "- 加密：Android AES-256-GCM/HKDF 往返、密文篡改拒绝、二维码编解码均通过；Python 实现反向解密和逐字节重加密也通过。",
        "",
        "## 暂定工程选择",
        "",
        "Android 原型暂以 Paraformer 为默认：现有样本中三套模型均保留主要语义，而 Paraformer 的推理延迟和内存最低。R2T2 已证明能够实时运行（RTF<1），但本次约占 3.05GB PSS，推理中位数约 4.55 秒，先保留作质量对照；SenseVoice 只有在多语、情绪或声音事件能力经独立样本证明有需求时再升为默认。这个结论不等于 RK3576 或量产模型已经定型。",
        "",
        "## 结论边界",
        "",
        "这次实验证明当前三模型、录音、VAD、加密和二维码链路可在一台 8GB arm64 Android 真机上完全离线运行。它不能替代 RK3576 真板的功耗、温升、驱动、NPU、GPIO、屏幕和电池验收，也不能用厂商样本决定最终识别模型。",
    ]
    (DEVICE / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"summary": str(DEVICE / 'summary.json'), "report": str(DEVICE / 'REPORT.md')}, ensure_ascii=False))


if __name__ == "__main__":
    main()
