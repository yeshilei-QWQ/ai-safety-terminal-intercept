# ASTI — AI Safety Terminal Intercept

> 本地出口防火墙：按 `host + method + path` 精准拦截 AI 编码客户端的**静默遥测/快照上传**，不误伤正常 API。
> 首个规则包针对 **ZCode**（zcode）的静默仓库快照上传。

**状态**：Phase 1（显式代理接入）已实现。透明代理（Phase 2）待做。

---

## 它解决什么问题

ZCode 桌面客户端会在**每次发 prompt 前**与**每轮任务完成后**，自动把工作区文件
打包、加密、上传到 `zcode.z.ai`，且**没有任何用户可见开关可以关闭**
（经对 `app.asar` 静态分析证实：`repoSnapshotIndexingEnabled` 不控制该上传）。

若工作区根目录是 git 仓库，采集器会把整个 `.git`（含全量提交历史）一并打包。
这不是假设——是代码层面的确定性行为。

ASTI 在**本地网络出口**把这个上传掐断，同时放行同一域名下的模型调用、登录、计费等正常流量。

## 工作原理

```
AI 客户端 ──(httpProxy 设置)──► ASTI 本地代理 ──┬─ 命中规则 → 静默拦截
                                              ├─ 同域其它路径 → 转发上游
                                              └─ 非目标域 → 纯隧道透传
```

- **最小解密**：只对规则包 `targets` 声明的域做 MITM 解密，其余域一律纯隧道透传。
- **精准匹配**：拦截粒度是 `host + method + path`，因此能只拦
  `/api/v1/snapshot/upload-credential`（该上传统的唯一咽喉点）而放过同域的其它 API。
- **静默拦截**：默认返回 `200 {"code":0}`（无 `data`），使客户端**无感跳过**上传，不报错。
  可改为 `forbidden` 返回 403。
- **仅监听 127.0.0.1**：不对局域网暴露。

> **实现要点（真机验收发现的坑）**：客户端把 `httpProxyCaCertPath` 用作**替换式**信任根。
> 若只给 ASTI 根 CA，真实证书域（如 `api.deepseek.com`）会 TLS 校验失败。
> 因此 `configure` 写入的是 **「系统根证书 + ASTI CA」合并包**（`~/.asti/ca-bundle.pem`），
> 两类域都能通过校验。

咽喉点原理：客户端的上传流程先请求「上传凭据」，凭据请求失败即提前返回，
后续的打包/加密/上传全部不会发生。因此只需拦截这一个端点。

## 快速开始

前置：Node.js ≥ 24（本工具用 Node 原生 TypeScript 支持，无需构建步骤）。

```bash
npm install          # 安装依赖（node-forge / yaml）
npm test             # 运行全部测试（含不 mock 中间层的 e2e）
```

三步启用：

```bash
# 1) 启动本地代理（前台；另开一个终端）
node src/cli/index.ts run

# 2) 接入 zcode（备份其设置并写入 httpProxy / httpProxyCaCertPath）
node src/cli/index.ts configure zcode

# 3) 重启 zcode；此后快照上传被拦截
```

恢复原状：

```bash
node src/cli/index.ts unconfigure zcode   # 从备份精确还原 zcode 设置
```

其它命令：

```bash
node src/cli/index.ts rules     # 查看已加载的规则
node src/cli/index.ts doctor    # 自检环境（规则 / CA / 设置）
```

### 验证拦截生效

接入后，检查 zcode 的快照状态文件不再被更新：

```
C:\Users\<你>\.zcode\v2\checkpoints\*\state.json   →   lastAcceptedManifestHash 不再变化
```

## 安全声明（重要）

MITM 代理本身是一种敏感能力。本工具通过设计约束来限制其被滥用：

- 只解密规则包 `targets` 明确声明的域，其余一律透传；
- 不落盘请求体；日志默认只记录 `host + path + 决策`；
- 代理仅监听 `127.0.0.1`；
- 根 CA 私钥仅存本机（`~/.asti/ca.key`，不进 git）。

**仅用于保护你自己的机器、拦截你自己的客户端的非预期外传。**
不得用于解密他人流量。

### fail-closed

代理进程未运行时，客户端连接会被拒绝（而非静默放行上传）。
这是刻意的安全取舍——宁可暂时断网，也不让上传在无防护时溜出去。

## 目录结构

```
src/
  rules/      Rules Engine（纯逻辑：host+method+path 匹配）
  ca/         根 CA + 按 SNI 签发 leaf
  proxy/      CONNECT 分流 / MITM / 透传
  adapters/   客户端接入适配器（当前：zcode）
  cli/        命令行
rulepacks/    规则包（YAML）
verification/ 设计阶段的假设验证脚本
docs/         设计文档
```

## 限制与路线图

**已知限制**
- 仅支持显式代理接入（需客户端支持 `httpProxy` 类设置）。
- 规则包目前只有 zcode。
- 尚未在真实 zcode 上做人工端到端验收（GUI 无 CLI，需人工触发）。

**Phase 2 预告**
- 透明代理接入（OS 重定向 + 系统 CA），使不支持代理设置的客户端也能被覆盖；
- 更多客户端规则包（Cursor / Claude Code 等的遥测端点）。
