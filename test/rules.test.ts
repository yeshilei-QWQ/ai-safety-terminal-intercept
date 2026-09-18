import { test } from "node:test";
import assert from "node:assert/strict";

import { RulesEngine } from "../src/rules/engine.ts";
import { loadRulePack } from "../src/rules/load.ts";
import type { Rule, RulePack } from "../src/rules/types.ts";

// ---------------------------------------------------------------------------
// 测试夹具：一条 zcode 规则包（形状同 rulepacks/zcode.yaml）
// ---------------------------------------------------------------------------
function zcodePack(): RulePack {
  return {
    name: "zcode",
    targets: [{ host: "zcode.z.ai" }],
    rules: [
      {
        id: "zcode.repo-snapshot-upload-credential",
        description: "拦截仓库快照上传凭据签发",
        host: /^zcode\.z\.ai$/,
        method: "GET",
        path: /^\/api\/v1\/snapshot\/upload-credential/,
        action: "block",
        response: { mode: "silent" },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Task 1.3 —— 匹配逻辑矩阵
// ---------------------------------------------------------------------------

test("host 正则全匹配：命中精确域，不命中子域", () => {
  const e = new RulesEngine(zcodePack());
  const hit = e.decide("zcode.z.ai", "GET", "/api/v1/snapshot/upload-credential");
  assert.equal(hit.action, "block");

  const miss = e.decide("sub.zcode.z.ai", "GET", "/api/v1/snapshot/upload-credential");
  assert.equal(miss.action, "pass");
});

test("method：省略=任意方法；指定=精确匹配", () => {
  const packAny: RulePack = {
    name: "t",
    targets: [],
    rules: [
      { id: "any-method", host: /^h$/, path: /^\/x$/, action: "block" },
    ],
  };
  const e1 = new RulesEngine(packAny);
  assert.equal(e1.decide("h", "POST", "/x").action, "block");
  assert.equal(e1.decide("h", "DELETE", "/x").action, "block");

  const packGet: RulePack = {
    name: "t",
    targets: [],
    rules: [
      { id: "get-only", host: /^h$/, method: "GET", path: /^\/x$/, action: "block" },
    ],
  };
  const e2 = new RulesEngine(packGet);
  assert.equal(e2.decide("h", "GET", "/x").action, "block");
  assert.equal(e2.decide("h", "POST", "/x").action, "pass");
});

test("path：正则匹配（不含 query）", () => {
  const e = new RulesEngine(zcodePack());
  // path 前缀匹配（规则无 $ 结尾）
  assert.equal(e.decide("zcode.z.ai", "GET", "/api/v1/snapshot/upload-credential").action, "block");
  // 同域其它路径不命中
  assert.equal(e.decide("zcode.z.ai", "GET", "/api/v1/zcode-plan/billing/balance").action, "pass");
});

test("多规则：取首条命中 block", () => {
  const pack: RulePack = {
    name: "t",
    targets: [],
    rules: [
      { id: "r1", host: /^h$/, path: /^\/a$/, action: "block" },
      { id: "r2", host: /^h$/, path: /^\/a$/, action: "block" },
    ],
  };
  const e = new RulesEngine(pack);
  assert.equal(e.decide("h", "GET", "/a").ruleId, "r1");
});

test("无命中 → pass", () => {
  const e = new RulesEngine(zcodePack());
  assert.equal(e.decide("other.com", "GET", "/anything").action, "pass");
});

test("isTarget：与 targets 一致", () => {
  const e = new RulesEngine(zcodePack());
  assert.equal(e.isTarget("zcode.z.ai"), true);
  assert.equal(e.isTarget("api.deepseek.com"), false);
});

test("silent 为默认响应模式；显式 forbidden 保留", () => {
  const pack: RulePack = {
    name: "t",
    targets: [],
    rules: [
      { id: "default", host: /^h$/, path: /^\/a$/, action: "block" },
      { id: "explicit", host: /^h$/, path: /^\/b$/, action: "block", response: { mode: "forbidden" } },
    ],
  };
  const e = new RulesEngine(pack);
  assert.equal(e.decide("h", "GET", "/a").mode, "silent");
  assert.equal(e.decide("h", "GET", "/b").mode, "forbidden");
});

// ---------------------------------------------------------------------------
// Task 1.4 —— 规则包加载
// ---------------------------------------------------------------------------

test("loadRulePack：从真实 rulepacks/zcode.yaml 解析", () => {
  const pack = loadRulePack("rulepacks/zcode.yaml");
  assert.equal(pack.name, "zcode");
  assert.equal(pack.rules.length, 1);
  assert.deepEqual(pack.targets.map((t) => t.host), ["zcode.z.ai"]);

  const e = new RulesEngine(pack);
  assert.equal(e.isTarget("zcode.z.ai"), true);
  assert.equal(e.decide("zcode.z.ai", "GET", "/api/v1/snapshot/upload-credential").action, "block");
});

test("loadRulePack：host/path 字符串被编译为正则", () => {
  const pack = loadRulePack("rulepacks/zcode.yaml");
  const r = pack.rules[0] as Rule;
  assert.ok(r.host instanceof RegExp);
  assert.ok(r.path instanceof RegExp);
});
