import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";

/**
 * 本地根 CA + 按 host 动态签发 leaf 证书。
 *
 * 安全要点（设计文档 §10）：
 * - 私钥仅落本机（调用方须确保目录被 .gitignore 排除）。
 * - 根 CA 只生成一次，之后复用；leaf 按 host 内存缓存。
 */

const CA_CERT_FILE = "ca.pem";
const CA_KEY_FILE = "ca.key";
const CA_COMMON_NAME = "ASTI Local CA";
const CA_ORG = "ASTI";
const CA_VALID_YEARS = 10;
const LEAF_VALID_DAYS = 397; // 浏览器/客户端对 leaf 有效期的上限约定
const RSA_BITS = 2048;

interface Leaf {
  key: string;
  cert: string;
}

function createCaCert(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(RSA_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
  const now = new Date();
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + CA_VALID_YEARS);
  cert.validity.notBefore = now;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: "commonName", value: CA_COMMON_NAME },
    { name: "organizationName", value: CA_ORG },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      critical: true,
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export class CertificateAuthority {
  readonly #caCertPem: string;
  readonly #caCert: forge.pki.Certificate;
  readonly #caKey: forge.pki.rsa.PrivateKey;
  readonly #leafCache = new Map<string, Leaf>();

  private constructor(caCertPem: string, caKeyPem: string) {
    this.#caCertPem = caCertPem;
    this.#caCert = forge.pki.certificateFromPem(caCertPem);
    this.#caKey = forge.pki.privateKeyFromPem(caKeyPem) as forge.pki.rsa.PrivateKey;
  }

  /** 根 CA 证书 PEM（供写入客户端 httpProxyCaCertPath）。 */
  get caCertPem(): string {
    return this.#caCertPem;
  }

  /**
   * 从目录加载根 CA；不存在则生成（写 ca.pem + ca.key）。
   * 目录会被递归创建。
   */
  static load(dir: string): CertificateAuthority {
    const certPath = join(dir, CA_CERT_FILE);
    const keyPath = join(dir, CA_KEY_FILE);

    if (existsSync(certPath) && existsSync(keyPath)) {
      return new CertificateAuthority(readFileSync(certPath, "utf8"), readFileSync(keyPath, "utf8"));
    }

    const { certPem, keyPem } = createCaCert();
    mkdirSync(dir, { recursive: true });
    writeFileSync(certPath, certPem, { mode: 0o644 });
    writeFileSync(keyPath, keyPem, { mode: 0o600 });
    return new CertificateAuthority(certPem, keyPem);
  }

  /**
   * 为指定 host 取得 leaf 证书（含 SAN），按 host 缓存。
   * 同时把 host 写入 SAN，使客户端 SNI 校验通过。
   */
  getLeafForHost(host: string): Leaf {
    const cached = this.#leafCache.get(host);
    if (cached) return cached;

    const keys = forge.pki.rsa.generateKeyPair(RSA_BITS);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
    const now = new Date();
    const notAfter = new Date(now.getTime() + LEAF_VALID_DAYS * 24 * 60 * 60 * 1000);
    cert.validity.notBefore = now;
    cert.validity.notAfter = notAfter;

    cert.setSubject([{ name: "commonName", value: host }]);
    cert.setIssuer(this.#caCert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", critical: true, digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
    ]);
    cert.sign(this.#caKey, forge.md.sha256.create());

    const leaf: Leaf = {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert),
    };
    this.#leafCache.set(host, leaf);
    return leaf;
  }
}
