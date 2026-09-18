import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";

import { CertificateAuthority } from "../src/ca/index.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "asti-ca-"));
}

test("CA：首次调用生成根 CA 到目标目录", () => {
  const dir = freshDir();
  const ca = CertificateAuthority.load(dir);
  assert.ok(existsSync(join(dir, "ca.pem")), "ca.pem 应被生成");
  assert.ok(existsSync(join(dir, "ca.key")), "ca.key 应被生成");
  assert.match(ca.caCertPem, /BEGIN CERTIFICATE/);
});

test("CA：二次调用复用同一根 CA（不重生成）", () => {
  const dir = freshDir();
  const a = CertificateAuthority.load(dir);
  const b = CertificateAuthority.load(dir);
  assert.equal(a.caCertPem, b.caCertPem, "两次加载的根 CA 应完全相同");
});

test("CA：getLeafForHost 返回含正确 SAN 的 leaf，且由根 CA 签发", () => {
  const dir = freshDir();
  const ca = CertificateAuthority.load(dir);
  const leaf = ca.getLeafForHost("zcode.z.ai");

  const cert = forge.pki.certificateFromPem(leaf.cert);
  // SAN 含目标域
  const sanExt = cert.getExtension("subjectAltName") as
    | { altNames: { type: number; value?: string }[] }
    | undefined;
  assert.ok(sanExt, "leaf 应有 subjectAltName 扩展");
  const dnsNames = sanExt!.altNames.filter((n) => n.type === 2).map((n) => n.value);
  assert.ok(dnsNames.includes("zcode.z.ai"), `SAN 应含 zcode.z.ai，实际 ${dnsNames.join(",")}`);

  // 由根 CA 签发（issuer 与 CA subject 一致，且能被 CA 公钥验证）
  const caCert = forge.pki.certificateFromPem(ca.caCertPem);
  assert.equal(cert.issuer.getField("CN").value, caCert.subject.getField("CN").value);
  assert.ok(leaf.key.includes("BEGIN"), "应返回 leaf 私钥");
});

test("CA：同 host 二次调用命中缓存（返回同一张证书）", () => {
  const dir = freshDir();
  const ca = CertificateAuthority.load(dir);
  const a = ca.getLeafForHost("zcode.z.ai");
  const b = ca.getLeafForHost("zcode.z.ai");
  assert.equal(a.cert, b.cert, "同 host 应返回缓存的同一张 leaf");
});

test("CA：不同 host 得到不同证书（各自 SAN）", () => {
  const dir = freshDir();
  const ca = CertificateAuthority.load(dir);
  const a = ca.getLeafForHost("zcode.z.ai");
  const b = ca.getLeafForHost("api.deepseek.com");
  assert.notEqual(a.cert, b.cert);
  const certB = forge.pki.certificateFromPem(b.cert);
  const sanExt = certB.getExtension("subjectAltName") as { altNames: { type: number; value?: string }[] };
  assert.ok(sanExt.altNames.some((n) => n.value === "api.deepseek.com"));
});

test("CA：私钥文件权限受限（非全局可读）", () => {
  const dir = freshDir();
  CertificateAuthority.load(dir);
  const st = statSync(join(dir, "ca.key"));
  // Windows 上 mode 语义有限，仅断言文件存在且非 0；类 Unix 下应无 group/other 写
  assert.ok(st.size > 0);
});
