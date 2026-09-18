#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CertificateAuthority, writeMergedCaBundle } from "../ca/index.ts";
import { RulesEngine } from "../rules/engine.ts";
import { loadRulePack } from "../rules/load.ts";
import { ProxyServer } from "../proxy/server.ts";
import { ZcodeAdapter } from "../adapters/explicit/zcode.ts";
import { CheckpointWatcher, formatAlert } from "../watch/watcher.ts";
import { defaultCheckpointsRoot } from "../watch/checkpoints.ts";

const DEFAULT_PORT = 8787;
const DEFAULT_RULEPACK = "rulepacks/zcode.yaml";
const DEFAULT_WATCH_INTERVAL_SEC = 30;

function dataDir(): string {
  return process.env["ASTI_HOME"] ?? join(homedir(), ".asti");
}

function caPath(): string {
  return join(dataDir(), "ca.pem");
}

function usage(): string {
  return [
    "asti — AI 客户端出口防火墙（Phase 1：显式代理）",
    "",
    "用法: asti <command> [options]",
    "",
    "命令:",
    "  run                    启动本地代理（前台，含绕过检测）",
    "  watch                  只跑绕过检测（拦截是否失效）",
    "  configure <client>     接入客户端（当前支持 zcode）",
    "  unconfigure <client>   断开客户端并还原设置",
    "  rules                  列出已加载规则",
    "  doctor                 自检环境",
    "",
    "选项:",
    "  --port <n>             代理端口（默认 8787）",
    "  --rulepack <path>      规则包路径（默认 rulepacks/zcode.yaml）",
    "  --settings <path>      zcode setting.json 路径（默认自动探测）",
    "  --checkpoints <dir>    checkpoints 目录（默认 ~/.zcode/v2/checkpoints）",
    "  --interval <sec>       检测轮询间隔秒数（默认 30）",
    "  --once                 检测只跑一次后退出",
  ].join("\n");
}

function loadRules(rulepackPath: string): RulesEngine {
  if (!existsSync(rulepackPath)) {
    throw new Error(`规则包不存在：${rulepackPath}`);
  }
  return new RulesEngine(loadRulePack(rulepackPath));
}

function ensureCaPemFile(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  // 关键：给客户端的 CA 必须是「系统根 + ASTI CA」合并包。
  // 客户端把它用作替换式信任根，单给 ASTI CA 会让真实证书域（如 api.deepseek.com）TLS 失败。
  return writeMergedCaBundle(dir);
}

function cmdRules(rulepackPath: string): void {
  const pack = loadRulePack(rulepackPath);
  console.log(`规则包: ${pack.name}`);
  console.log(`解密目标域 (targets): ${pack.targets.map((t) => t.host).join(", ") || "(无)"}`);
  for (const r of pack.rules) {
    console.log(`  - [${r.action}] ${r.id}`);
    console.log(`      host=${r.host.source} method=${r.method ?? "*"} path=${r.path.source}`);
    if (r.description) console.log(`      ${r.description}`);
  }
}

function cmdDoctor(rulepackPath: string, settingsPath: string | undefined): void {
  // [名称, 是否通过, 详情, 是否计入失败]
  const checks: [string, boolean, string, boolean][] = [];

  const rpOk = existsSync(rulepackPath);
  checks.push(["规则包可加载", rpOk, rulepackPath, true]);
  if (rpOk) {
    try {
      const p = loadRulePack(rulepackPath);
      checks.push(["规则解析成功", p.rules.length > 0, `${p.rules.length} 条规则, targets=${p.targets.length}`, true]);
    } catch (e) {
      checks.push(["规则解析成功", false, String(e), true]);
    }
  }

  const caDir = dataDir();
  try {
    CertificateAuthority.load(caDir); // 生成或加载
    checks.push(["CA 可用（生成/加载）", true, caPath(), true]);
  } catch (e) {
    checks.push(["CA 可用（生成/加载）", false, String(e), true]);
  }

  const adapter = new ZcodeAdapter(settingsPath ?? ZcodeAdapter.defaultSettingsPath());
  checks.push(["zcode 设置文件存在", existsSync(adapter.settingsPath), adapter.settingsPath, false]);
  const attached = adapter.isAttached();
  checks.push(["zcode 已接入", attached, attached ? adapter.backupPath : "(未接入 — 运行 asti configure zcode)", false]);

  let allOk = true;
  for (const [name, ok, detail, counts] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
    if (!ok && counts) allOk = false;
  }
  process.exitCode = allOk ? 0 : 1;
}

function makeWatcher(root: string, intervalSec: number, statePath: string): CheckpointWatcher {
  return new CheckpointWatcher({
    root,
    intervalMs: intervalSec * 1000,
    statePath,
    onAlert: (change) => console.error(`[asti] ${formatAlert(change)}`),
  });
}

/**
 * 只跑检测层：监控 checkpoints，一旦有快照被服务端接受就告警。
 * 用于「代理在别处运行」或「只想确认拦截有没有失效」的场景。
 *
 * 基线持久化到 `statePath`，因此 `--once` 适合放进定时任务：
 * 它能检出「上次检查之后（含 ASTI 未运行时）发生的绕过」。
 */
function cmdWatch(root: string, intervalSec: number, once: boolean, statePath: string): void {
  const watcher = makeWatcher(root, intervalSec, statePath);
  if (once) {
    watcher.seed();
    const changes = watcher.poll();
    for (const c of changes) console.error(`[asti] ${formatAlert(c)}`);
    if (changes.length === 0) {
      console.log(`[asti] 无新增上传（基线: ${statePath}）`);
    } else {
      process.exitCode = 1; // 让定时任务/CI 能感知到异常
    }
    return;
  }
  console.log(`[asti] 监控 ${root}（每 ${intervalSec}s，Ctrl+C 退出）`);
  console.log(`[asti] 判据：lastAcceptedManifestHash 变化 = 有快照被服务端接受`);
  watcher.start();
  const stop = (): void => {
    watcher.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function cmdRun(
  rulepackPath: string,
  port: number,
  checkpointsRoot: string,
  intervalSec: number,
  statePath: string
): Promise<void> {
  const rules = loadRules(rulepackPath);
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const ca = CertificateAuthority.load(dir);
  const proxy = new ProxyServer({
    rules,
    ca,
    port,
    log: (line) => console.error(`[asti] ${line}`),
  });
  const actual = await proxy.start();
  console.error(`[asti] 代理已启动于 127.0.0.1:${actual}（Ctrl+C 退出）`);

  // 检测层：代理在跑 ≠ 拦截一定有效，所以同时盯住「上传是否真的被接受」
  const watcher = makeWatcher(checkpointsRoot, intervalSec, statePath);
  watcher.start();
  console.error(`[asti] 绕过检测已启动（监控 ${checkpointsRoot}，每 ${intervalSec}s）`);

  const shutdown = async (): Promise<void> => {
    watcher.stop();
    await proxy.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function cmdConfigure(client: string, port: number, settingsPath: string | undefined): void {
  if (client !== "zcode") {
    throw new Error(`暂不支持的客户端：${client}（当前支持 zcode）`);
  }
  const pem = ensureCaPemFile();
  const adapter = new ZcodeAdapter(settingsPath ?? ZcodeAdapter.defaultSettingsPath());
  adapter.attach({ proxyUrl: `http://127.0.0.1:${port}`, caCertPath: pem });
  console.log(`已接入 ${client}`);
  console.log(`  设置文件: ${adapter.settingsPath}`);
  console.log(`  备份:     ${adapter.backupPath}`);
  console.log(`  CA:       ${pem}`);
}

function cmdUnconfigure(client: string, settingsPath: string | undefined): void {
  if (client !== "zcode") {
    throw new Error(`暂不支持的客户端：${client}（当前支持 zcode）`);
  }
  const adapter = new ZcodeAdapter(settingsPath ?? ZcodeAdapter.defaultSettingsPath());
  adapter.detach();
  console.log(`已断开 ${client} 并还原设置：${adapter.settingsPath}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      port: { type: "string" },
      rulepack: { type: "string" },
      settings: { type: "string" },
      checkpoints: { type: "string" },
      interval: { type: "string" },
      state: { type: "string" },
      once: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const cmd = positionals[0];
  const rulepackPath = values.rulepack ?? DEFAULT_RULEPACK;
  const port = values.port !== undefined ? Number(values.port) : DEFAULT_PORT;
  const checkpointsRoot = values.checkpoints ?? defaultCheckpointsRoot(homedir());
  const intervalSec = values.interval !== undefined ? Number(values.interval) : DEFAULT_WATCH_INTERVAL_SEC;
  const statePath = values.state ?? join(dataDir(), "watch-state.json");

  if (values.help === true || cmd === undefined) {
    console.log(usage());
    return;
  }

  switch (cmd) {
    case "run":
      await cmdRun(rulepackPath, port, checkpointsRoot, intervalSec, statePath);
      break;
    case "watch":
      cmdWatch(checkpointsRoot, intervalSec, values.once === true, statePath);
      break;
    case "configure":
      cmdConfigure(positionals[1] ?? "", port, values.settings);
      break;
    case "unconfigure":
      cmdUnconfigure(positionals[1] ?? "", values.settings);
      break;
    case "rules":
      cmdRules(rulepackPath);
      break;
    case "doctor":
      cmdDoctor(rulepackPath, values.settings);
      break;
    default:
      console.error(`未知命令：${cmd}\n`);
      console.log(usage());
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error(`[asti] 错误：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
