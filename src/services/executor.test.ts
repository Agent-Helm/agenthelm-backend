import assert from "node:assert/strict";
import test from "node:test";
import { decodeExecutorFeeStateResults } from "./executor.js";

test("decodeExecutorFeeStateResults decodes fee collector and bips", () => {
  assert.deepEqual(
    decodeExecutorFeeStateResults(
      "0x0000000000000000000000001111111111111111111111111111111111111111",
      "0x0000000000000000000000000000000000000000000000000000000000000064",
    ),
    {
      collector: "0x1111111111111111111111111111111111111111",
      bips: 100,
    },
  );
});

test("decodeExecutorFeeStateResults treats empty getter data as unavailable", () => {
  assert.equal(decodeExecutorFeeStateResults("0x", "0x"), null);
});
