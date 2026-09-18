#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CertificateAuthority } from "../ca/index.ts";
import { RulesEngine } from "../rules/engine.ts";
import { loadRulePack } from "../rules/load.ts";
import { ProxyServer } from "../proxy/server.ts";
import { ZcodeAdapter } from "../adapters/explicit/zcode.ts";

const DEFAULT_PORT = 8787;
const DEFAULT_RULEPACK = "rulepacks/zcode.yaml";

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
    "  run                    启动本地代理（前台）",
    "  configure <client>     接入客户端（当前支持 zcode）",
    "  unconfigure <client>   断开客户端并还原设置",
    "  rules                  列出已加载规则",
    "  doctor                 自检环境",
    "",
    "选项:",
    "  --port <n>             代理端口（默认 8787）",
    "  --rulepack <path>      规则包路径（默认 rulepacks/zcode.yaml）",
    "  --settings <path>      zcode setting.json 路径（默认自动探测）",
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
  const ca = CertificateAuthority.load(dir);
  const pem = caPath();
  writeFileSync(pem, ca.caCertPem, { mode: 0o644 });
  return pem;
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

async function cmdRun(rulepackPath: string, port: number): Promise<void> {
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

  const shutdown = async (): Promise<void> => {
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
      help: { type: "boolean", short: "h" },
    },
  });

  const cmd = positionals[0];
  const rulepackPath = values.rulepack ?? DEFAULT_RULEPACK;
  const port = values.port !== undefined ? Number(values.port) : DEFAULT_PORT;

  if (values.help === true || cmd === undefined) {
    console.log(usage());
    return;
  }

  switch (cmd) {
    case "run":
      await cmdRun(rulepackPath, port);
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
