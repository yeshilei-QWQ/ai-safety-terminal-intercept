# 验证产物（Phase 0 设计验证）

本目录保存**设计阶段的关键假设验证脚本**。它们不是实现代码，而是用来在动手前
证伪/证实设计文档第 12 节列出的断言。

## 文件

| 文件 | 验证目标 | 依赖 | 运行 |
|---|---|---|---|
| `verify-a4-silent.mjs` | 断言 A4：静默响应 `{code:0}`（无 data）真的让 zcode 的 `getUploadKey` 返回 null → capture 短路 | 无（自包含） | `node verify-a4-silent.mjs` |
| `verify-e2e.mjs` | 端到端：真 TLS 上游 + 真代理，验证 拦截/同域放行/异域透传/SSE 流式 | 需 `C:/tmp/egress-probe/` 下的测试证书（leaf.key/leaf.pem/ca.pem） | `node verify-e2e.mjs` |

## verify-a4-silent.mjs 的保真度说明

它把 `D:\Zcode\resources\app.asar`（v3.10.2）中**真实的** `yme` / `L5e` / `hme` / `Qp`
函数体**逐字节提取**后驱动决策链，只 fake 网络层（`ut`）。测的是真实解析代码本身，
而非对逻辑的复述。

提取来源偏移：
- `yme` @254477877
- `L5e` @254477704
- `hme` @254477374
- `Qp`  @254477223（凭证模块内，非 echarts 同名函数）

## 已知的验证脚本自身缺陷（记录，避免误读）

`verify-e2e.mjs` 的透传分支在初版曾丢失"upSock 建连前到达的 ClientHello"数据——
这是**透传实现必须处理握手前缓冲**的真实坑点，实现阶段需注意。

## 回归验证

`verify-e2e.mjs` 做过变异测试：把拦截规则路径改掉后，① 的两条断言准确转红；
还原后全绿。证明测试确实在验证行为而非恒真。
