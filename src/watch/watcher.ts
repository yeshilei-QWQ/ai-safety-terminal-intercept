import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { readCheckpoints, diffCheckpoints, type CheckpointChange, type CheckpointState } from "./checkpoints.ts";

export interface WatcherOptions {
  /** checkpoints 根目录。 */
  root: string;
  /** 轮询间隔毫秒，默认 30000。 */
  intervalMs?: number;
  /**
   * 基线持久化路径。提供后：
   * - `seed()` 优先沿用磁盘上的旧基线（而不是把当前状态当新常态），
   *   这样「ASTI 停机期间发生的绕过」在下次启动时仍能被检出；
   * - 每次 `poll()` 后写回。
   * 省略则基线只存在内存里（进程重启即丢失）。
   */
  statePath?: string;
  /** 检出变化时的回调。 */
  onAlert: (change: CheckpointChange) => void;
}

const DEFAULT_INTERVAL_MS = 30_000;

type SerializedBaseline = Record<string, Omit<CheckpointState, "dir">>;

/** 从磁盘恢复基线；文件不存在/损坏则返回 undefined（调用方回退为当前状态）。 */
export function loadBaseline(statePath: string): Map<string, CheckpointState> | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as SerializedBaseline;
    return new Map(Object.entries(obj).map(([dir, v]) => [dir, { dir, ...v }]));
  } catch {
    return undefined;
  }
}

/** 把基线写到磁盘（失败不致命——检测能力降级但不中断）。 */
export function saveBaseline(statePath: string, map: ReadonlyMap<string, CheckpointState>): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const obj: SerializedBaseline = {};
    for (const [dir, state] of map) {
      const { dir: _ignored, ...rest } = state;
      obj[dir] = rest;
    }
    writeFileSync(statePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // 落盘失败不该让检测层崩掉
  }
}

/**
 * 检测层：轮询客户端的 checkpoint 状态，一旦 `lastAcceptedManifestHash` 变化
 * 就说明**有快照被服务端接受了** —— 也就是拦截被绕过（或代理没在运行）。
 *
 * 设计要点：
 * - `seed()` 优先沿用持久化基线，避免重启后把"停机期间的绕过"当成新常态。
 * - `poll()` 每次都推进基线，同一变化只报一次。
 * - `stop()` 幂等，停止后不再轮询。
 */
export class CheckpointWatcher {
  readonly #root: string;
  readonly #intervalMs: number;
  readonly #statePath: string | undefined;
  readonly #onAlert: (change: CheckpointChange) => void;
  #prev: Map<string, CheckpointState> = new Map();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: WatcherOptions) {
    this.#root = opts.root;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#statePath = opts.statePath;
    this.#onAlert = opts.onAlert;
  }

  /** 建立基线：优先用持久化基线，否则取当前状态。 */
  seed(): void {
    const persisted = this.#statePath !== undefined ? loadBaseline(this.#statePath) : undefined;
    this.#prev = persisted ?? readCheckpoints(this.#root);
    this.#persist();
  }

  /** 跑一轮比对：返回变化并推进基线。 */
  poll(): CheckpointChange[] {
    const next = readCheckpoints(this.#root);
    const changes = diffCheckpoints(this.#prev, next);
    this.#prev = next;
    this.#persist();
    return changes;
  }

  /** 取基线后按间隔轮询。 */
  start(): void {
    if (this.#timer !== undefined) return;
    this.seed();
    this.#timer = setInterval(() => {
      for (const change of this.poll()) {
        this.#onAlert(change);
      }
    }, this.#intervalMs);
    // 不要因为这个定时器阻止进程退出
    if (typeof this.#timer === "object" && this.#timer !== null && "unref" in this.#timer) {
      this.#timer.unref();
    }
  }

  /** 停止轮询（幂等）。 */
  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #persist(): void {
    if (this.#statePath !== undefined) saveBaseline(this.#statePath, this.#prev);
  }
}

/** 把一处变化渲染成给用户看的一行告警文案。 */
export function formatAlert(change: CheckpointChange): string {
  const where = change.workspacePath ?? change.dir;
  switch (change.kind) {
    case "hash-changed":
      return `⚠ 拦截可能已被绕过：工作区「${where}」接受了新的快照（${String(change.from).slice(0, 12)} → ${String(change.to).slice(0, 12)}）`;
    case "new-workspace":
      return `ℹ 检测到新的工作区「${where}」（此前未受监控；如已记录 hash 说明它已上传过）`;
    case "workspace-removed":
      return `ℹ 工作区「${where}」的 checkpoints 已消失`;
  }
}
