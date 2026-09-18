import net from "node:net";

export interface UpstreamTarget {
  host: string;
  port: number;
}

/**
 * 纯 TCP 隧道透传（不解密）。
 *
 * 关键点：客户端可能在收到 200 之前/同时就发出了握手数据（ClientHello），
 * 这些数据必须缓存到上游连接建立后再转发，否则 TLS 握手会失败。
 * —— 该坑由设计阶段的 e2e 验证暴露（见 verification/README.md）。
 */
export function handlePassthrough(
  client: net.Socket,
  initial: Buffer,
  target: UpstreamTarget,
  onError?: (err: Error) => void
): void {
  const upstream = net.connect(target.port, target.host);
  const pending: Buffer[] = initial.length > 0 ? [initial] : [];

  const onClientData = (chunk: Buffer): void => {
    pending.push(chunk);
  };
  client.on("data", onClientData);

  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  upstream.on("connect", () => {
    client.removeListener("data", onClientData);
    for (const chunk of pending) {
      if (chunk.length > 0) upstream.write(chunk);
    }
    pending.length = 0;
    client.pipe(upstream);
    upstream.pipe(client);
  });

  upstream.on("error", (err) => {
    onError?.(err);
    client.destroy();
  });
  client.on("error", () => {
    upstream.destroy();
  });
}
