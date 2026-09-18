import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 检查「拦截是否被绕过」。
 *
 * 判据（来自设计期静态分析 + 真机验证）：`state.json` 里的
 * `lastAcceptedManifestHash` 只在客户端**从服务端成功取得上传凭据并完成上传**后
 * 才被写入。因此：
 *   - 该值不变  → 上传链没有走通（拦截有效）
 *   - 该值变化  → 有新的快照被服务端接受（**拦截被绕过**，或代理没在运行）
 *
 * 这一层不替代代理，而是把「假定拦截有效」变成「一旦失效就会知道」。
 */

export interface CheckpointState {
  /** checkpoint 目录名（工作区哈希）。 */
  dir: string;
  workspacePath?: string;
  /** 决定性字段：只在快照被服务端接受后更新。 */
  lastAcceptedManifestHash?: string;
  failureCount?: number;
}

export type CheckpointChange =
  | { kind: "hash-changed"; dir: string; workspacePath?: string; from?: string; to?: string }
  | { kind: "new-workspace"; dir: string; workspacePath?: string; to?: string }
  | { kind: "workspace-removed"; dir: string; workspacePath?: string; from?: string };

/** 默认的 zcode checkpoints 根目录。 */
export function defaultCheckpointsRoot(homeDir: string): string {
  return join(homeDir, ".zcode", "v2", "checkpoints");
}

/** state.json 的原始形状（不含目录名，目录名由调用方补上）。 */
type RawCheckpointState = Omit<CheckpointState, "dir">;

function readStateFile(path: string): RawCheckpointState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as RawCheckpointState;
  } catch {
    // 损坏/不可读的 state.json 单独跳过，不影响其它工作区的检测
    return undefined;
  }
}

/**
 * 读取根目录下所有工作区的 checkpoint 状态。
 *
 * 输入目录一般是客户端自己管理的，所以损坏项、空目录一律跳过而非抛错——
 * 检测层本身不应该因为被检测对象的异常而失效。
 */
export function readCheckpoints(root: string): Map<string, CheckpointState> {
  const result = new Map<string, CheckpointState>();
  if (!existsSync(root)) return result;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return result;
  }

  for (const name of entries) {
    const statePath = join(root, name, "state.json");
    if (!existsSync(statePath)) continue;
    const state = readStateFile(statePath);
    if (state === undefined) continue;
    result.set(name, { dir: name, ...state });
  }
  return result;
}

/**
 * 比对两次快照，产出**需要告警**的变化。
 *
 * 只关心「上传是否真的发生」这一类信号：
 *   - hash 变化（含首次出现）→ 绕过
 *   - 新增/消失的工作区 → 环境变化（提示用）
 * `failureCount` 之类不构成绕过，刻意不告警（避免噪音淹没真信号）。
 */
export function diffCheckpoints(
  prev: ReadonlyMap<string, CheckpointState>,
  next: ReadonlyMap<string, CheckpointState>
): CheckpointChange[] {
  const changes: CheckpointChange[] = [];

  for (const [dir, n] of next) {
    const p = prev.get(dir);
    if (p === undefined) {
      changes.push({ kind: "new-workspace", dir, workspacePath: n.workspacePath, to: n.lastAcceptedManifestHash });
      continue;
    }
    if (p.lastAcceptedManifestHash !== n.lastAcceptedManifestHash && n.lastAcceptedManifestHash !== undefined) {
      changes.push({
        kind: "hash-changed",
        dir,
        workspacePath: n.workspacePath,
        from: p.lastAcceptedManifestHash,
        to: n.lastAcceptedManifestHash,
      });
    }
  }

  for (const [dir, p] of prev) {
    if (!next.has(dir)) {
      changes.push({ kind: "workspace-removed", dir, workspacePath: p.workspacePath, from: p.lastAcceptedManifestHash });
    }
  }

  return changes;
}
