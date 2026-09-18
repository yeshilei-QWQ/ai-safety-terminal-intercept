import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCheckpoints, diffCheckpoints, type CheckpointState } from "../src/watch/checkpoints.ts";
import { CheckpointWatcher } from "../src/watch/watcher.ts";

function fixture(
  entries: Record<string, { workspacePath?: string; lastAcceptedManifestHash?: string }>
): string {
  const root = mkdtempSync(join(tmpdir(), "asti-watcher-"));
  for (const [dirId, state] of Object.entries(entries)) {
    const d = join(root, dirId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "state.json"), JSON.stringify(state), "utf8");
  }
  return root;
}

function setHash(root: string, dirId: string, hash: string, workspacePath = "D:\\p"): void {
  writeFileSync(join(root, dirId, "state.json"), JSON.stringify({ workspacePath, lastAcceptedManifestHash: hash }), "utf8");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// seed / poll
// ---------------------------------------------------------------------------

test("seed 后无变化 → poll 返回空（既有 hash 不误报）", () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "h1" } });
  const w = new CheckpointWatcher({ root, intervalMs: 50, onAlert: () => {} });
  try {
    w.seed();
    assert.deepEqual(w.poll(), [], "基线内的既有 hash 不应触发告警");
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hash 变化 → poll 报 hash-changed", () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "h1" } });
  const w = new CheckpointWatcher({ root, intervalMs: 50, onAlert: () => {} });
  try {
    w.seed();
    setHash(root, "a", "h2");
    const changes = w.poll();
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, "hash-changed");
    assert.equal((changes[0] as { to?: string }).to, "h2");
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("poll 会推进基线：同一变化不会重复告警", () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "h1" } });
  const w = new CheckpointWatcher({ root, intervalMs: 50, onAlert: () => {} });
  try {
    w.seed();
    setHash(root, "a", "h2");
    assert.equal(w.poll().length, 1, "第一次应报");
    assert.equal(w.poll().length, 0, "第二次不应重复报");
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("新增工作区 → new-workspace", () => {
  const root = fixture({ a: { lastAcceptedManifestHash: "h1" } });
  const w = new CheckpointWatcher({ root, intervalMs: 50, onAlert: () => {} });
  try {
    w.seed();
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "b", "state.json"), JSON.stringify({ lastAcceptedManifestHash: "h9" }), "utf8");
    const changes = w.poll();
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, "new-workspace");
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// start / stop 生命周期
// ---------------------------------------------------------------------------

test("start 会先取基线：启动前已存在的 hash 不告警", () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "old" } });
  const alerts: string[] = [];
  const w = new CheckpointWatcher({ root, intervalMs: 30, onAlert: (c) => alerts.push(c.kind) });
  try {
    w.start();
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(alerts, []);
});

test("start 后发生变更 → 通过 onAlert 异步告警", async () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "old" } });
  const alerts: string[] = [];
  const w = new CheckpointWatcher({ root, intervalMs: 30, onAlert: (c) => alerts.push(c.kind) });
  try {
    w.start();
    setHash(root, "a", "new-hash");
    await sleep(250);
    assert.deepEqual(alerts, ["hash-changed"], "轮询应捕获到变化并回调");
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop 幂等，且停止后不再轮询", async () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "old" } });
  const alerts: string[] = [];
  const w = new CheckpointWatcher({ root, intervalMs: 30, onAlert: (c) => alerts.push(c.kind) });
  try {
    w.start();
    w.stop();
    assert.doesNotThrow(() => w.stop(), "重复 stop 不应抛错");
    setHash(root, "a", "after-stop");
    await sleep(150);
    assert.deepEqual(alerts, [], "停止后不应再有告警");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 基线持久化 —— 让检测跨重启/定时任务仍然有效
// （没有它，每次启动都重新取基线，「停机期间的绕过」会被静默吞掉）
// ---------------------------------------------------------------------------

test("持久化：poll 会把基线写入 statePath", () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "h1" } });
  const statePath = join(mkdtempSync(join(tmpdir(), "asti-wstate-")), "watch-state.json");
  const w = new CheckpointWatcher({ root, intervalMs: 50, statePath, onAlert: () => {} });
  try {
    w.seed();
    assert.equal(existsSync(statePath), true, "seed 应落盘基线");
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("持久化：新实例沿用已存基线 → 能检出停机期间的绕过", () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "before" } });
  const stateDir = mkdtempSync(join(tmpdir(), "asti-wstate-"));
  const statePath = join(stateDir, "watch-state.json");
  try {
    // 第一个实例建立基线
    const w1 = new CheckpointWatcher({ root, intervalMs: 50, statePath, onAlert: () => {} });
    w1.seed();
    w1.stop();

    // 模拟「ASTI 不在时发生了绕过」
    setHash(root, "a", "during-downtime");

    // 新实例应从磁盘恢复旧基线，而不是把当前状态当成新常态
    const w2 = new CheckpointWatcher({ root, intervalMs: 50, statePath, onAlert: () => {} });
    w2.seed();
    const changes = w2.poll();
    w2.stop();

    assert.equal(changes.length, 1, "应检出停机期间的 hash 变化");
    assert.equal(changes[0]?.kind, "hash-changed");
    assert.equal((changes[0] as { from?: string }).from, "before");
    assert.equal((changes[0] as { to?: string }).to, "during-downtime");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("持久化：基线文件损坏 → 回退为当前状态（不抛错、不误报）", () => {
  const root = fixture({ a: { workspacePath: "D:\\p", lastAcceptedManifestHash: "h1" } });
  const stateDir = mkdtempSync(join(tmpdir(), "asti-wstate-"));
  const statePath = join(stateDir, "watch-state.json");
  writeFileSync(statePath, "{ broken", "utf8");
  const w = new CheckpointWatcher({ root, intervalMs: 50, statePath, onAlert: () => {} });
  try {
    w.seed();
    assert.deepEqual(w.poll(), [], "损坏基线应回退为当前状态，不产生误报");
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("持久化：无 statePath 时行为不变（不落盘）", () => {
  const root = fixture({ a: { lastAcceptedManifestHash: "h1" } });
  const w = new CheckpointWatcher({ root, intervalMs: 50, onAlert: () => {} });
  try {
    w.seed();
    assert.deepEqual(w.poll(), []);
  } finally {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
