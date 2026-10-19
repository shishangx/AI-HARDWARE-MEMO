#!/usr/bin/env python3
"""
把会话 JSONL 整理成结构化记录 (本地 LLM)。

读入 mic_rt.py 产出的会话文件, 把其中的语音文本交给本地 llama-server,
再把结构化结果作为一条 {"type":"memo"} 记录追加回同一个文件。

为什么追加回同一文件: 后续"压缩 + 加密 + 上链"以整份会话说为一个不可分割的
产物, 单文件比多文件更好处理, 也避免半成品散落。因为每行都有 type 字段,
新增记录类型不会破坏已有消费者。

为什么不放进 mic_rt.py: 端侧上 LLM 推理比 ASR 慢一个数量级 (实测 0.7~1.7s),
把它放进实时循环会阻塞识别。结构化属于会话后处理。

模型服务按需启停: llama-server 实测常驻占约 800MB, 而它只在会话后处理时用到,
故本脚本在需要时拉起、用完释放, 不占用录音期间的常驻内存。

用法:
  structure.py session.jsonl [--server http://127.0.0.1:8080] [--force]
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

SYSTEM = "你是语音备忘录整理助手。只输出一个 JSON 对象。"

PROMPT = """把语音备忘录整理成 JSON。字段要求:
- title: 具体的主旨标题, 不超过15字, 不要用"待办事项"这类泛称
- summary: 一句话摘要, 不超过50字
- tags: 2-4个具体标签, 每个2-6字
- todos: 数组, 每项 {{"what":内容, "due":时间或空串}}

备忘录:
{text}
JSON:"""

MAX_TAGS = 4


def read_records(path: str) -> list[dict]:
    """按行读取 JSONL, 跳过无法解析的行。"""
    records = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


# 必须绕过系统代理。macOS 网络设置里若配了 HTTP 代理, urllib 会**默认**
# 把请求交给它 —— 连 127.0.0.1 也不例外, 而代理无法处理本地地址会返回 400。
# 本脚本只访问本机 llama-server, 故一律禁用代理。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def server_ready(url: str) -> bool:
    """探测模型服务是否已就绪。

    llama-server 加载期间 /health 返回 503, 此时 open 抛 HTTPError
    (URLError 的子类), 与"服务不存在"一并按未就绪处理。
    """
    try:
        with _OPENER.open(f"{url}/health", timeout=2):
            return True
    except (urllib.error.URLError, OSError):
        return False


def call_llm(server: str, model: str, text: str, timeout: float) -> str:
    body = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 400,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": PROMPT.format(text=text)},
        ],
        # Qwen3 默认开启思考模式, 会显著拖慢响应且破坏 JSON 输出
        "chat_template_kwargs": {"enable_thinking": False},
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        f"{server}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with _OPENER.open(req, timeout=timeout) as resp:
        return json.load(resp)["choices"][0]["message"]["content"]


def parse_json(raw: str) -> dict:
    """取出模型输出中的 JSON 对象。"""
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("```")[1]
        s = s[4:] if s.lower().startswith("json") else s
        s = s.strip()
    return json.loads(s)


def as_text(value, limit: int) -> str:
    return str(value).strip()[:limit] if value is not None else ""


def normalize(d: dict) -> dict:
    """代码兜底: 实测 0.6B 能遵守 JSON 结构, 但不能可靠遵守数量约束
    (要求 2-4 个 tags, 曾返回 9 个), 故数量与类型在此处强制收敛。
    """
    tags = [as_text(t, 12) for t in d.get("tags") or [] if as_text(t, 12)]

    todos = []
    for t in d.get("todos") or []:
        if not isinstance(t, dict):
            continue
        what = as_text(t.get("what"), 100)
        if what:
            todos.append({"what": what, "due": as_text(t.get("due"), 30)})

    return {
        "title": as_text(d.get("title"), 30),
        "summary": as_text(d.get("summary"), 200),
        "tags": tags[:MAX_TAGS],
        "todos": todos,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("session", help="mic_rt.py 产出的会话 JSONL")
    ap.add_argument("--server", default="http://127.0.0.1:8080")
    ap.add_argument("--model", default="qwen3")
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--force", action="store_true",
                    help="已有 memo 记录时仍重新生成")
    ap.add_argument("--serve-sh",
                    default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         "serve.sh"),
                    help="serve.sh 路径, 用于按需启停模型服务")
    ap.add_argument("--keep-server", action="store_true",
                    help="处理完不释放模型服务 (连续多次整理时可省去加载时间)")
    args = ap.parse_args()

    records = read_records(args.session)
    segs = [r for r in records if r.get("type") == "seg"]
    if not segs:
        print("会话中没有可整理的语音内容。", file=sys.stderr)
        return 1

    if any(r.get("type") == "memo" for r in records) and not args.force:
        print("已存在 memo 记录, 跳过 (--force 可重新生成)。", file=sys.stderr)
        return 1

    text = "\n".join(s.get("text", "") for s in segs)

    # 按需启停。若服务本已在运行, 视为用户在手动管理, 处理完不代为关闭。
    started_by_us = False
    try:
        if not server_ready(args.server):
            print("按需启动模型服务...", file=sys.stderr, flush=True)
            t_load = time.time()
            try:
                # 经 bash 调用: 在 macOS 挂载盘上脚本可能没有可执行位
                subprocess.run(["bash", args.serve_sh, "start"], check=True)
            except (subprocess.CalledProcessError, FileNotFoundError) as e:
                print(f"启动模型服务失败: {e}", file=sys.stderr)
                return 1
            load_s = time.time() - t_load
            started_by_us = True
            print(f"服务就绪, 用时 {load_s:.1f}s", file=sys.stderr, flush=True)

        try:
            t0 = time.time()
            raw = call_llm(args.server, args.model, text, args.timeout)
            elapsed = time.time() - t0
        except urllib.error.URLError as e:
            print(f"无法连接本地模型服务 {args.server}: {e}", file=sys.stderr)
            return 1

        try:
            memo = normalize(parse_json(raw))
        except (json.JSONDecodeError, IndexError) as e:
            print(f"模型输出不是合法 JSON: {e}\n原始输出: {raw[:300]}", file=sys.stderr)
            return 1

        record = {
            "type": "memo",
            "source": "llm",
            "model": args.model,
            "created_at": datetime.datetime.now().astimezone()
                           .isoformat(timespec="seconds"),
            "latency_s": round(elapsed, 2),
            "seg_count": len(segs),
            **memo,
        }
        with open(args.session, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

        print(json.dumps(record, ensure_ascii=False, indent=2))
        return 0
    finally:
        if started_by_us and not args.keep_server:
            subprocess.run(["bash", args.serve_sh, "stop"], check=False,
                           stdout=subprocess.DEVNULL)
            print("已释放模型服务。", file=sys.stderr, flush=True)


if __name__ == "__main__":
    sys.exit(main())
