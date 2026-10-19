#!/usr/bin/env python3
"""
单端口服务: 同时提供 DApp 静态页面与只读 RPC 代理。

为什么必须合成一个端口
--------------------
imToken 要求 DApp 页面走 HTTPS。而 HTTPS 页面里的脚本再请求 http:// 的 RPC
会被浏览器当作 **混合内容** 直接拦截 —— 连请求都不会发出。因此页面与 RPC
必须是同一个源(scheme + host + port)。

本服务把 /rpc 反向代理到本地节点, 于是页面可以用同源的 /rpc 作为 RPC 端点,
隧道也只需要一条。

用法:
  serve.py --port 8080 [--app-dir ../app] [--rpc http://127.0.0.1:8545]
"""
import argparse
import os
import ssl
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RPC_UPSTREAM = "http://127.0.0.1:8545"
RPC_PATH = "/rpc"

# 必须绕过系统代理。
# macOS 网络设置里若配了 HTTP 代理(如 Clash 的 127.0.0.1:7890), urllib 会
# **默认**把请求交给它, 连 127.0.0.1 也不例外 —— 代理无法处理本地地址, 返回
# 400 Bad Request。而 curl / http.client 不走代理, 所以表现为"命令行能通、
# 代码里不通", 极难定位。本项目只访问本机, 故一律禁用代理。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 只记代理与错误, 静态文件的逐条日志太吵
        if self.path.startswith(RPC_PATH) or (args and str(args[1]).startswith(("4", "5"))):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _proxy_rpc(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        req = urllib.request.Request(
            RPC_UPSTREAM, data=body,
            headers={"Content-Type": self.headers.get("Content-Type", "application/json")},
            method="POST")
        try:
            with _OPENER.open(req, timeout=30) as up:
                data = up.read()
                code = up.status
        except urllib.error.HTTPError as e:
            data, code = e.read(), e.code
        except (urllib.error.URLError, OSError) as e:
            data = ('{"jsonrpc":"2.0","error":{"code":-32000,"message":'
                    '"RPC 上游不可达: %s"}}' % str(e).replace('"', "'")).encode()
            code = 502
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.split("?")[0] == RPC_PATH:
            self._proxy_rpc()
        else:
            self.send_error(404, "only /rpc accepts POST")

    def do_OPTIONS(self):
        # 同源时浏览器不会预检; 保留以便页面在某些环境下跨源访问
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--app-dir", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app"))
    ap.add_argument("--rpc", default="http://127.0.0.1:8545")
    ap.add_argument("--tls-cert", default=None, help="证书路径; 与 --tls-key 同时给出即启用 HTTPS")
    ap.add_argument("--tls-key", default=None, help="私钥路径")
    args = ap.parse_args()

    global RPC_UPSTREAM
    RPC_UPSTREAM = args.rpc

    if not os.path.isdir(args.app_dir):
        print("页面目录不存在: " + args.app_dir, file=sys.stderr)
        return 1

    # SimpleHTTPRequestHandler 用 cwd 解析路径, 直接 chdir 更省事
    os.chdir(args.app_dir)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)

    scheme = "http"
    if args.tls_cert and args.tls_key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.tls_cert, args.tls_key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"

    print("%s 同源服务 (页面 + /rpc): %s://%s:%d/" % (scheme.upper(), scheme, args.host, args.port),
          flush=True)
    print("  /            → %s" % args.app_dir, flush=True)
    print("  /rpc         → %s" % RPC_UPSTREAM, flush=True)
    if scheme == "https":
        print("  证书已启用；手机需信任签发该证书的 CA，否则会被判为不安全连接", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
