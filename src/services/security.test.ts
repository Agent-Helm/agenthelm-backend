import assert from "node:assert/strict";
import test from "node:test";
import { percentToBips } from "./security.js";

test("percentToBips converts provider percentages to basis points", () => {
  assert.equal(percentToBips("1.25"), 125);
  assert.equal(percentToBips(0.5), 50);
  assert.equal(percentToBips("0"), 0);
});

test("percentToBips ignores missing or malformed provider values", () => {
  assert.equal(percentToBips(undefined), null);
  assert.equal(percentToBips(""), null);
  assert.equal(percentToBips("not-a-number"), null);
});
