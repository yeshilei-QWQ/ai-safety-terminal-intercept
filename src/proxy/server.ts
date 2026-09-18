import net from "node:net";

import type { CertificateAuthority } from "../ca/index.ts";
import type { RulesEngine } from "../rules/engine.ts";
import { handlePassthrough, type UpstreamTarget } from "./passthrough.ts";
import { createMitm } from "./mitm.ts";

export interface ProxyServerOptions {
  rules: RulesEngine;
  ca: CertificateAuthority;
  /** 监听地址，默认 127.0.0.1（安全不变量：不对局域网暴露）。 */
  host?: string;
  /** 监听端口，默认 0（由 OS 分配）。 */
  port?: number;
  /** 解析真实上游；省略则直连 host:port（测试用可重定向）。 */
  resolveUpstream?: (host: string, port: number) => UpstreamTarget;
  /** 上游 TLS 校验用 CA（PEM）；省略 = 系统信任库。 */
  upstreamCa?: string | undefined;
  /** 决策日志。 */
  log?: (line: string) => void;
}

/**
 * 代理服务器：接受 CONNECT，按 isTarget 分流——
 * - 目标域（需解密）→ MITM（终止 TLS 后按规则拦截/转发）
 * - 其余域 → 纯隧道透传（不解密）
 *
 * 仅监听 127.0.0.1（安全不变量 §10.4）。
 */
export class ProxyServer {
  readonly #rules: RulesEngine;
  readonly #ca: CertificateAuthority;
  readonly #host: string;
  readonly #port: number;
  readonly #resolveUpstream: (host: string, port: number) => UpstreamTarget;
  readonly #upstreamCa: string | undefined;
  readonly #log: ((line: string) => void) | undefined;
  #server: net.Server | undefined;
  readonly #sockets = new Set<net.Socket>();

  constructor(opts: ProxyServerOptions) {
    this.#rules = opts.rules;
    this.#ca = opts.ca;
    this.#host = opts.host ?? "127.0.0.1";
    this.#port = opts.port ?? 0;
    this.#resolveUpstream =
      opts.resolveUpstream ?? ((host, port) => ({ host, port }));
    this.#upstreamCa = opts.upstreamCa;
    this.#log = opts.log;
  }

  /** 启动并返回实际监听端口。 */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const mitm = createMitm({
        rules: this.#rules,
        ca: this.#ca,
        resolveUpstream: this.#resolveUpstream,
        upstreamCa: this.#upstreamCa,
        log: this.#log,
      });

      const server = net.createServer((client) => {
        this.#sockets.add(client);
        client.on("close", () => this.#sockets.delete(client));
        client.on("error", () => client.destroy());

        let buf = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
          buf = Buffer.concat([buf, chunk]);
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          client.removeListener("data", onData);

          const header = buf.subarray(0, end).toString("latin1");
          const match = /^CONNECT\s+([^:\s]+):(\d+)/i.exec(header);
          const initial = buf.subarray(end + 4);
          if (!match) {
            client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
            return;
          }
          const host = match[1] ?? "";
          const port = Number(match[2] ?? "443");

          if (!this.#rules.isTarget(host)) {
            handlePassthrough(client, Buffer.from(initial), this.#resolveUpstream(host, port), (err) =>
              this.#log?.(`passthrough error ${host}: ${err.message}`)
            );
            return;
          }
          // MITM：先回写 CONNECT 成功，客户端才会开始 TLS 握手
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          mitm.handleSocket(client, host, port);
        };
        client.on("data", onData);
      });

      server.on("error", reject);
      server.listen(this.#port, this.#host, () => {
        this.#server = server;
        const addr = server.address() as net.AddressInfo;
        this.#log?.(`asti proxy listening on ${this.#host}:${addr.port}`);
        resolve(addr.port);
      });
    });
  }

  /** 停止代理并断开所有连接。 */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const s of this.#sockets) s.destroy();
      this.#sockets.clear();
      const server = this.#server;
      this.#server = undefined;
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }
}
