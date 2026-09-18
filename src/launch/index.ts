import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 用「代理环境变量」启动客户端 —— 从根上关闭绕过路径。
 *
 * 背景（实测确认，见设计文档 A7）：
 * 客户端的对象上传用的是 `globalThis.fetch`，**不读** httpProxy 设置，
 * 因此默认会绕过本地代理直连。但 Node 的 fetch 会读 `NODE_USE_ENV_PROXY`
 * 与 `HTTP(S)_PROXY` 环境变量——把这三者一起注入，fetch 流量也会进代理。
 *
 * 实测：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:8787` 时，
 * `fetch('https://zcode.z.ai/api/v1/snapshot/upload-credential')` 走代理并被拦截。
 */

export interface LaunchEnvOptions {
  /** 本地代理地址，如 http://127.0.0.1:8787 */
  proxyUrl: string;
  /** 「系统根 + ASTI CA」合并包路径（使 MITM 签发的 leaf 被信任）。 */
  caBundlePath: string;
  /** 基准环境变量；默认 process.env。不会被改写。 */
  baseEnv?: NodeJS.ProcessEnv;
  /** NO_PROXY 值；默认只放行本机，避免削弱拦截。 */
  noProxy?: string;
}

const DEFAULT_NO_PROXY = "127.0.0.1,localhost";

/**
 * 构建注入代理配置后的环境变量（纯函数，便于测试）。
 *
 * 同时写大小写两种形式：不同工具链读取习惯不一（undici 读大写为主，
 * 但不少库读小写），统一覆盖可避免 baseEnv 里的旧值把流量引偏。
 */
export function buildProxyEnv(opts: LaunchEnvOptions): NodeJS.ProcessEnv {
  const base = opts.baseEnv ?? process.env;
  const noProxy = opts.noProxy ?? DEFAULT_NO_PROXY;
  return {
    ...base,
    // 关键：让 Node 的 fetch（undici）遵循环境变量里的代理
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: opts.proxyUrl,
    HTTPS_PROXY: opts.proxyUrl,
    ALL_PROXY: opts.proxyUrl,
    http_proxy: opts.proxyUrl,
    https_proxy: opts.proxyUrl,
    all_proxy: opts.proxyUrl,
    // MITM 证书信任（否则 TLS 校验失败）
    NODE_EXTRA_CA_CERTS: opts.caBundlePath,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

export interface LaunchOptions extends LaunchEnvOptions {
  /** 要启动的可执行文件路径。 */
  executable: string;
  /** 传给它的参数。 */
  args?: string[];
  /** 额外注入的环境变量（会覆盖 buildProxyEnv 的结果）。 */
  extraEnv?: NodeJS.ProcessEnv;
}

/**
 * 以隔离的代理环境启动客户端进程。
 * 返回子进程句柄；调用方可据此等待/终止。
 */
export function launchWithProxy(opts: LaunchOptions): ChildProcess {
  const env = { ...buildProxyEnv(opts), ...(opts.extraEnv ?? {}) };
  const child = spawn(opts.executable, opts.args ?? [], {
    env,
    stdio: "inherit",
    detached: false,
  });
  return child;
}

/** 默认的合并 CA 包路径（与 `asti configure` 写入的一致）。 */
export function defaultCaBundlePath(home = homedir()): string {
  return join(home, ".asti", "ca-bundle.pem");
}
