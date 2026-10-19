/*
 * 局域网 HTTPS 页面服务：dist-page 静态文件 + /rpc 反代到本机 anvil。
 *
 * 为什么需要它：手机浏览器只在安全上下文开放 WebCrypto（crypto.subtle），
 * http://<局域网IP> 不是安全上下文 → 恢复页解密直接失败。局域网没有公信 CA，
 * 用自签证书即可 —— 手机端"继续访问"后 isSecureContext 为 true，功能完整。
 *
 * /rpc 走同源代理：页面 defaultRpc() 会自动填 <origin>/rpc，
 * 免去在 URL 里再暴露一个明文 http 的 RPC 地址（也避免 https 页面 fetch http 被拦）。
 *
 * 用法: node tools/https_page_server.mjs [页面端口=8443] [RPC=http://127.0.0.1:8545]
 * 清理: kill $(lsof -ti :8443)
 */
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = join(ROOT, "dist-page");
const PORT = Number(process.argv[2] || 8443);
const UPSTREAM = process.argv[3] || "http://127.0.0.1:8545";

const cert = readFileSync(join(ROOT, ".lan-tls", "cert.pem"));
const key = readFileSync(join(ROOT, ".lan-tls", "key.pem"));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json",
};

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = join(DIST, p.replace(/\.\./g, ""));
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  readFileSync(file) && res.end(readFileSync(file));
}

function proxyRpc(req, res) {
  const up = httpRequest(UPSTREAM, {
    method: req.method, headers: { "Content-Type": "application/json" },
  }, (ur) => {
    res.writeHead(ur.statusCode, { "Content-Type": "application/json" });
    ur.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502); res.end("rpc proxy: " + e.message); });
  req.pipe(up);
}

const handler = (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/rpc" || path === "/rpc/") {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    proxyRpc(req, res); return;
  }
  serveStatic(req, res);
};

httpsServer({ cert, key }, handler).listen(PORT, "0.0.0.0", () => {
  console.log(`HTTPS 页面服务: https://0.0.0.0:${PORT}  (静态 dist-page + /rpc → ${UPSTREAM})`);
  console.log("清理: kill $(lsof -ti :" + PORT + ")");
});
httpServer(handler).listen(PORT + 1, "127.0.0.1", () => {
  console.log("（附带 http://127.0.0.1:" + (PORT + 1) + " 供本机免证书自测）");
});
