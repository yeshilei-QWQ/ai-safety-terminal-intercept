import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCheckpoints, diffCheckpoints, type CheckpointState } from "../src/watch/checkpoints.ts";

// ---------------------------------------------------------------------------
// 夹具：伪造 zcode 的 checkpoints 目录结构
//   <root>/<dirId>/state.json
// ---------------------------------------------------------------------------
function fixture(
  entries: Record<string, { workspacePath?: string; lastAcceptedManifestHash?: string; failureCount?: number }>
): string {
  const root = mkdtempSync(join(tmpdir(), "asti-watch-"));
  for (const [dirId, state] of Object.entries(entries)) {
    const d = join(root, dirId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "state.json"), JSON.stringify(state, null, 2), "utf8");
  }
  return root;
}

// ---------------------------------------------------------------------------
// readCheckpoints
// ---------------------------------------------------------------------------

test("readCheckpoints：读取各 workspace 的 state.json", () => {
  const root = fixture({
    aaa: { workspacePath: "D:\\proj1", lastAcceptedManifestHash: "h1", failureCount: 3 },
    bbb: { workspacePath: "D:\\proj2", lastAcceptedManifestHash: "h2", failureCount: 0 },
  });
  try {
    const m = readCheckpoints(root);
    assert.equal(m.size, 2);
    assert.equal(m.get("aaa")?.lastAcceptedManifestHash, "h1");
    assert.equal(m.get("aaa")?.workspacePath, "D:\\proj1");
    assert.equal(m.get("bbb")?.lastAcceptedManifestHash, "h2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCheckpoints：根目录不存在 → 空 Map（不抛错）", () => {
  const m = readCheckpoints(join(tmpdir(), "asti-does-not-exist-" + Date.now()));
  assert.equal(m.size, 0);
});

test("readCheckpoints：损坏的 state.json 被跳过，不拖垮整体", () => {
  const root = fixture({ good: { lastAcceptedManifestHash: "ok" } });
  try {
    const bad = join(root, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "state.json"), "{ not json", "utf8");

    const m = readCheckpoints(root);
    assert.equal(m.get("good")?.lastAcceptedManifestHash, "ok");
    assert.equal(m.has("bad"), false, "损坏项应被跳过");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCheckpoints：无 state.json 的子目录被忽略", () => {
  const root = fixture({ real: { lastAcceptedManifestHash: "x" } });
  try {
    mkdirSync(join(root, "empty"), { recursive: true });
    const m = readCheckpoints(root);
    assert.deepEqual([...m.keys()], ["real"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// diffCheckpoints —— 这是检测层的核心：hash 变化 = 上传被接受了 = 拦截被绕过
// ---------------------------------------------------------------------------

function stateOf(entries: Record<string, Partial<CheckpointState>>): Map<string, CheckpointState> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, { dir: k, ...v }]));
}

test("diffCheckpoints：完全一致 → 无变化", () => {
  const a = stateOf({ x: { lastAcceptedManifestHash: "h1" } });
  const b = stateOf({ x: { lastAcceptedManifestHash: "h1" } });
  assert.deepEqual(diffCheckpoints(a, b), []);
});

test("diffCheckpoints：hash 变化 → hash-changed（核心告警）", () => {
  const prev = stateOf({ x: { workspacePath: "D:\\p", lastAcceptedManifestHash: "old" } });
  const next = stateOf({ x: { workspacePath: "D:\\p", lastAcceptedManifestHash: "new" } });
  const changes = diffCheckpoints(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, "hash-changed");
  assert.equal(changes[0]?.dir, "x");
  assert.equal((changes[0] as { from?: string }).from, "old");
  assert.equal((changes[0] as { to?: string }).to, "new");
});

test("diffCheckpoints：从无 hash 到有 hash → 也算 hash-changed（首次上传）", () => {
  const prev = stateOf({ x: {} });
  const next = stateOf({ x: { lastAcceptedManifestHash: "first" } });
  const changes = diffCheckpoints(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, "hash-changed");
  assert.equal((changes[0] as { to?: string }).to, "first");
});

test("diffCheckpoints：新增 workspace → new-workspace", () => {
  const prev = stateOf({ x: { lastAcceptedManifestHash: "h" } });
  const next = stateOf({ x: { lastAcceptedManifestHash: "h" }, y: { lastAcceptedManifestHash: "h2" } });
  const changes = diffCheckpoints(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, "new-workspace");
  assert.equal(changes[0]?.dir, "y");
});

test("diffCheckpoints：workspace 消失 → workspace-removed", () => {
  const prev = stateOf({ x: { lastAcceptedManifestHash: "h" }, y: { lastAcceptedManifestHash: "h2" } });
  const next = stateOf({ x: { lastAcceptedManifestHash: "h" } });
  const changes = diffCheckpoints(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, "workspace-removed");
  assert.equal(changes[0]?.dir, "y");
});

test("diffCheckpoints：failureCount 变化不算绕过（不告警）", () => {
  const prev = stateOf({ x: { lastAcceptedManifestHash: "h", failureCount: 1 } });
  const next = stateOf({ x: { lastAcceptedManifestHash: "h", failureCount: 9 } });
  assert.deepEqual(diffCheckpoints(prev, next), [], "failureCount 变化不构成绕过告警");
});
