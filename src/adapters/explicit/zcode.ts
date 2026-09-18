import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * zcode 显式代理接入适配器。
 *
 * 通过读写 zcode 的 setting.json，把其网络指向本地 ASTI 代理：
 * - attach：备份原文件 → 写入 httpProxy / httpProxyCaCertPath
 * - detach：从备份精确还原（含未 attach 时的安全空操作）
 *
 * 依赖的 zcode 设置键（已核实存在于 setting.json schema）：
 *   httpProxy            —— 代理地址
 *   httpProxyCaCertPath  —— ASTI 根 CA（zcode 用作 requestTls.ca，无需装系统根证书）
 */

export interface ZcodeAttachOptions {
  /** 代理地址，如 http://127.0.0.1:8888 */
  proxyUrl: string;
  /** ASTI 根 CA 的 PEM 文件路径 */
  caCertPath: string;
}

const BACKUP_SUFFIX = ".asti-backup";

export class ZcodeAdapter {
  readonly #settingsPath: string;
  readonly #backupPath: string;

  constructor(settingsPath: string) {
    this.#settingsPath = settingsPath;
    this.#backupPath = settingsPath + BACKUP_SUFFIX;
  }

  /** 默认 zcode 设置路径：~/.zcode/v2/setting.json */
  static defaultSettingsPath(): string {
    return join(homedir(), ".zcode", "v2", "setting.json");
  }

  get settingsPath(): string {
    return this.#settingsPath;
  }

  get backupPath(): string {
    return this.#backupPath;
  }

  /** 是否已接入（存在备份即视为已接入）。 */
  isAttached(): boolean {
    return existsSync(this.#backupPath);
  }

  /**
   * 接入：备份原设置（仅首次）→ 写入代理指向。
   * 幂等：重复调用不会用已修改的内容覆盖备份。
   */
  attach(opts: ZcodeAttachOptions): void {
    if (!existsSync(this.#backupPath)) {
      const original = existsSync(this.#settingsPath) ? readFileSync(this.#settingsPath, "utf8") : "{}";
      writeFileSync(this.#backupPath, original, "utf8");
    }
    const current = this.#readSettings();
    const next = {
      ...current,
      httpProxy: opts.proxyUrl,
      httpProxyCaCertPath: opts.caCertPath,
    };
    writeFileSync(this.#settingsPath, JSON.stringify(next, null, 2), "utf8");
  }

  /**
   * 断开：从备份精确还原，并删除备份。
   * 未 attach 时是安全的空操作。
   */
  detach(): void {
    if (!existsSync(this.#backupPath)) return;
    const original = readFileSync(this.#backupPath, "utf8");
    writeFileSync(this.#settingsPath, original, "utf8");
    rmSync(this.#backupPath, { force: true });
  }

  #readSettings(): Record<string, unknown> {
    if (!existsSync(this.#settingsPath)) return {};
    const text = readFileSync(this.#settingsPath, "utf8").trim();
    if (text.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      // 配置损坏时大声失败，不静默覆盖用户文件
      throw new Error(`zcode 设置文件不是合法 JSON：${this.#settingsPath}`);
    }
  }
}
