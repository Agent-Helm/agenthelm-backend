import assert from "node:assert/strict";
import test from "node:test";
import { honeypotFlagToFinding, percentToBips } from "./security.js";

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

test("honeypotFlagToFinding normalizes string flags", () => {
  assert.deepEqual(honeypotFlagToFinding("Owner can pause trading", "medium"), {
    source: "honeypot",
    severity: "warning",
    message: "Owner can pause trading",
  });
});

test("honeypotFlagToFinding normalizes object flags into renderable messages", () => {
  assert.deepEqual(
    honeypotFlagToFinding(
      {
        flag: "high_sell_tax",
        description: "Sell tax is above the configured risk threshold",
        severity: "high",
        severityIndex: 4,
      },
      "medium",
    ),
    {
      source: "honeypot",
      severity: "block",
      message: "high_sell_tax: Sell tax is above the configured risk threshold",
    },
  );
});
