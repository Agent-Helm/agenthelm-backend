import assert from "node:assert/strict";
import test from "node:test";
import { parseAlchemyEthUsd } from "./pricing.js";

test("parseAlchemyEthUsd reads the USD value for ETH", () => {
  const body = {
    data: [
      {
        symbol: "ETH",
        prices: [{ currency: "usd", value: "1568.7", lastUpdatedAt: "2026-06-30T21:44:01.733Z" }],
      },
    ],
  };
  assert.equal(parseAlchemyEthUsd(body), 1568.7);
});

test("parseAlchemyEthUsd returns null for missing/malformed data", () => {
  assert.equal(parseAlchemyEthUsd(null), null);
  assert.equal(parseAlchemyEthUsd({}), null);
  assert.equal(parseAlchemyEthUsd({ data: [] }), null);
  assert.equal(parseAlchemyEthUsd({ data: [{ symbol: "ETH", prices: [] }] }), null);
  assert.equal(
    parseAlchemyEthUsd({ data: [{ symbol: "ETH", prices: [{ currency: "eur", value: "1400" }] }] }),
    null,
  );
  assert.equal(
    parseAlchemyEthUsd({ data: [{ symbol: "ETH", prices: [{ currency: "usd", value: "n/a" }] }] }),
    null,
  );
});
