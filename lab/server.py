#!/usr/bin/env python3
"""
语音备忘录设备模拟器 — 本地 HTTP 服务。

在浏览器里提供 iPod 风格的界面, 用"滚轮 + 按键"操作, 模拟便携硬件上的交互。
服务应跑在目标板 (或本项目的 arm64 开发机) 上; 浏览器可在另一台机器访问。

之所以做成"服务 + 网页"而不是桌面程序: 录音、降噪、识别都要在开发板上跑,
而开发板通常没有显示器。网页只做交互与显示, 算力活全留在板上。

设计取舍
--------
- 录音存**原始音频**, 不把降噪结果固化进文件。降噪是不可再生的逆向处理,
  原始数据一旦被覆盖就无法还原 (本项目后续要把录音上链防丢失)。
  降噪默认开启, 但作用在"播放试听"和"转文字"这两条消费路径上, 可在界面上切换。
- 只用标准库做 HTTP, 不引入 web 框架。目标板部署时依赖越少越好。

用法:
  server.py [--port 8099] [--device plughw:0,0]
"""
import argparse
import base64
import datetime
import hashlib
import importlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

from mic_rt import RATE, build_recognizer, build_vad, is_hallucination

# 上链相关工具: 载荷生成与链接编码放在 web3/ 下, 与合约/页面同处一地
_WEB3_TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "web3", "tools")
if _WEB3_TOOLS not in sys.path:
    sys.path.insert(0, _WEB3_TOOLS)

try:
    import make_payload as onchain
except ImportError:          # 允许在没有 web3 模块时仍能录音/识别
    onchain = None

# 设备侧加密管线。当前方案使用钱包恢复签名派生并配对写入的 KEK；
# 助记词派生只用于读取旧版 0x02 记录。
_CRYPTO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crypto")
if _CRYPTO_DIR not in sys.path:
    sys.path.insert(0, _CRYPTO_DIR)
try:
    import pipeline as memo_crypto
except ImportError:          # 缺少 cryptography 时仍可录音/识别
    memo_crypto = None

try:
    import segno             # 二维码渲染; 缺失时仅显示链接文本
except ImportError:
    segno = None

LAB = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(LAB, "ui")
REC_DIR = os.path.join(LAB, "recordings")
INDEX_PATH = os.path.join(REC_DIR, "index.json")
CHAIN_PATH = os.path.join(REC_DIR, "chain.jsonl")

CHUNK_BYTES = 3200          # 0.1s @16kHz mono s16le
DEFAULT_SETTINGS = {
    "denoise": True,        # 需求: 默认开启降噪
    "model_type": "r2t2",
    "vad_threshold": 0.5,
    "trailing": 1.0,
}

# 上链配置。真实部署时应指向已部署的 MemoryRegistry 与 HTTPS 页面地址。
# 当前产品路径由钱包 EIP-712 恢复签名派生 KEK；助记词路径只保留旧记录兼容。
# 给了 --mnemonic 会走旧路径；没配对则用明确标注的演示值。
# 关键是不能静默不加密 —— 否则界面看起来"已加密"，实际摘要仍针对明文。
DEMO_KEK_PASSPHRASE = b"vmemo-demo-simulator-do-not-use-in-production"
CRYPTO = {"kek": None, "demo": True, "scheme": "demo", "owner": ""}


def resolve_kek(mnemonic: str):
    """返回 (32 字节 KEK, 是否为演示值)。

    mnemonic 参数只服务旧版 0x02 记录；当前流程通过钱包签名配对写入 KEK。
    """
    if mnemonic:
        if memo_crypto is None:
            raise SystemExit("--mnemonic 需要 lab/crypto/pipeline.py 可导入 "
                             "(缺少 cryptography 依赖)")
        try:
            return memo_crypto.kek_from_mnemonic(mnemonic), False
        except ValueError as exc:
            raise SystemExit("--mnemonic 无效: %s" % exc)
    return hashlib.sha256(DEMO_KEK_PASSPHRASE).digest(), True


# 配对状态的持久化文件。模拟器用它等价"真机把种子秘密存进安全元件"：
# 真机上终身配对一次、密钥永不离开安全元件；模拟器没有安全元件，
# 用本地 0600 文件替代 —— 重启后仍是"已配对"，无需重复录入。
# ⚠ 真实硬件不可用明文文件存 KEK —— 必须放安全元件（P2 项）。
PAIRING_FILE = os.environ.get(
    "MEMO_PAIRING_FILE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".pairing"))


def load_pairing():
    """恢复配对信息；兼容旧版只保存 KEK 十六进制的文件。"""
    if memo_crypto is None or not os.path.isfile(PAIRING_FILE):
        return None
    try:
        with open(PAIRING_FILE, "r", encoding="utf-8") as fh:
            raw = fh.read().strip()
        if raw.startswith("{"):
            data = json.loads(raw)
            kek = bytes.fromhex(str(data.get("kek", "")).removeprefix("0x"))
            owner = str(data.get("owner", "")).lower()
            scheme = str(data.get("scheme", ""))
            if (len(kek) == 32 and scheme in ("wallet-signature-v1", "mnemonic-v1")
                    and (not owner or re.fullmatch(r"0x[0-9a-f]{40}", owner))):
                return {"kek": kek, "scheme": scheme, "owner": owner}
        else:
            kek = bytes.fromhex(raw)
            if len(kek) == 32:
                return {"kek": kek, "scheme": "mnemonic-v1", "owner": ""}
    except Exception:
        pass
    return None


def persist_pairing(kek: bytes, scheme: str = "mnemonic-v1", owner: str = "") -> None:
    """配对成功后把 KEK 写入本地文件（模拟器级持久化；真机=安全元件）。"""
    with open(PAIRING_FILE, "w", encoding="utf-8") as fh:
        json.dump({"v": 1, "kek": kek.hex(), "scheme": scheme,
                   "owner": owner.lower()}, fh, separators=(",", ":"))
    try:
        os.chmod(PAIRING_FILE, 0o600)
    except OSError:
        pass


def clear_pairing() -> None:
    """清除模拟器持久化配对并回到未配对状态；不删除任何录音或链上记录。"""
    try:
        os.unlink(PAIRING_FILE)
    except FileNotFoundError:
        pass
    demo_kek = hashlib.sha256(DEMO_KEK_PASSPHRASE).digest()
    CRYPTO.update(kek=demo_kek, demo=True, scheme="demo", owner="")


CHAIN_CONFIG = {
    "chainId": 31337,
    "contract": "",          # 空表示尚未部署, 生成载荷时会提示
    "pageUrl": "",           # 静态页面的 HTTPS 地址
    "rpcUrl": "",
    "pageUrlFile": "",       # 若设置, 每次生成二维码时从该文件读取页面地址
    "deployBlock": "",       # 合约部署区块, 供页面从该块开始扫描日志
}


def current_page_url() -> str:
    """页面地址。支持从文件读取, 因为 HTTPS 隧道地址每次启动都会变,
    写在文件里就不必反复重启本服务。"""
    f = CHAIN_CONFIG.get("pageUrlFile")
    if f and os.path.isfile(f):
        try:
            with open(f, encoding="utf-8") as fh:
                v = fh.read().strip()
            if v:
                return v
        except OSError:
            pass
    return CHAIN_CONFIG["pageUrl"]

# 屏幕可读性下限: 二维码每个模块至少要有这么多像素, 否则手机难以对焦识别。
MIN_PX_PER_MODULE = 3.0

# SVG 生成参数。scale 与 border 只影响输出的用户单位, 显示尺寸由 CSS 决定;
# 之所以留有余量, 是为了让注入的 viewBox 与内容严格对齐。
# border=4 是 QR 规范要求的静区宽度 —— 静区不足会显著降低识别率。
QR_SCALE = 4
QR_BORDER = 4


# ---------------------------------------------------------------- 模型路径

def find_models(root: str) -> dict:
    """在模型目录里定位各组件。找不到降噪模型时降噪功能自动降级。"""
    models = os.path.join(os.path.expanduser("~"), "companion-lab", "models")

    def first(prefix: str) -> str | None:
        if not os.path.isdir(models):
            return None
        for name in sorted(os.listdir(models)):
            if name.startswith(prefix) and os.path.isdir(os.path.join(models, name)):
                return os.path.join(models, name)
        return None

    para = first("sherpa-onnx-paraformer-zh-small")
    sense = first("sherpa-onnx-sense-voice")
    vad = os.path.join(models, "silero_vad.onnx")
    denoiser = os.path.join(models, "gtcrn_simple.onnx")
    r2t2_root = os.path.join(LAB, "r2t2")
    r2t2_native = os.path.join(
        r2t2_root, "source", "Confucius4-R2T2", "r2t2_llama", "native")
    r2t2_model = os.path.join(
        r2t2_root, "models", "gguf", "Confucius4-R2T2-Q4_K_M.gguf")
    r2t2_mmproj = os.path.join(
        r2t2_root, "models", "gguf", "mmproj-Confucius4-R2T2-Q8_0.gguf")
    return {
        "paraformer": para,
        "sense_voice": sense,
        "vad": vad if os.path.isfile(vad) else None,
        "denoiser": denoiser if os.path.isfile(denoiser) else None,
        "r2t2_native": r2t2_native if os.path.isdir(r2t2_native) else None,
        "r2t2_model": r2t2_model if os.path.isfile(r2t2_model) else None,
        "r2t2_mmproj": r2t2_mmproj if os.path.isfile(r2t2_mmproj) else None,
    }


# ---------------------------------------------------------------- 音频工具

def read_wav(path: str) -> np.ndarray:
    """读成 16kHz 单声道 float32。其他采样率按最近邻重采样。"""
    with wave.open(path, "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise ValueError(f"仅支持 16bit PCM, 实际 {sw * 8}bit")
    arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        arr = arr.reshape(-1, ch).mean(axis=1)
    if sr != RATE:
        idx = (np.arange(int(len(arr) * RATE / sr)) * sr / RATE).astype(np.int64)
        arr = arr[np.clip(idx, 0, len(arr) - 1)]
    return arr


def write_wav(path: str, samples: np.ndarray) -> None:
    pcm = np.clip(samples * 32768.0, -32768, 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


class Denoiser:
    """gtcrn 实时降噪器。按固定块长喂入, 保持流式状态。"""

    def __init__(self, model_path: str):
        cfg = sherpa_onnx.OnlineSpeechDenoiserConfig()
        cfg.model.gtcrn.model = model_path
        self._d = sherpa_onnx.OnlineSpeechDenoiser(cfg)
        self._block = self._d.frame_shift_in_samples

    def reset(self) -> None:
        self._d.reset()

    def run(self, samples: np.ndarray) -> np.ndarray:
        out = []
        for i in range(0, len(samples), self._block):
            piece = samples[i:i + self._block]
            if len(piece) < self._block:      # 余数补齐, 否则末段被丢掉
                piece = np.pad(piece, (0, self._block - len(piece)))
            got = self._d.run(piece, RATE)
            if got.samples:
                out.append(np.array(got.samples, dtype=np.float32))
        return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


# ---------------------------------------------------------------- 引擎 (模型常驻)

class Engine:
    """识别与降噪模型只在首次使用时加载, 之后常驻复用。

    实测模型加载约 0.7s, 而单次推理只要几十毫秒; 每次重新加载会让
    "录音转文字"变得难以忍受。
    """

    def __init__(self, models: dict, settings: dict):
        self.models = models
        self.settings = dict(settings)
        self._lock = threading.Lock()
        self._recognizer = None
        self._recognizer_key = None
        self._denoiser = None
        self._r2t2 = None

    def recognizer(self):
        mtype = self.settings["model_type"]
        if mtype == "sense-voice" and self.models.get("sense_voice"):
            path = os.path.join(self.models["sense_voice"], "model.int8.onnx")
        else:
            mtype = "paraformer"
            path = os.path.join(self.models["paraformer"], "model.int8.onnx")
        key = (mtype, path)
        if self._recognizer is None or self._recognizer_key != key:
            self._recognizer = build_recognizer(
                os.path.join(os.path.dirname(path), "tokens.txt"), path, mtype, 4)
            self._recognizer_key = key
        return self._recognizer

    def denoiser(self) -> Denoiser | None:
        if not self.models.get("denoiser"):
            return None
        if self._denoiser is None:
            self._denoiser = Denoiser(self.models["denoiser"])
        return self._denoiser

    def r2t2(self):
        if self._r2t2 is None:
            required = ("r2t2_native", "r2t2_model", "r2t2_mmproj")
            missing = [name for name in required if not self.models.get(name)]
            if missing:
                raise RuntimeError("R2T2 文件缺失: " + ", ".join(missing))
            if self.models["r2t2_native"] not in sys.path:
                sys.path.insert(0, self.models["r2t2_native"])
            native = importlib.import_module("qwen3asr_native")
            self._r2t2 = native.Qwen3ASRNative(
                self.models["r2t2_model"], self.models["r2t2_mmproj"],
                2048, 512, 8, False, -1)
        return self._r2t2

    @staticmethod
    def r2t2_prompt() -> str:
        return (
            "<|im_start|>system\n<|im_end|>\n"
            "<|im_start|>user\n"
            "<|audio_start|><|audio_pad|><|audio_end|>"
            "<|im_end|>\n<|im_start|>assistant\n"
            "language Chinese<asr_text>"
        )

    def denoise_array(self, samples: np.ndarray) -> np.ndarray:
        d = self.denoiser()
        if d is None:
            return samples
        with self._lock:
            d.reset()
            return d.run(samples)

    def transcribe(self, samples: np.ndarray, use_denoise: bool) -> list[dict]:
        """VAD 切分 + 识别。只把 VAD 判定为语音的片段送去识别 —
        非自回归模型 (paraformer) 对静音会输出重复幻觉。
        """
        if use_denoise:
            samples = self.denoise_array(samples)
        with self._lock:
            use_r2t2 = self.settings["model_type"] == "r2t2"
            rec = None if use_r2t2 else self.recognizer()
            r2t2 = self.r2t2() if use_r2t2 else None
            vad = build_vad(self.models["vad"], self.settings["vad_threshold"],
                            self.settings["trailing"], 0.15, 15.0)

            out: list[dict] = []

            def drain() -> None:
                # 必须在 pop() 之前把样本复制出来: front 指向 VAD 的内部缓冲,
                # pop 之后内容即失效。
                while not vad.empty():
                    seg = vad.front
                    seg_samples = np.array(seg.samples, dtype=np.float32)
                    start = seg.start / RATE
                    vad.pop()
                    dur = len(seg_samples) / RATE
                    if dur < 0.4:
                        continue
                    if use_r2t2:
                        result = r2t2.generate_once(
                            seg_samples, self.r2t2_prompt(), 256)
                        text = result["text"].strip()
                    else:
                        stream = rec.create_stream()
                        stream.accept_waveform(RATE, seg_samples)
                        rec.decode_stream(stream)
                        text = stream.result.text.strip()
                    if text and not is_hallucination(text):
                        out.append({"t": round(start, 2),
                                    "dur": round(dur, 2), "text": text})

            # 必须分块喂。实测一次性喂入 8.1s 音频, VAD 只认出末尾 0.21s;
            # 按 0.1s 分块喂则得到完整的一段。
            for i in range(0, len(samples), 1600):
                vad.accept_waveform(samples[i:i + 1600])
                drain()
            vad.flush()
            drain()
            return out


# ---------------------------------------------------------------- 录音

class Recorder:
    """持续录音到 wav。存原始音频 (不做降噪), 理由见模块头部说明。"""

    def __init__(self, device: str):
        self.device = device
        self._lock = threading.Lock()
        self._proc = None
        self._thread = None
        self._stop = threading.Event()
        self.active = False
        self.started_at = None
        self.path = None
        self.seconds = 0.0
        self.error = None

    def start(self) -> None:
        with self._lock:
            if self.active:
                return
            os.makedirs(REC_DIR, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            self.path = os.path.join(REC_DIR, f"{stamp}.wav")
            self._stop.clear()
            self.error = None
            self.seconds = 0.0
            self.started_at = time.time()
            self.active = True
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def _run(self) -> None:
        try:
            self._proc = subprocess.Popen(
                ["arecord", "-D", self.device, "-f", "S16_LE", "-r", str(RATE),
                 "-c", "1", "-t", "raw", "-q"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            with wave.open(self.path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                while not self._stop.is_set():
                    data = self._proc.stdout.read(CHUNK_BYTES)
                    if not data:
                        break
                    w.writeframes(data)
                    self.seconds += len(data) / 2 / RATE
        except Exception as e:                      # 声卡被占用等
            self.error = str(e)
        finally:
            self._reap()
            self.active = False

    def _reap(self) -> None:
        """必须显式回收 arecord, 否则孤儿进程会一直占用声卡。"""
        p = self._proc
        if p is not None and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                p.kill()
        self._proc = None

    def stop(self) -> dict | None:
        with self._lock:
            if not self.active:
                return None
            self._stop.set()
        if self._thread:
            self._thread.join(timeout=6)
        self._reap()
        self.active = False
        if self.error:
            return {"error": self.error}
        if not self.path or not os.path.isfile(self.path):
            return None
        if os.path.getsize(self.path) < 1024:        # 空录音, 丢弃
            os.remove(self.path)
            return None
        return {"path": self.path, "seconds": round(self.seconds, 2)}

    def state(self) -> dict:
        return {"active": self.active, "seconds": round(self.seconds, 2),
                "started_at": self.started_at, "error": self.error}


# ---------------------------------------------------------------- 元数据

_index_lock = threading.Lock()


def load_index() -> list[dict]:
    if not os.path.isfile(INDEX_PATH):
        return []
    try:
        with open(INDEX_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []


def save_index(items: list[dict]) -> None:
    os.makedirs(REC_DIR, exist_ok=True)
    tmp = INDEX_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, INDEX_PATH)      # 原子替换, 断电不产生半截文件


def add_record(path: str, seconds: float) -> dict:
    item = {
        "id": os.path.splitext(os.path.basename(path))[0],
        "name": time.strftime("%m月%d日 %H:%M", time.localtime()),
        "created_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "seconds": seconds,
        "size": os.path.getsize(path),
    }
    with _index_lock:
        items = load_index()
        items.insert(0, item)
        save_index(items)
    return item


def find_record(rec_id: str) -> tuple[dict | None, int]:
    for i, it in enumerate(load_index()):
        if it.get("id") == rec_id:
            return it, i
    return None, -1


def update_record(rec_id: str, patch: dict) -> dict | None:
    with _index_lock:
        items = load_index()
        for it in items:
            if it.get("id") == rec_id:
                it.update(patch)
                save_index(items)
                return it
    return None


def delete_record(rec_id: str) -> bool:
    path = os.path.join(REC_DIR, f"{rec_id}.wav")
    if os.path.isfile(path):
        os.remove(path)
    for extra in ("_denoised.wav",):
        p = os.path.join(REC_DIR, f"{rec_id}{extra}")
        if os.path.isfile(p):
            os.remove(p)
    with _index_lock:
        items = load_index()
        keep = [it for it in items if it.get("id") != rec_id]
        if len(keep) == len(items):
            return False
        save_index(keep)
    return True


def lan_ip() -> str | None:
    """本机默认出口地址。

    注意: 若本服务跑在虚拟机/容器里, 这里拿到的是**虚拟机自己的**地址
    (如 192.168.139.33), 手机无法访问 —— 手机需要的是宿主机的局域网地址。
    因此这个值只用于诊断提示, 不应作为对外地址的来源。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # 不真的发包: 只是让内核按默认路由选出本地出口地址
        s.connect(("192.0.2.1", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


# imToken 会拦截的共享隧道域名后缀。
# 这类域名被大量钓鱼页面使用, 钱包将其整体列入黑名单是合理的安全策略。
BLOCKED_TUNNEL_SUFFIXES = (
    ".trycloudflare.com", ".ngrok.io", ".ngrok-free.app", ".ngrok.app",
    ".loca.lt", ".localtunnel.me", ".serveo.net", ".telebit.io",
)

# 私有 / 保留网段。imToken 出于安全策略拒绝打开私有地址
# (可防 DNS rebinding 与内网探测), 因此这类地址只适合用手机浏览器验证。
PRIVATE_PREFIXES = ("10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.",
                    "172.2", "172.30.", "172.31.", "169.254.", "127.")


def is_private_host(host: str) -> bool:
    import ipaddress
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
    except ValueError:
        return host.endswith(".local") or host.startswith("localhost")


def imtoken_block_reason(host: str) -> str | None:
    """imToken 是否会拒绝该主机名。返回原因, 可接受则返回 None。

    实测结论(两轮踩坑):
      - 私有 IP (如 192.168.x.x): 被拒 —— 安全策略, 防 DNS rebinding 与内网探测
      - 共享隧道域名 (如 *.trycloudflare.com): 被拒 —— 防钓鱼, 整体拉黑
      - 明文 http: 即使能打开也可能不注入钱包 provider
    因此 **imToken 实际只接受公网可信域名 + 公网证书**。
    """
    h = host.lower()
    if is_private_host(h):
        return "私有/保留地址，imToken 出于安全策略拒绝打开"
    for suf in BLOCKED_TUNNEL_SUFFIXES:
        if h.endswith(suf):
            return f"共享隧道域名（{suf}）常被钱包整体拉黑以防钓鱼"
    return None


def diagnose_reachable(url: str, label: str) -> list[dict]:
    """诊断某个地址能否被**手机**访问、以及能否被 **imToken** 打开。

    扫码无反应常见原因:
      1. 回环地址 (127.0.0.1): 手机上的它指向手机自己
      2. 虚拟机内部地址: 服务在 VM 里, 但手机到不了 VM 网段
      3. 私有 IP: 手机浏览器能打开, 但 imToken 会拒绝
      4. 共享隧道域名: 同上, 被钱包拉黑
      5. 明文 http: imToken 可能不注入钱包 provider

    注意页面里的 RPC 请求是随页面在**手机**上发出的, 所以 RPC 地址同样
    必须手机可达, 不能只在电脑上通。
    """
    if not url:
        return []
    out = []
    p = urllib.parse.urlparse(url)
    host = (p.hostname or "").lower()
    own = lan_ip()

    if host in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        out.append({
            "level": "error",
            "message": f"{label}是回环地址，手机无法访问（手机上的 127.0.0.1 指向手机自己）。",
            "fix": "改用公网地址；仅在本地调试时才用局域网地址",
        })
    elif own and host == own.lower():
        out.append({
            "level": "warn",
            "message": f"{label}用的是本机地址 {host}。若本服务跑在虚拟机/容器内，"
                       f"该地址属于虚拟网卡，手机无法访问。",
            "fix": "改用宿主机的局域网地址（在 Mac 上执行 ipconfig getifaddr en0 查看）",
        })

    # imToken 层面的限制 —— 这是"手机浏览器能开、imToken 打不开"的原因
    reason = imtoken_block_reason(host)
    if reason:
        out.append({
            "level": "error",
            "message": f"{label}：{reason}。手机浏览器能打开，但 imToken 会拒绝。",
            "fix": "改用公网可信域名 + 公网证书（GitHub Pages / Vercel / 自有域名）",
        })

    if p.scheme == "http" and host not in ("127.0.0.1", "localhost"):
        out.append({
            "level": "warn",
            "message": f"{label}是明文 http，imToken 打开时可能不注入钱包 provider。",
            "fix": "改用 HTTPS",
        })

    # 页面域名可达不等于页面存在。Vercel 每次部署都是完整快照，只上传改动的
    # JS 会让根页面变成 404；这类问题必须在生成二维码时直接暴露。
    if label == "页面地址" and p.scheme in ("http", "https") and not is_private_host(host):
        try:
            req = urllib.request.Request(url, method="HEAD", headers={
                "User-Agent": "AI-Hardware-Simulator/1.0",
            })
            with urllib.request.urlopen(req, timeout=5) as response:
                status = response.status
            if status >= 400:
                raise urllib.error.HTTPError(url, status, "HTTP error", {}, None)
        except urllib.error.HTTPError as exc:
            out.append({
                "level": "error",
                "message": f"{label}返回 HTTP {exc.code}，钱包打开后会显示页面不存在。",
                "fix": "重新部署完整 web3/dist-page 目录，不能只上传本次修改的文件",
            })
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            out.append({
                "level": "warn",
                "message": f"{label}可用性检查失败：{exc}",
                "fix": "先在普通浏览器确认该 HTTPS 地址能打开，再重新生成二维码",
            })
    return out


def build_onchain_link(rec_id: str) -> dict:
    """为一条录音生成"待上链"载荷与可扫描链接。

    这里只生成载荷 —— 真正的上链由用户在 imToken 里确认签名后完成。
    设备本身不持有链上私钥, 因此换设备不会改变记录归属。
    """
    if onchain is None:
        return {"error": "上链模块不可用 (缺少 web3/tools/make_payload.py)"}

    item, _ = find_record(rec_id)
    if not item:
        return {"error": "记录不存在"}
    path = os.path.join(REC_DIR, f"{rec_id}.wav")
    if not os.path.isfile(path):
        return {"error": "音频文件缺失"}

    if not CHAIN_CONFIG["contract"]:
        return {"error": "尚未配置合约地址 (启动时用 --contract 指定)"}
    page_url = current_page_url()
    if not page_url:
        return {"error": "尚未配置页面地址 (启动时用 --page-url 或 --page-url-file 指定)"}

    # 上链内容 = **转写文本**（而非几百 KB 的音频原始数据）：
    # 单帧二维码装不下音频密文（≤2.9KB），而"多帧动画二维码"尚未实现。
    # 转写只有几十~几百字节，单帧轻松装下 —— 产品上即"语音备忘的转写上链，
    # 原始音频不出设备"。这是 P0 形态，音频上链留待多帧二维码。
    text = (item.get("text") or "").strip()
    if not text:
        return {"error": "该记录还没有转写文本 —— 先在详情里点『转文字』，"
                         "上链内容用的是转写文本（单帧二维码装不下音频密文）"}
    if CRYPTO["kek"] is None or CRYPTO["demo"]:
        return {"error": "尚未配对 —— 请先到『设置』生成钱包配对二维码并导入配对凭据"}

    # 加密转写文本 → 密文塞进载荷（b 字段），页面提交时改走 addBatchOnchain
    ts = int(time.time())
    scheme_byte = (memo_crypto.SCHEME_WALLET
                   if CRYPTO["scheme"] == "wallet-signature-v1"
                   else memo_crypto.SCHEME_SEED)
    enc = onchain.memo_crypto.encrypt_record(
        text.encode("utf-8"), CRYPTO["kek"], ts,
        scheme=scheme_byte)   # 返回 {blob(bytes), contentHash}
    blob_hex = enc["blob"].hex()
    record = {
        "t": ts,
        "h": enc["contentHash"],
        "c": "chain",
        "b": blob_hex,
    }
    payload = onchain.build_payload(
        CHAIN_CONFIG["contract"], CHAIN_CONFIG["chainId"], [record])
    payload["keyScheme"] = CRYPTO["scheme"]
    if CRYPTO["owner"]:
        payload["owner"] = CRYPTO["owner"]
    raw_probe = json.dumps(payload, ensure_ascii=False,
                           separators=(",", ":")).encode("utf-8")
    if len(raw_probe) > onchain.QR_SINGLE_FRAME_MAX:
        return {"error": "转写文本过长（载荷 %d 字节 > 单帧上限 %d）"
                         % (len(raw_probe), onchain.QR_SINGLE_FRAME_MAX)}
    # RPC 与起始区块挂在页面 query 上而非放进载荷: 它们不是隐私数据,
    # 且页面部署时即确定, 没必要占用宝贵的二维码空间。
    # 起始区块尤其重要: 公共 RPC 普遍限制 eth_getLogs 的范围
    # (实测 5 万块), 从 0 查会被直接拒绝。
    query = []
    if CHAIN_CONFIG["rpcUrl"]:
        query.append("rpc=" + urllib.parse.quote(CHAIN_CONFIG["rpcUrl"], safe=""))
    if CHAIN_CONFIG["deployBlock"]:
        query.append("from=" + urllib.parse.quote(str(CHAIN_CONFIG["deployBlock"]), safe=""))
    if query:
        sep = "&" if "?" in page_url else "?"
        page_url = f"{page_url}{sep}" + "&".join(query)
    info = onchain.build_links(payload, page_url)

    out = {
        "link": info["universal_link"],
        "deepLink": info["deep_link"],
        "payloadSize": info["payload_size"],
        "contentHash": record["h"],
        "chainId": CHAIN_CONFIG["chainId"],
        "contract": CHAIN_CONFIG["contract"],
        "pageUrl": page_url,
        "rpcUrl": CHAIN_CONFIG["rpcUrl"],
        "diagnostics": (diagnose_reachable(page_url, "页面地址")
                        + diagnose_reachable(CHAIN_CONFIG["rpcUrl"], "RPC 地址")),
    }

    # 二维码: 返回 SVG 便于在任意尺寸下清晰渲染。
    # 提供两种码, 用途不同:
    #   主码 = Universal Link (https://connect.token.im/...), 由手机系统交给 imToken 打开
    #   直连码 = 页面地址, 普通相机即可打开, 用于排查"扫码没反应"是出在哪一环
    if segno is not None:
        def render(url: str) -> dict:
            qr = segno.make(url, error="l")
            side = qr.symbol_size(scale=1, border=0)[0]
            px = qr.symbol_size(scale=QR_SCALE, border=QR_BORDER)[0]
            svg = qr.svg_inline(scale=QR_SCALE, border=QR_BORDER)
            # 关键是补上 viewBox: segno 只输出固定的 width/height, 没有 viewBox。
            # 没有 viewBox 的 SVG 被 CSS 改变尺寸时, 内容不会等比缩放, 而是按
            # 原始坐标绘制并被视口裁掉 —— 表现是二维码右下角缺失, 手机完全扫不出来。
            svg = svg.replace("<svg ", f'<svg viewBox="0 0 {px} {px}" ', 1)
            # 再补一个白底矩形: segno 不输出背景, 未点亮的模块是**透明**的。
            # 页面上靠 .qr-img 的白底看着没问题, 但一旦光栅化(canvas/截图/打印)
            # 或被不假设不透明的扫码器读取, 透明会被当作黑色, 整张码报废。
            end = svg.index(">") + 1
            svg = (svg[:end]
                   + f'<rect width="{px}" height="{px}" fill="#ffffff"/>'
                   + svg[end:])
            return {
                "version": qr.version,
                # side 是"不含静默区"的符号边长。静默区(默认 4 模块)也算进
                # 实际占用, 因此页面算每模块像素时必须把它加回去, 否则会高估密度。
                "modules": side,
                "border": QR_BORDER,
                "svg": svg,
                "singleFrame": len(url) <= onchain.QR_SINGLE_FRAME_MAX,
            }

        out["qr"] = render(info["universal_link"])
        out["qrDirect"] = render(info["page_url"])
        # 诊断用: 内容极短, 模块数少, 在屏幕上非常容易扫。
        # 若这个都扫不出来, 说明问题在相机/显示/网络, 而不是二维码密度。
        out["qrTest"] = render(info["page_url"].split("/index.html")[0] + "/")
        out["qr"]["note"] = (
            "单帧可容纳" if out["qr"]["singleFrame"]
            else "超出单帧上限, 需动画二维码 (BC-UR)")
    return out


def build_pairing_link() -> dict:
    """生成钱包签名配对页链接。签名结果由用户通过模拟器输入回传。"""
    if onchain is None:
        return {"error": "上链模块不可用"}
    if not CHAIN_CONFIG["contract"] or not current_page_url():
        return {"error": "缺少合约地址或页面地址"}
    payload = {"v": 1, "chainId": CHAIN_CONFIG["chainId"],
               "contract": CHAIN_CONFIG["contract"],
               "keyScheme": "wallet-signature-v1"}
    encoded = onchain.b64url(json.dumps(
        payload, separators=(",", ":")).encode("utf-8"))
    direct = current_page_url() + "#k=" + encoded
    universal = onchain.UNIVERSAL_LINK_PREFIX + urllib.parse.quote(direct, safe="")
    out = {"link": universal, "pageUrl": direct, "pairing": True,
           "diagnostics": diagnose_reachable(current_page_url(), "页面地址")}
    if segno is not None:
        def render(url: str) -> dict:
            qr = segno.make(url, error="l")
            side = qr.symbol_size(scale=1, border=0)[0]
            px = qr.symbol_size(scale=QR_SCALE, border=QR_BORDER)[0]
            svg = qr.svg_inline(scale=QR_SCALE, border=QR_BORDER)
            svg = svg.replace("<svg ", f'<svg viewBox="0 0 {px} {px}" ', 1)
            end = svg.index(">") + 1
            svg = svg[:end] + f'<rect width="{px}" height="{px}" fill="#ffffff"/>' + svg[end:]
            return {"version": qr.version, "modules": side, "border": QR_BORDER,
                    "svg": svg, "singleFrame": len(url) <= onchain.QR_SINGLE_FRAME_MAX}
        out["qr"] = render(universal)
        out["qrDirect"] = render(direct)
        out["qrTest"] = render(current_page_url())
    return out


def build_recovery_link() -> dict:
    """生成已配对 owner 的独立恢复页链接，不携带 KEK 或签名。"""
    if onchain is None:
        return {"error": "上链模块不可用"}
    if not CHAIN_CONFIG["contract"] or not current_page_url():
        return {"error": "缺少合约地址或页面地址"}
    if CRYPTO["demo"] or not CRYPTO["owner"]:
        return {"error": "尚未完成钱包签名配对，无法确定恢复 owner"}

    info = onchain.build_recovery_link(
        CHAIN_CONFIG["contract"], CHAIN_CONFIG["chainId"], CRYPTO["owner"],
        CHAIN_CONFIG["deployBlock"], current_page_url(), CRYPTO["scheme"])
    out = {
        "link": info["universal_link"], "pageUrl": info["page_url"],
        "recovery": True, "keyScheme": CRYPTO["scheme"], "owner": CRYPTO["owner"],
        "diagnostics": diagnose_reachable(current_page_url(), "页面地址"),
    }
    if segno is not None:
        def render(url: str) -> dict:
            qr = segno.make(url, error="l")
            side = qr.symbol_size(scale=1, border=0)[0]
            px = qr.symbol_size(scale=QR_SCALE, border=QR_BORDER)[0]
            svg = qr.svg_inline(scale=QR_SCALE, border=QR_BORDER)
            svg = svg.replace("<svg ", f'<svg viewBox="0 0 {px} {px}" ', 1)
            end = svg.index(">") + 1
            svg = svg[:end] + f'<rect width="{px}" height="{px}" fill="#ffffff"/>' + svg[end:]
            return {"version": qr.version, "modules": side, "border": QR_BORDER,
                    "svg": svg, "singleFrame": len(url) <= onchain.QR_SINGLE_FRAME_MAX}
        out["qr"] = render(info["universal_link"])
        out["qrDirect"] = render(info["page_url"])
        out["qrTest"] = render(current_page_url())
    return out


def append_chain(entry: dict) -> None:
    os.makedirs(REC_DIR, exist_ok=True)
    with open(CHAIN_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def load_chain() -> list[dict]:
    if not os.path.isfile(CHAIN_PATH):
        return []
    out = []
    with open(CHAIN_PATH, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return list(reversed(out))


# ---------------------------------------------------------------- HTTP

class App:
    """把状态集中在一处, 便于 handler 访问。"""

    def __init__(self, models: dict, device: str):
        self.models = models
        self.settings = dict(DEFAULT_SETTINGS)
        self.engine = Engine(models, self.settings)
        self.recorder = Recorder(device)


STATE_HTML = os.path.join(UI_DIR, "index.html")


class Handler(BaseHTTPRequestHandler):
    app: App = None            # 由 main() 注入
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):     # 静默, 避免刷屏
        pass

    # ---- 工具 ----
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, code: int = 200) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _file(self, path: str, ctype: str) -> None:
        if not os.path.isfile(path):
            self._json({"error": "not found"}, 404)
            return
        with open(path, "rb") as fh:
            self._send(200, fh.read(), ctype)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except json.JSONDecodeError:
            return {}

    # ---- 路由 ----
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        q = urllib.parse.parse_qs(u.query)
        if p in ("/", "/index.html"):
            self._file(STATE_HTML, "text/html; charset=utf-8")
        elif p == "/api/state":
            self._state()
        elif p == "/api/recordings":
            self._json(load_index())
        elif p == "/api/chain":
            self._json(load_chain())
        elif p == "/api/pairing-link":
            result = build_pairing_link()
            self._json(result, 500 if result.get("error") else 200)
        elif p == "/api/recovery-link":
            result = build_recovery_link()
            self._json(result, 500 if result.get("error") else 200)
        elif p.startswith("/api/audio/"):
            self._audio(p.rsplit("/", 1)[-1], bool(q.get("denoise", ["0"])[0] != "0"))
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/record/start":
            self.app.recorder.start()
            self._json(self.app.recorder.state())
        elif p == "/api/record/stop":
            res = self.app.recorder.stop()
            if not res:
                self._json({"error": "未在录音"}, 400)
            elif res.get("error"):
                self._json({"error": res["error"]}, 500)
            else:
                self._json(add_record(res["path"], res["seconds"]))
        elif p == "/api/settings":
            patch = self._body()
            for k, v in patch.items():
                if k in DEFAULT_SETTINGS:
                    if k == "model_type" and v not in {
                            "r2t2", "paraformer", "sense-voice"}:
                        continue
                    self.app.settings[k] = v
            self.app.engine.settings = self.app.settings
            self._json(self.app.settings)
        elif p == "/api/pair":
            # 旧版助记词配对接口，仅用于恢复历史 0x02 记录。
            body = self._body()
            mn = (body.get("mnemonic") or "").strip()
            if not mn:
                self._json({"error": "缺少助记词"}, 400)
                return
            if onchain is None:
                self._json({"error": "上链模块不可用"}, 500)
                return
            try:
                kek = onchain.memo_crypto.kek_from_mnemonic(mn)
            except Exception as e:
                self._json({"error": "助记词无效: %s" % e}, 400)
                return
            CRYPTO["kek"] = kek
            CRYPTO["demo"] = False
            CRYPTO["scheme"] = "mnemonic-v1"
            CRYPTO["owner"] = ""
            persist_pairing(kek)
            self._json({
                "paired": True,
                "fingerprint": onchain.memo_crypto.kek_fingerprint(kek),
                "note": "设备已可用该助记词派生的密钥加密；指纹可与手机端比对",
            })
        elif p == "/api/pair-wallet":
            body = self._body()
            token = str(body.get("credential") or "").strip()
            if not CRYPTO["demo"]:
                current_fp = memo_crypto.kek_fingerprint(CRYPTO["kek"])
                if body.get("replaceFingerprint") != current_fp:
                    self._json({"error": "已有配对；请刷新后确认更换钱包"}, 409)
                    return
            try:
                padded = token + "=" * ((4 - len(token) % 4) % 4)
                cred = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
                owner = str(cred.get("owner", "")).lower()
                kek = bytes.fromhex(str(cred.get("kek", "")).removeprefix("0x"))
                if cred.get("v") != 1 or cred.get("scheme") != "wallet-signature-v1":
                    raise ValueError("凭据版本或方案不支持")
                if not re.fullmatch(r"0x[0-9a-f]{40}", owner) or len(kek) != 32:
                    raise ValueError("owner 或 KEK 格式无效")
            except Exception as exc:
                self._json({"error": "配对凭据无效: %s" % exc}, 400)
                return
            CRYPTO.update(kek=kek, demo=False, scheme="wallet-signature-v1", owner=owner)
            persist_pairing(kek, CRYPTO["scheme"], owner)
            self._json({"paired": True, "scheme": CRYPTO["scheme"], "owner": owner,
                        "fingerprint": memo_crypto.kek_fingerprint(kek),
                        "note": "模拟器已导入钱包签名派生 KEK；真机应通过 BLE 安全回传"})
        elif p == "/api/pairing/clear":
            body = self._body()
            if body.get("confirm") != "clear-pairing":
                self._json({"error": "缺少清除配对确认"}, 400)
                return
            if CRYPTO["demo"]:
                self._json({"error": "当前没有可清除的配对"}, 409)
                return
            current_fp = memo_crypto.kek_fingerprint(CRYPTO["kek"])
            if body.get("fingerprint") != current_fp:
                self._json({"error": "配对状态已变化，请刷新后重新确认"}, 409)
                return
            clear_pairing()
            self._json({
                "paired": False,
                "scheme": "demo",
                "owner": "",
                "fingerprint": "",
                "note": "配对已清除；录音与链上记录仍保留，但需要原密钥来源才能解密旧记录",
            })
        else:
            m = re.match(r"^/api/recording/([^/]+)/(rename|transcribe|sign|delete|onchain)$", p)
            if not m:
                self._json({"error": "not found"}, 404)
                return
            self._action(m.group(1), m.group(2))

    # ---- 具体动作 ----
    def _state(self) -> None:
        self._json({
            "recorder": self.app.recorder.state(),
            "settings": self.app.settings,
            # 配对状态（等价真机"安全元件里是否存有种子秘密"）
            "pairing": {"paired": not CRYPTO["demo"], "scheme": CRYPTO["scheme"],
                        "owner": CRYPTO["owner"],
                        "fingerprint": (memo_crypto.kek_fingerprint(CRYPTO["kek"])
                                        if not CRYPTO["demo"] else "")},
            "models": {
                "denoiser": bool(self.app.models.get("denoiser")),
                "paraformer": bool(self.app.models.get("paraformer")),
                "sense_voice": bool(self.app.models.get("sense_voice")),
                "r2t2": all(self.app.models.get(k) for k in
                            ("r2t2_native", "r2t2_model", "r2t2_mmproj")),
            },
        })

    def _audio(self, rec_id: str, denoise: bool) -> None:
        item, _ = find_record(rec_id)
        if not item:
            self._json({"error": "not found"}, 404)
            return
        src = os.path.join(REC_DIR, f"{rec_id}.wav")
        if not os.path.isfile(src):
            self._json({"error": "file missing"}, 404)
            return
        # 降噪结果按需生成并缓存; 用 mtime 判断是否失效
        if denoise and self.app.models.get("denoiser"):
            cached = os.path.join(REC_DIR, f"{rec_id}_denoised.wav")
            if (not os.path.isfile(cached)
                    or os.path.getmtime(cached) < os.path.getmtime(src)):
                samples = self.app.engine.denoise_array(read_wav(src))
                write_wav(cached, samples)
            self._file(cached, "audio/wav")
        else:
            self._file(src, "audio/wav")

    def _action(self, rec_id: str, action: str) -> None:
        item, _ = find_record(rec_id)
        if not item:
            self._json({"error": "记录不存在"}, 404)
            return
        if action == "delete":
            delete_record(rec_id)
            self._json({"ok": True})
            return
        if action == "rename":
            name = str(self._body().get("name") or "").strip()
            if not name:
                self._json({"error": "名称不能为空"}, 400)
                return
            self._json(update_record(rec_id, {"name": name[:40]}) or {})
            return
        if action == "transcribe":
            src = os.path.join(REC_DIR, f"{rec_id}.wav")
            if not os.path.isfile(src):
                self._json({"error": "音频文件缺失"}, 404)
                return
            t0 = time.time()
            try:
                segs = self.app.engine.transcribe(
                    read_wav(src), self.app.settings["denoise"])
            except Exception as e:
                self._json({"error": f"识别失败: {e}"}, 500)
                return
            text = "\n".join(s["text"] for s in segs)
            self._json(update_record(rec_id, {
                "segments": segs, "text": text,
                "transcribed_at": datetime.datetime.now().astimezone()
                                  .isoformat(timespec="seconds"),
                "asr_seconds": round(time.time() - t0, 2),
            }) or {})
            return
        if action == "sign":
            self._sign(rec_id)
            return
        if action == "onchain":
            res = build_onchain_link(rec_id)
            self._json(res, 400 if res.get("error") else 200)

    def _sign(self, rec_id: str) -> None:
        """对录音内容做 SHA-256, 生成可用于离线签名的载荷。

        这里做的只是"内容摘要 + 构造待签载荷"。真正的链上写入需要钱包签名并
        广播交易, 本模拟环境没有链接入, 因此登记为上链记录的一条 pending 项。
        """
        src = os.path.join(REC_DIR, f"{rec_id}.wav")
        if not os.path.isfile(src):
            self._json({"error": "音频文件缺失"}, 404)
            return
        h = hashlib.sha256()
        with open(src, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        digest = h.hexdigest()

        item, _ = find_record(rec_id)
        payload = {
            "app": "voice-memo",
            "v": 1,
            "name": item.get("name", rec_id),
            "created_at": item.get("created_at"),
            "seconds": item.get("seconds"),
            "sha256": digest,
            "issued_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        entry = dict(payload, id=f"{rec_id}-{digest[:8]}", rec_id=rec_id, status="pending")
        append_chain(entry)
        update_record(rec_id, {"sha256": digest, "chain_id": entry["id"]})
        self._json(entry)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--device", default="plughw:0,0")
    ap.add_argument("--contract", default=os.environ.get("MEMO_CONTRACT", ""),
                    help="MemoryRegistry 合约地址, 用于生成上链载荷")
    ap.add_argument("--chain-id", type=int, default=int(os.environ.get("MEMO_CHAIN_ID", "31337")))
    ap.add_argument("--page-url", default=os.environ.get("MEMO_PAGE_URL", ""),
                    help="DApp 页面的 HTTPS 地址")
    ap.add_argument("--rpc-url", default=os.environ.get("MEMO_RPC_URL", ""),
                    help="只读 RPC, 供页面读取链上索引")
    ap.add_argument("--page-url-file", default=os.environ.get("MEMO_PAGE_URL_FILE", ""),
                    help="从文件读取页面地址。HTTPS 隧道地址每次启动都会变, "
                         "写在文件里即可免去反复重启本服务")
    ap.add_argument("--mnemonic", default=os.environ.get("MEMO_MNEMONIC", ""),
                    help="旧版兼容：从助记词派生 0x02 记录 KEK。新流程请用钱包签名配对；"
                         "省略且无配对记录时使用演示 KEK")
    ap.add_argument("--deploy-block", default=os.environ.get("MEMO_DEPLOY_BLOCK", ""),
                    help="合约部署区块(十六进制或十进制)。公共 RPC 限制 getLogs 范围, "
                         "页面从该块开始扫描而非从 0")
    args = ap.parse_args()

    CHAIN_CONFIG.update(
        contract=args.contract, chainId=args.chain_id,
        pageUrl=args.page_url, rpcUrl=args.rpc_url,
        pageUrlFile=args.page_url_file, deployBlock=args.deploy_block)

    if args.mnemonic:
        CRYPTO["kek"], CRYPTO["demo"] = resolve_kek(args.mnemonic)
        CRYPTO["scheme"], CRYPTO["owner"] = "mnemonic-v1", ""
        persist_pairing(CRYPTO["kek"])   # 启动注入 ≈ 一次配对，持久化
    else:
        paired = load_pairing()
        if paired is not None:
            CRYPTO.update(kek=paired["kek"], demo=False,
                          scheme=paired["scheme"], owner=paired["owner"])
            print("已从本地配对记录恢复加密密钥（等价真机读取安全元件）",
                  flush=True)
        else:
            CRYPTO["kek"], CRYPTO["demo"] = resolve_kek(None)

    models = find_models(os.path.expanduser("~/companion-lab"))
    missing = [k for k in ("paraformer", "vad") if not models.get(k)]
    if missing:
        print(f"缺少必需模型: {', '.join(missing)}", file=sys.stderr)
        return 1
    if not models.get("denoiser"):
        print("提示: 未找到 gtcrn_simple.onnx, 降噪功能将不可用", file=sys.stderr)

    os.makedirs(REC_DIR, exist_ok=True)
    Handler.app = App(models, args.device)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"语音备忘录模拟器: http://localhost:{args.port}", flush=True)

    # 启动时就暴露地址问题: 扫码失败通常不是二维码的问题, 而是地址手机够不到
    ip = lan_ip()
    if ip:
        # 不要写成"手机可访问" —— 本服务常跑在虚拟机里, 这里拿到的是虚拟网卡地址
        # (如 192.168.139.33), 手机根本到不了。给出错误地址比不提示更糟。
        print(f"本机地址: http://{ip}:{args.port}"
              f"  (若在虚拟机或容器内, 手机无法访问此地址)", flush=True)
        print("  手机应访问宿主机地址, 在 Mac 上执行: ipconfig getifaddr en0", flush=True)
    if CRYPTO["demo"]:
        print("提示: 使用**演示 KEK**，仅供模拟器联调；新流程应先完成钱包签名配对，"
              "由已认证通道写入 KEK", flush=True)
    if not args.contract:
        print("提示: 未配置合约地址, 上链二维码功能不可用 (用 --contract 指定)", flush=True)
    for d in diagnose_reachable(current_page_url(), "页面地址") + \
             diagnose_reachable(args.rpc_url, "RPC 地址"):
        mark = "错误" if d["level"] == "error" else "提示"
        print(f"[{mark}] {d['message']}", flush=True)
        if d.get("fix"):
            print(f"       → {d['fix']}", flush=True)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Handler.app.recorder.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
