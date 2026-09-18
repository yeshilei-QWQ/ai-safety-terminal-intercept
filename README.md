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

## 开机自启（推荐）

**前提**：本工具是 **fail-closed** —— 代理不在时，客户端连不上服务器。
所以若你长期保留接入，**代理必须常驻运行**。推荐配置为开机自启。

### 平台支持总览

| 平台 | 核心功能 | 开机自启 | 自启方式 | 实测状态 |
|---|---|---|---|---|
| **Windows** | ✅ | ✅ 已配置 | 「启动」文件夹 + VBS 隐藏窗口 | ✅ 已实测 |
| **Linux** | ✅ 应可用 | ✅ 提供脚本 | systemd 用户服务 | ⚠️ 脚本已提供，**未在 Linux 实测** |
| **macOS** | ✅ 应可用 | ✅ 提供脚本 | launchd 用户代理 | ⚠️ 脚本已提供，**未在 macOS 实测** |

核心代理/规则/CA/CLI 均使用 Node 跨平台 API，无平台分支；差异只在**自启机制**。
`configure zcode` / `unconfigure zcode` 的路径用 `os.homedir()` 拼接，三平台通用。

> ⚠️ 诚实说明：Linux/macOS 的自启配置已按官方机制编写，但作者当前只有 Windows 环境，
> **未在 Linux/macOS 上真机运行过**。若你在这些平台遇到问题，欢迎提 issue。

### Windows（「启动」文件夹，无需管理员权限）

1. 确认系统 Node 存在（自启脚本用绝对路径，不依赖 PATH）：
   ```
   C:\Program Files\nodejs\node.exe
   ```
   若不在该位置，编辑 `scripts\asti-run.cmd` 里的 `NODE` 变量。

2. 在「启动」文件夹创建指向隐藏启动器的快捷方式：

   按 `Win+R` → 输入 `shell:startup` → 回车，会打开：
   ```
   C:\Users\<你>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
   ```
   在里面新建一个快捷方式，目标填：
   ```
   wscript.exe "D:\AI safety terminal intercept\scripts\asti-hidden.vbs"
   ```
   起始位置填 `D:\AI safety terminal intercept`。

   或用 PowerShell 一行创建：
   ```powershell
   $ws = New-Object -ComObject WScript.Shell
   $s = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'ASTI.lnk'))
   $s.TargetPath = 'wscript.exe'
   $s.Arguments  = '"D:\AI safety terminal intercept\scripts\asti-hidden.vbs"'
   $s.WorkingDirectory = 'D:\AI safety terminal intercept'
   $s.Save()
   ```

3. 重启（或注销重登）验证：开机后代理应已自动运行。

### Windows：为什么不直接放 `.bat` 到启动文件夹

直接放 `.cmd` 会在每次开机弹出一个黑色控制台窗口。`asti-hidden.vbs` 通过
`WScript.Shell.Run(..., 0, False)` 以**隐藏窗口**启动，因此更干净。

### Linux（systemd 用户服务）

无需 root —— 装到用户级 systemd：

```bash
./scripts/autostart/install.sh
```

它会自动把模板里的 `__REPO__` 替换成本仓库绝对路径，安装到
`~/.config/systemd/user/asti.service`，并 `enable --now`。

```bash
systemctl --user status asti.service     # 查看状态
journalctl --user -u asti.service -f     # 查看服务日志
tail -f ~/.asti/asti.log                 # 查看代理日志
./scripts/autostart/install.sh --uninstall   # 卸载
```

> 提示：想让服务在你**未登录**时也运行，需 `sudo loginctl enable-linger $USER`。

### macOS（launchd 用户代理）

```bash
./scripts/autostart/install.sh
```

安装到 `~/Library/LaunchAgents/com.asti.proxy.plist`（`RunAtLoad` + `KeepAlive`）。

```bash
launchctl list | grep com.asti.proxy     # 查看状态
tail -f ~/.asti/asti.log                 # 查看代理日志
./scripts/autostart/install.sh --uninstall   # 卸载
```

### 文件说明

| 文件 | 平台 | 作用 |
|---|---|---|
| `scripts/asti-run.cmd` | Windows | 运行器：定位系统 Node、`cd` 到仓库、启动代理、写日志 |
| `scripts/asti-hidden.vbs` | Windows | 隐藏窗口启动器，由「启动」文件夹快捷方式调用 |
| `scripts/asti-run.sh` | Linux / macOS | 对应的 POSIX 运行器 |
| `scripts/autostart/install.sh` | Linux / macOS | 自动检测 OS 并安装/卸载自启 |
| `scripts/autostart/asti.service` | Linux | systemd 用户服务模板 |
| `scripts/autostart/com.asti.proxy.plist` | macOS | launchd 用户代理模板 |

### 日志与排障（三平台通用）

代理的所有输出写入 `~/.asti/asti.log`：

- Windows：`C:\Users\<你>\.asti\asti.log`
- Linux / macOS：`/home/<你>/.asti/asti.log`、`/Users/<你>/.asti/asti.log`

检查代理是否在运行（端口 `8787` 应有监听）：

```bash
# Windows
netstat -ano | findstr :8787
# Linux / macOS
lsof -iTCP:8787 -sTCP:LISTEN      # 或: ss -ltnp | grep 8787
```

日志中若出现 `EADDRINUSE`，说明已有一个代理实例在跑（通常无害）。

### 卸载自启

| 平台 | 卸载方式 |
|---|---|
| Windows | 删掉「启动」文件夹里的 `ASTI.lnk`（`shell:startup` 打开该文件夹） |
| Linux / macOS | `./scripts/autostart/install.sh --uninstall` |

若要连代理配置一并还原，再执行（三平台通用）：
```
node src/cli/index.ts unconfigure zcode
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
- 代理需常驻运行（fail-closed）；建议配置开机自启（见上）。
- Phase 1 只覆盖 zcode 的快照上传端点；其它遥测端点需按需补充规则。

**Phase 2 预告**
- 透明代理接入（OS 重定向 + 系统 CA），使不支持代理设置的客户端也能被覆盖；
- 更多客户端规则包（Cursor / Claude Code 等的遥测端点）。

## 许可证

[MIT](LICENSE) © 2026 yeshilei-QWQ

> 说明：MIT 是本仓库的默认选择（最宽松、最常见）。若你希望改用 Apache-2.0 /
> GPL-3.0 等，替换 `LICENSE` 文件并同步本节与 `package.json` 的 `license` 字段即可。
