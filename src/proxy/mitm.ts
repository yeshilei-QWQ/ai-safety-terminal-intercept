import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Socket } from "node:net";

import type { CertificateAuthority } from "../ca/index.ts";
import type { RulesEngine } from "../rules/engine.ts";
import type { ResponseMode } from "../rules/types.ts";
import type { UpstreamTarget } from "./passthrough.ts";

export interface MitmDeps {
  rules: RulesEngine;
  ca: CertificateAuthority;
  /** 解析实际要连接的上游（测试用；生产默认直连 host:port）。 */
  resolveUpstream: (host: string, port: number) => UpstreamTarget;
  /** 上游 TLS 校验用 CA；省略 = 系统信任库。 */
  upstreamCa?: string | undefined;
  /** 决策日志（默认只记 host+path+决策，不落盘请求体）。 */
  log?: (line: string) => void;
}

export interface Mitm {
  /** 用 leaf 证书终止某个客户端连接的 TLS，并把解密后的 HTTP 交由本处理器。 */
  handleSocket(clientSocket: Socket, host: string, port: number): void;
}

export function createMitm(deps: MitmDeps): Mitm {
  const { rules, ca, resolveUpstream, upstreamCa, log } = deps;

  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    const decision = rules.decide(host, method, path);
    if (decision.action === "block") {
      log?.(`BLOCK ${method} https://${host}${path} rule=${decision.ruleId} mode=${decision.mode}`);
      respondBlocked(res, decision.mode ?? "silent");
      return;
    }

    log?.(`PASS ${method} https://${host}${path}`);
    forward(req, res, host, rawUrl);
  });

  function respondBlocked(res: http.ServerResponse, mode: ResponseMode): void {
    if (mode === "forbidden") {
      res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
      res.end("blocked by asti");
      return;
    }
    // silent：返回 200 {"code":0}（无 data），使 zcode 的 yme() 返回 null → capture 短路
    const body = JSON.stringify({ code: 0, msg: "" });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    });
    res.end(body);
  }

  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    rawUrl: string
  ): void {
    const target = resolveUpstream(host, 443);
    const headers = { ...req.headers, host };
    const upstreamReq = https.request(
      {
        host: target.host,
        port: target.port,
        path: rawUrl,
        method: req.method,
        headers,
        servername: host,
        ...(upstreamCa !== undefined ? { ca: upstreamCa } : {}),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        // 流式转发（SSE 不缓冲）
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end("upstream error");
    });
    req.pipe(upstreamReq);
  }

  // WebSocket 升级：Phase 1 直接透传（不拦截），避免破坏长连接。
  server.on("upgrade", (req, clientSocket, head) => {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    log?.(`UPGRADE ${host}${path} → passthrough`);
    const target = resolveUpstream(host, 443);
    const upstream = tls.connect({
      host: target.host,
      port: target.port,
      servername: host,
      ...(upstreamCa !== undefined ? { ca: upstreamCa } : {}),
    });
    upstream.on("secureConnect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      (clientSocket as Socket).pipe(upstream);
      upstream.pipe(clientSocket as Socket);
    });
    upstream.on("error", () => (clientSocket as Socket).destroy());
  });

  return {
    handleSocket(clientSocket: Socket, host: string): void {
      const leaf = ca.getLeafForHost(host);
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        key: leaf.key,
        cert: leaf.cert,
        SNICallback: (servername, cb) => {
          const l = ca.getLeafForHost(servername);
          cb(null, tls.createSecureContext({ key: l.key, cert: l.cert }));
        },
      });
      tlsSocket.on("error", () => clientSocket.destroy());
      // 把解密后的 socket 交给 http 服务器解析
      server.emit("connection", tlsSocket);
    },
  };
}
