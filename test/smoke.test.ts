import { test } from "node:test";
import assert from "node:assert/strict";

test("smoke: TS runs under node --test", () => {
  const x: number = 2;
  assert.equal(x, 2);
});
