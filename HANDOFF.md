# HANDOFF — 交接说明

> 写给无上下文的后续会话（人或 AI）。所有关键事实已落字，不依赖此前对话记忆。
> 最后更新：2026-09-18 · 状态：**Phase 1 完成并开源**

---

## 1. 这是什么 / 现在什么状态

**ASTI**（AI Safety Terminal Intercept）是一个本地出口防火墙：按 `host + method + path`
精准拦截 AI 编码客户端的**静默遥测/快照上传**，不误伤正常 API。首个规则包针对 **ZCode** 的静默仓库快照上传。

| 维度 | 现状 |
|---|---|
| Phase 1（显式代理接入） | ✅ 完成 |
| 测试 | ✅ 32 passed（`npm test`） |
| 类型门禁 | ✅ `npx tsc --noEmit` exit 0 |
| 真机验收 | ✅ 通过（拦截生效、模型不受影响） |
| 开源 | ✅ public，MIT |
| Phase 2（透明代理） | ❌ 未开工 |
| 其它客户端规则包 | ❌ 未开工（仅 zcode） |

规模：`src/` 9 文件、`test/` 6 文件、约 1500 行。

**运行时前提（重要）**：本工具是 **fail-closed** —— 代理不在时，被接入的客户端连不上服务器。
所以保留接入就必须让代理常驻。仓库提供三平台的开机自启配置（见 README）。

---

## 2. 代码地图

```
src/
  rules/     Rules Engine —— 纯逻辑，无 I/O，最易测
    types.ts    Rule / RulePack / Decision 类型
    engine.ts   decide(host,method,path) 与 isTarget(host)
    load.ts     YAML → 编译正则；配置错误 fail-fast
  ca/index.ts  根 CA 生成/复用 + 按 host 签发含 SAN 的 leaf + 合并 CA 包
  proxy/
    server.ts      CONNECT 分流（targets→MITM，其余→透传）；仅监听 127.0.0.1
    mitm.ts        TLS 终止 + 规则决策 + 流式转发 + WS 升级透传
    passthrough.ts 纯隧道透传（必须缓存建连前的 ClientHello）
  adapters/explicit/zcode.ts  读写 zcode setting.json（attach 备份+写入 / detach 还原）
  cli/index.ts  run / configure / unconfigure / rules / doctor
rulepacks/zcode.yaml  规则包（拦截 upload-credential）
test/                 单元 + e2e（e2e 不 mock 中间层：真 TLS 上游 + 真代理）
verification/         设计期的假设验证脚本（见其 README）
docs/superpowers/specs/2026-09-18--asti-design.md  设计文档（含证据表与反证章节）
```

**分层原则**：Core（Proxy/Rules/CA）与「接入方式」解耦。加客户端 = 加 rulepack；换接入方式 = 换 adapter。

---

## 3. 怎么跑 / 怎么验

```bash
npm install
npm test              # 32 tests，全绿
npx tsc --noEmit      # 类型门禁

node src/cli/index.ts doctor          # 自检（规则/CA/设置）
node src/cli/index.ts rules           # 查看已加载规则
node src/cli/index.ts run             # 启动代理（前台）
node src/cli/index.ts configure zcode # 接入（备份并改写 zcode 设置）
node src/cli/index.ts unconfigure zcode
```

**验证拦截真的生效**（不只看日志）：

```
~/.zcode/v2/checkpoints/*/state.json  →  lastAcceptedManifestHash 不再变化
```

该字段只在上传被服务端**接受后**才写入，所以它是"是否真的传出去了"的可靠判据。

---

## 4. 已验证的事实（含证据）

| 事实 | 证据 |
|---|---|
| 客户端上传第一步是 `GET /api/v1/snapshot/upload-credential` | asar 静态分析 |
| 该请求失败 → 整条上传链短路 | `captureBeforePromptUnsafe`: `getUploadKey(...); if(!a)return;` |
| 设置里**没有**开关能关掉上传 | 全量 schema 81 字段 + capture 路径不读任何 `*IndexingEnabled` |
| 采集器会包含根目录的 `.git` | 路径判定对 `.git` 直接 `include:true` |
| MITM 能按路径拦而不误伤同域 | `verification/verify-e2e.mjs` 7/7（拦截/同域放行/异域透传/SSE 不缓冲） |
| 静默响应能让客户端无感跳过 | `verification/verify-a4-silent.mjs` 3/3（用 asar 真实 `yme` 字节驱动） |
| 真机端到端 | 代理日志 `BLOCK .../snapshot/upload-credential` ×3；checkpoints hash 未变；模型正常回复 |

---

## 5. 踩过的坑（对后续最有用的一节）

1. **`httpProxyCaCertPath` 是替换式信任根，不是追加式。**
   只给自签 CA，真实证书域（如 `api.deepseek.com`）会 TLS 校验失败。
   必须给「系统根证书 + 自签 CA」**合并包**。已修（`writeMergedCaBundle`）并有回归测试。
   *这个缺陷是自动化测试覆盖不到、只有真机验收才暴露的。*

2. **MITM 分支必须先回写 `200 Connection Established`**，否则客户端一直等、连接挂起
   （表现为测试超时、无日志）。

3. **透传必须缓存建连前到达的 ClientHello**，否则 TLS 握手损坏。

4. **WebSocket 升级要透传而非拦截**（含 `Upgrade` 头直接转隧道），否则破坏长连接。

5. **Windows `.cmd`/`.vbs` 内注释必须纯 ASCII** —— cmd.exe 按系统代码页读取，
   中文注释会被误解析成命令。另需 `.gitattributes` 固定这些文件 `eol=crlf`。

6. **`chmod +x` 在 Windows 上不被 git 记录** —— 需 `git update-index --chmod=+x`，
   否则 `.sh` 在 Linux/macOS 检出后不可执行。

7. **`git filter-branch` 必须配套清理** —— 它把原始历史存进 `refs/original/*`，
   不删则该数据仍可达。完整流程：filter-branch → 删 refs/original → reflog expire → gc prune。

---

## 6. 待办

### Phase 2：透明代理接入
现有架构已预留 adapater 位置。透明代理需要 OS 级重定向（hosts/WFP）+ 系统根证书，
因此需要管理员权限、且是平台绑定的。客户端无感，能覆盖不支持代理设置的客户端。

### 更多规则包
`rulepacks/` 目前只有 zcode。加客户端 = 加一个 YAML：
声明 `targets`（需解密的域）+ `rules`（host/method/path/action/response）。
建议先定位目标客户端的**遥测端点**（通常可在其二进制/日志中找到），再写规则。

### 已知缺口
- 规则包只覆盖 zcode 的**一个**端点（快照上传凭据）；其它遥测端点未覆盖。
- Linux/macOS 的自启配置**已提供但未在目标平台实测**（作者只有 Windows 环境）。
- 代理无鉴权、无 TLS 客户端校验（仅监听 127.0.0.1，本机其它进程可访问该端口）。
- 无速率限制/连接数上限。

---

## 7. 约束（改代码前请先读）

- **安全不变量**（设计文档 §10）：只对规则声明的域解密；不落盘请求体；仅监听 `127.0.0.1`；
  CA 私钥不进 git；fail-closed。
- **双重用途**：这是 MITM 工具。README「安全声明」明确限定用途（保护自己的机器），
  改动不要把"仅解密指定域"这条限制放宽。
- **测试纪律**：e2e 用例**不 mock 中间层**（真 TLS 上游 + 真代理）。
  若把中间层 mock 掉，就再也测不到"MITM 握手/流式转发"这类真实故障。
- **Node ≥ 24**：依赖 `node --test` 原生跑 `.ts`，因此**没有构建步骤**（`package.json` engines 已声明）。

---

## 8. 相关文档

- 设计文档（含完整证据表、反证章节、开放问题）：`docs/superpowers/specs/2026-09-18--asti-design.md`
- 设计期验证脚本及其保真度说明：`verification/README.md`
- 用户侧用法与各平台自启：`README.md`
