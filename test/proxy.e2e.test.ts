import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CertificateAuthority } from "../src/ca/index.ts";
import { RulesEngine } from "../src/rules/engine.ts";
import { ProxyServer } from "../src/proxy/server.ts";
import type { RulePack } from "../src/rules/types.ts";

// ---------------------------------------------------------------------------
// 真 TLS 上游（按 SNI 动态发证书）+ 真代理。不 mock 中间层。
// ---------------------------------------------------------------------------

const ca = CertificateAuthority.load(mkdtempSync(join(tmpdir(), "asti-e2e-ca-")));

let upstreamPort = 0;
let upstreamHits: string[] = [];

const pack: RulePack = {
  name: "zcode",
  targets: [{ host: "zcode.z.ai" }],
  rules: [
    {
      id: "zcode.snapshot",
      host: /^zcode\.z\.ai$/,
      method: "GET",
      path: /^\/api\/v1\/snapshot\/upload-credential/,
      action: "block",
      response: { mode: "silent" },
    },
    {
      id: "zcode.forbidden-demo",
      host: /^zcode\.z\.ai$/,
      path: /^\/forbidden-demo/,
      action: "block",
      response: { mode: "forbidden" },
    },
  ],
};

let proxy: ProxyServer;
let proxyPort = 0;
let upstream: https.Server;
const upstreamSockets = new Set<{ destroy(): void }>();

before(async () => {
  // 上游：按 SNI 动态证书；记录被触达的路径
  upstream = https.createServer({
    SNICallback: (servername, cb) => {
      const leaf = ca.getLeafForHost(servername);
      cb(null, tls.createSecureContext({ key: leaf.key, cert: leaf.cert }));
    },
  });
  upstream.on("connection", (s) => {
    upstreamSockets.add(s);
    s.on("close", () => upstreamSockets.delete(s));
  });
  upstream.on("request", (req, res) => {
    upstreamHits.push(req.url ?? "");
    if ((req.url ?? "").startsWith("/sse")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let n = 0;
      const timer = setInterval(() => {
        res.write(`data: chunk-${n}\n\n`);
        if (++n >= 3) {
          clearInterval(timer);
          res.end("data: done\n\n");
        }
      }, 100);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, from: "upstream", path: req.url }));
  });
  // 上游 WS 升级：回 101 并 echo
  upstream.on("upgrade", (req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
    );
    socket.on("data", (d) => socket.write(d));
  });

  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;

  proxy = new ProxyServer({
    rules: new RulesEngine(pack),
    ca,
    resolveUpstream: () => ({ host: "127.0.0.1", port: upstreamPort }),
    upstreamCa: ca.caCertPem,
  });
  proxyPort = await proxy.start();
});

after(async () => {
  await proxy?.stop();
  for (const s of upstreamSockets) s.destroy();
  upstreamSockets.clear();
  await new Promise<void>((r) => upstream?.close(() => r()) ?? r());
});

// 测试客户端：CONNECT 到代理 → TLS 握手 → 发 HTTP 请求
interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  firstChunkDelayMs: number | null;
}

function rawRequest(host: string, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, "127.0.0.1", () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    });
    let phase: "connect" | "tls" = "connect";
    let cbuf = "";
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);

    sock.on("data", (d) => {
      if (phase !== "connect") return;
      cbuf += d.toString("latin1");
      if (!cbuf.includes("\r\n\r\n")) return;
      phase = "tls";
      const rest = cbuf.slice(cbuf.indexOf("\r\n\r\n") + 4);
      const t0 = Date.now();
      const ts = tls.connect(
        { socket: sock, servername: host, ca: ca.caCertPem },
        () => {
          ts.write(
            `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n`
          );
          if (rest) ts.write(rest);
        }
      );
      let buf = "";
      let firstChunkDelayMs: number | null = null;
      ts.on("data", (dd) => {
        if (firstChunkDelayMs === null) firstChunkDelayMs = Date.now() - t0;
        buf += dd.toString("utf8");
      });
      ts.on("end", () => {
        clearTimeout(timer);
        const [head, ...bodyParts] = buf.split("\r\n\r\n");
        const statusLine = (head ?? "").split("\r\n")[0] ?? "";
        const status = Number(statusLine.split(" ")[1] ?? 0);
        const headers: Record<string, string> = {};
        for (const line of (head ?? "").split("\r\n").slice(1)) {
          const idx = line.indexOf(":");
          if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        resolve({ status, headers, body: bodyParts.join("\r\n\r\n"), firstChunkDelayMs });
      });
      ts.on("error", reject);
    });
    sock.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Task 2.2 分流 + 透传 / 2.3 MITM 转发 / 2.4 拦截
// ---------------------------------------------------------------------------

test("③ 非 targets 域 → 纯隧道透传（不解密），上游被触达", async () => {
  upstreamHits = [];
  const r = await rawRequest("passthrough.test", "/api/v1/zcode-plan/billing/balance");
  assert.equal(r.status, 200);
  assert.match(r.body, /upstream/);
  assert.ok(upstreamHits.some((u) => u.includes("billing")), "上游应被触达");
});

test("② 同域非命中路径 → MITM 解密后放行转发", async () => {
  upstreamHits = [];
  const r = await rawRequest("zcode.z.ai", "/api/v1/zcode-plan/billing/balance");
  assert.equal(r.status, 200);
  assert.match(r.body, /upstream/);
  assert.ok(upstreamHits.some((u) => u.includes("billing")), "上游应被触达");
});

test("① 命中规则 → 静默拦截 200 {code:0}，且上游未被触达", async () => {
  upstreamHits = [];
  const r = await rawRequest("zcode.z.ai", "/api/v1/snapshot/upload-credential?workspace_id=abc");
  assert.equal(r.status, 200);
  assert.match(r.body, /"code"\s*:\s*0/);
  assert.doesNotMatch(r.body, /upstream/);
  assert.equal(upstreamHits.some((u) => u.includes("upload-credential")), false, "上游不应被触达");
});

test("④ SSE 流式 → 增量转发（不缓冲）", async () => {
  const r = await rawRequest("zcode.z.ai", "/sse");
  assert.match(r.body, /chunk-0/);
  assert.match(r.body, /chunk-2/);
  assert.match(r.body, /done/);
  assert.ok(r.firstChunkDelayMs !== null && r.firstChunkDelayMs < 280, `首块应早于总时长，实际 ${r.firstChunkDelayMs}ms`);
});

// WebSocket 升级：CONNECT → TLS → 发 Upgrade 请求，期待上游 101 透传回来
function rawUpgrade(host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, "127.0.0.1", () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    });
    let phase: "connect" | "tls" = "connect";
    let cbuf = "";
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    sock.on("data", (d) => {
      if (phase !== "connect") return;
      cbuf += d.toString("latin1");
      if (!cbuf.includes("\r\n\r\n")) return;
      phase = "tls";
      const ts = tls.connect({ socket: sock, servername: host, ca: ca.caCertPem }, () => {
        ts.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
        );
      });
      let buf = "";
      ts.on("data", (dd) => {
        buf += dd.toString("utf8");
        if (buf.includes("\r\n\r\n")) {
          clearTimeout(timer);
          resolve(buf);
          ts.destroy();
        }
      });
      ts.on("error", reject);
    });
    sock.on("error", reject);
  });
}

test("⑤ WebSocket 升级 → 透传（上游 101）", async () => {
  const resp = await rawUpgrade("zcode.z.ai", "/ws");
  assert.match(resp, /^HTTP\/1\.1 101/);
});

test("⑥ 命中 forbidden 规则 → 403，上游未被触达", async () => {
  upstreamHits = [];
  const r = await rawRequest("zcode.z.ai", "/forbidden-demo");
  assert.equal(r.status, 403);
  assert.equal(upstreamHits.length, 0, "上游不应被触达");
});
