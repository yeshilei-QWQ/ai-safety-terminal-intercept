import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ZcodeAdapter } from "../src/adapters/explicit/zcode.ts";

function fixture(initial: object | null): { dir: string; settingsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "asti-adapter-"));
  const settingsPath = join(dir, "setting.json");
  if (initial !== null) writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  return { dir, settingsPath };
}

const OPTS = { proxyUrl: "http://127.0.0.1:8888", caCertPath: "C:/x/.asti/ca.pem" };

test("attach：写入 httpProxy / httpProxyCaCertPath，保留原有键", () => {
  const { settingsPath } = fixture({ locale: "zh-CN", recentProjects: ["D:\\a"] });
  const adapter = new ZcodeAdapter(settingsPath);
  adapter.attach(OPTS);

  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(s.httpProxy, OPTS.proxyUrl);
  assert.equal(s.httpProxyCaCertPath, OPTS.caCertPath);
  assert.equal(s.locale, "zh-CN", "原有键应保留");
  assert.deepEqual(s.recentProjects, ["D:\\a"]);
});

test("attach：先备份原文件", () => {
  const original = { locale: "zh-CN" };
  const { settingsPath } = fixture(original);
  const adapter = new ZcodeAdapter(settingsPath);
  adapter.attach(OPTS);

  assert.ok(existsSync(adapter.backupPath), "应生成备份文件");
  const backup = JSON.parse(readFileSync(adapter.backupPath, "utf8"));
  assert.deepEqual(backup, original, "备份应为原内容");
});

test("detach：精确还原原文件", () => {
  const original = { locale: "zh-CN", httpProxy: "http://old:1" };
  const { settingsPath } = fixture(original);
  const adapter = new ZcodeAdapter(settingsPath);
  adapter.attach(OPTS);
  adapter.detach();

  const restored = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(restored, original, "detach 应精确还原");
  assert.equal(adapter.isAttached(), false);
});

test("attach 幂等：重复 attach 不覆盖已存的备份（备份始终是原始内容）", () => {
  const original = { locale: "zh-CN" };
  const { settingsPath } = fixture(original);
  const adapter = new ZcodeAdapter(settingsPath);
  adapter.attach(OPTS);
  adapter.attach({ proxyUrl: "http://127.0.0.1:9999", caCertPath: "C:/y/ca.pem" });

  const backup = JSON.parse(readFileSync(adapter.backupPath, "utf8"));
  assert.deepEqual(backup, original, "备份不应被第二次 attach 污染");

  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(s.httpProxy, "http://127.0.0.1:9999", "当前设置应为最新");
});

test("isAttached：attach 后为 true，detach 后为 false", () => {
  const { settingsPath } = fixture({});
  const adapter = new ZcodeAdapter(settingsPath);
  assert.equal(adapter.isAttached(), false);
  adapter.attach(OPTS);
  assert.equal(adapter.isAttached(), true);
});

test("detach：未 attach 时是安全的空操作（不抛错）", () => {
  const { settingsPath } = fixture({ locale: "zh-CN" });
  const adapter = new ZcodeAdapter(settingsPath);
  assert.doesNotThrow(() => adapter.detach());
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).locale, "zh-CN");
});

test("attach：settings 文件不存在时创建之（记录空对象为备份）", () => {
  const dir = mkdtempSync(join(tmpdir(), "asti-adapter-"));
  const settingsPath = join(dir, "setting.json");
  try {
    const adapter = new ZcodeAdapter(settingsPath);
    adapter.attach(OPTS);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(s.httpProxy, OPTS.proxyUrl);
    adapter.detach();
    const restored = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(restored, {}, "还原应为空对象");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
