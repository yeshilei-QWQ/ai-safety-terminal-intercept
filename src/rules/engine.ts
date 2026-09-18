import type { Decision, ResponseMode, RulePack } from "./types.ts";

/**
 * 规则匹配引擎：纯逻辑，无 I/O，可脱离网络单测。
 *
 * 职责：持有规则包，对 (host, method, path) 做匹配决策，并暴露
 * 目标域判定（供 Proxy Engine 决定是否 MITM）。
 */
export class RulesEngine {
  readonly name: string;
  readonly #rules: RulePack["rules"];
  readonly #targets: Set<string>;

  constructor(pack: RulePack) {
    this.name = pack.name;
    this.#rules = pack.rules;
    this.#targets = new Set(pack.targets.map((t) => t.host));
  }

  /**
   * 判断某个 host 是否需要对 TLS 解密（targets 声明）。
   * host 做大小写不敏感的全等比较。
   */
  isTarget(host: string): boolean {
    return this.#targets.has(host.toLowerCase());
  }

  /**
   * 对请求做决策。返回首个命中的 block 规则；无命中则 pass。
   * @param host 请求主机名（不含端口）
   * @param method HTTP 方法
   * @param path URL path（不含 query）
   */
  decide(host: string, method: string, path: string): Decision {
    for (const rule of this.#rules) {
      if (rule.action !== "block") continue;
      if (!rule.host.test(host)) continue;
      if (rule.method !== undefined && rule.method.toUpperCase() !== method.toUpperCase()) continue;
      if (!rule.path.test(path)) continue;
      const mode: ResponseMode = rule.response?.mode ?? "silent";
      return { action: "block", ruleId: rule.id, mode };
    }
    return { action: "pass" };
  }
}
