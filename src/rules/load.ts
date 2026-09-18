import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import type { Action, ResponseMode, Rule, RulePack } from "./types.ts";

interface RawRule {
  id: unknown;
  description?: unknown;
  host: unknown;
  method?: unknown;
  path: unknown;
  action: unknown;
  response?: { mode?: unknown };
}

interface RawRulePack {
  name: unknown;
  targets?: { host: unknown }[];
  rules?: RawRule[];
}

function compileRegex(value: unknown, field: string, ruleId: string): RegExp {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`rule "${ruleId}": ${field} must be a non-empty string`);
  }
  try {
    return new RegExp(value);
  } catch (e) {
    throw new Error(`rule "${ruleId}": ${field} is not a valid regex: ${String(e)}`);
  }
}

function normalizeMode(value: unknown, ruleId: string): ResponseMode {
  if (value === undefined) return "silent";
  if (value === "silent" || value === "forbidden") return value;
  throw new Error(`rule "${ruleId}": response.mode must be "silent" or "forbidden"`);
}

function normalizeAction(value: unknown, ruleId: string): Action {
  if (value === "block") return "block";
  throw new Error(`rule "${ruleId}": action must be "block"`);
}

/**
 * 从 YAML 文件加载规则包。
 *
 * 配置错误一律大声失败（fail-fast）——不允许静默降级为「无规则」，
 * 否则用户会误以为防护已生效。见设计文档 §8。
 */
export function loadRulePack(path: string): RulePack {
  const text = readFileSync(path, "utf8");
  const raw = parseYaml(text) as RawRulePack;

  if (!raw || typeof raw !== "object") {
    throw new Error(`rulepack ${path}: not a YAML mapping`);
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw new Error(`rulepack ${path}: missing "name"`);
  }

  const targets = (raw.targets ?? []).map((t, i) => {
    if (!t || typeof t.host !== "string" || t.host.length === 0) {
      throw new Error(`rulepack ${path}: targets[${i}].host must be a non-empty string`);
    }
    return { host: t.host.toLowerCase() };
  });

  const rules: Rule[] = (raw.rules ?? []).map((r, i) => {
    const id = typeof r.id === "string" && r.id.length > 0 ? r.id : `<rule#${i}>`;
    return {
      id,
      ...(typeof r.description === "string" ? { description: r.description } : {}),
      host: compileRegex(r.host, "host", id),
      ...(typeof r.method === "string" ? { method: r.method.toUpperCase() } : {}),
      path: compileRegex(r.path, "path", id),
      action: normalizeAction(r.action, id),
      response: { mode: normalizeMode(r.response?.mode, id) },
    };
  });

  return { name: raw.name, targets, rules };
}
