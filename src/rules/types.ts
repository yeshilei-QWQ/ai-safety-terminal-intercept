/**
 * 规则与规则包的类型定义。
 *
 * 设计动机（见设计文档 §5）：规则用「host + method + path」三元组匹配请求，
 * 命中则按 response.mode 返回拦截响应；targets 声明哪些域需要 MITM 解密。
 */

/** 拦截响应的形态。 */
export type ResponseMode =
  /** 返回 HTTP 200 {"code":0}（无 data），使客户端静默跳过 —— 默认 */
  | "silent"
  /** 返回 HTTP 403，意图明确但客户端可能报错/重试 */
  | "forbidden";

/** 规则动作。Phase 1 只有 block（未命中即 pass，不需显式声明）。 */
export type Action = "block";

/** 单条拦截规则。 */
export interface Rule {
  /** 唯一标识，用于日志与规则命中记录。 */
  id: string;
  /** 人类可读说明。 */
  description?: string;
  /** 对请求 host 做正则全匹配（调用方通常写 `^...$`）。 */
  host: RegExp;
  /** HTTP 方法；省略 = 匹配任意方法。 */
  method?: string;
  /** 对 URL path（不含 query）做正则匹配。 */
  path: RegExp;
  /** 动作，Phase 1 固定为 "block"。 */
  action: Action;
  /** 命中时的响应形态；省略默认 silent。 */
  response?: { mode?: ResponseMode };
}

/** 一个客户端的规则包。 */
export interface RulePack {
  /** 客户端名，如 "zcode"。 */
  name: string;
  /** 需要对哪些域做 MITM 解密（未列出的域一律透传）。 */
  targets: { host: string }[];
  /** 规则列表。 */
  rules: Rule[];
}

/** 规则匹配决策结果。 */
export interface Decision {
  action: "block" | "pass";
  /** 命中的规则 id（action 为 block 时存在）。 */
  ruleId?: string;
  /** 命中规则的响应形态（action 为 block 时存在）。 */
  mode?: ResponseMode;
}
