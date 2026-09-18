import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProxyEnv } from "../src/launch/index.ts";

const OPTS = {
  proxyUrl: "http://127.0.0.1:8787",
  caBundlePath: "C:\\Users\\x\\.asti\\ca-bundle.pem",
};

test("buildProxyEnv：注入 NODE_USE_ENV_PROXY=1（让 globalThis.fetch 也走代理）", () => {
  const env = buildProxyEnv({ ...OPTS, baseEnv: {} });
  assert.equal(env["NODE_USE_ENV_PROXY"], "1");
});

test("buildProxyEnv：注入三个代理变量", () => {
  const env = buildProxyEnv({ ...OPTS, baseEnv: {} });
  assert.equal(env["HTTP_PROXY"], OPTS.proxyUrl);
  assert.equal(env["HTTPS_PROXY"], OPTS.proxyUrl);
  assert.equal(env["ALL_PROXY"], OPTS.proxyUrl);
});

test("buildProxyEnv：注入 NODE_EXTRA_CA_CERTS（使 MITM 证书被信任）", () => {
  const env = buildProxyEnv({ ...OPTS, baseEnv: {} });
  assert.equal(env["NODE_EXTRA_CA_CERTS"], OPTS.caBundlePath);
});

test("buildProxyEnv：保留原有环境变量", () => {
  const env = buildProxyEnv({ ...OPTS, baseEnv: { PATH: "/usr/bin", FOO: "bar" } });
  assert.equal(env["PATH"], "/usr/bin");
  assert.equal(env["FOO"], "bar");
});

test("buildProxyEnv：不修改传入的 baseEnv（纯函数）", () => {
  const base = { PATH: "/usr/bin" };
  buildProxyEnv({ ...OPTS, baseEnv: base });
  assert.deepEqual(base, { PATH: "/usr/bin" }, "baseEnv 不应被改写");
});

test("buildProxyEnv：NO_PROXY 默认只放行本机（不削弱拦截）", () => {
  const env = buildProxyEnv({ ...OPTS, baseEnv: {} });
  assert.equal(env["NO_PROXY"], "127.0.0.1,localhost");
  assert.equal(env["no_proxy"], "127.0.0.1,localhost");
});

test("buildProxyEnv：可自定义 NO_PROXY", () => {
  const env = buildProxyEnv({ ...OPTS, baseEnv: {}, noProxy: "127.0.0.1" });
  assert.equal(env["NO_PROXY"], "127.0.0.1");
});

test("buildProxyEnv：大小写两种代理变量都被统一覆盖（避免旧值干扰）", () => {
  const env = buildProxyEnv({ ...OPTS, baseEnv: { https_proxy: "http://old:1", HTTP_PROXY: "http://old:2" } });
  assert.equal(env["HTTPS_PROXY"], OPTS.proxyUrl);
  assert.equal(env["https_proxy"], OPTS.proxyUrl, "小写形式也应被覆盖");
  assert.equal(env["HTTP_PROXY"], OPTS.proxyUrl);
  assert.equal(env["http_proxy"], OPTS.proxyUrl, "小写形式也应被覆盖");
});
