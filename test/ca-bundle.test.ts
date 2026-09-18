import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import forge from "node-forge";

import { CertificateAuthority, writeMergedCaBundle } from "../src/ca/index.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "asti-bundle-"));
}

test("writeMergedCaBundle：合并包同时含系统根与 ASTI CA", () => {
  const dir = freshDir();
  const bundlePath = writeMergedCaBundle(dir);

  assert.ok(existsSync(bundlePath), "合并包文件应存在");
  const content = readFileSync(bundlePath, "utf8");

  // 含 ASTI CA
  const ca = CertificateAuthority.load(dir);
  assert.ok(content.includes(ca.caCertPem.trim()), "应包含 ASTI CA");

  // 含系统根（至少包含若干系统根证书）
  let systemRootCount = 0;
  for (const root of rootCertificates) {
    if (content.includes(root.trim().split("\n")[1] ?? "\u0000")) systemRootCount++;
  }
  assert.ok(systemRootCount > 50, `应包含多数系统根证书，实际匹配 ${systemRootCount}/${rootCertificates.length}`);

  // 能被解析为多个证书块
  const blocks = content.match(/-----BEGIN CERTIFICATE-----/g) ?? [];
  assert.ok(blocks.length > 50, `应是多证书合并包，实际 ${blocks.length} 块`);
});

test("writeMergedCaBundle：二次调用幂等（内容稳定）", () => {
  const dir = freshDir();
  const p1 = writeMergedCaBundle(dir);
  const c1 = readFileSync(p1, "utf8");
  const p2 = writeMergedCaBundle(dir);
  const c2 = readFileSync(p2, "utf8");
  assert.equal(c1, c2);
});

test("writeMergedCaBundle：包中 ASTI CA 是合法证书", () => {
  const dir = freshDir();
  const bundlePath = writeMergedCaBundle(dir);
  const content = readFileSync(bundlePath, "utf8");
  const ca = CertificateAuthority.load(dir);
  // 从包中截取 ASTI CA 块并解析
  const cert = forge.pki.certificateFromPem(ca.caCertPem);
  assert.equal(cert.subject.getField("CN").value, "ASTI Local CA");
  assert.ok(content.lastIndexOf(ca.caCertPem.trim()) > 0, "ASTI CA 应位于包末尾");
});
