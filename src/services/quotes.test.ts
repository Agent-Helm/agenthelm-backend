import assert from "node:assert/strict";
import test from "node:test";
import {
  buildV2Paths,
  buildV4CandidatePools,
  decodeV4InitializeLog,
  type V4PoolInit,
} from "./quotes.js";
import { getChainConfig } from "../chains.js";
import type { RpcLog } from "./rpc.js";

const BASE = 8453;
const VIRTUAL = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

test("buildV2Paths returns direct plus each intermediary hop to WETH", () => {
  const token = "0x1111111111111111111111111111111111111111" as const;
  const paths = buildV2Paths(getChainConfig(BASE), token);
  assert.deepEqual(paths, [
    [token, WETH],
    [token, VIRTUAL, WETH],
    [token, USDC, WETH],
  ]);
});

test("buildV4CandidatePools covers hookless tiers plus the known Clanker hooks", () => {
  const token = "0x1111111111111111111111111111111111111111" as const;
  const chain = getChainConfig(BASE);
  const pools = buildV4CandidatePools(chain, token);

  // 4 hookless fee tiers + (each configured hook x dynamic/static fee).
  const hookCount = chain.v4Hooks?.length ?? 0;
  assert.equal(pools.length, 4 + hookCount * 2);

  // A hookless standard tier is present.
  assert.ok(
    pools.some((p) => p.fee === 10000 && p.hooks === "0x0000000000000000000000000000000000000000"),
  );
  // A Clanker dynamic-fee candidate (0x800000, tickSpacing 200) for the first hook.
  const firstHook = chain.v4Hooks![0];
  assert.ok(
    pools.some((p) => p.fee === 0x800000 && p.tickSpacing === 200 && p.hooks === firstHook),
  );
  // Every candidate is the token/WETH pair, address-sorted.
  for (const p of pools) {
    const pair = [p.currency0.toLowerCase(), p.currency1.toLowerCase()];
    assert.ok(pair.includes(token) && pair.includes(WETH.toLowerCase()));
    assert.ok(BigInt(p.currency0) < BigInt(p.currency1));
  }
});

test("buildV2Paths skips an intermediary equal to the input token", () => {
  // Quoting VIRTUAL itself must not produce a VIRTUAL->VIRTUAL->WETH path.
  const paths = buildV2Paths(getChainConfig(BASE), VIRTUAL as `0x${string}`);
  for (const path of paths) {
    assert.ok(!(path.length === 3 && path[1].toLowerCase() === VIRTUAL.toLowerCase()));
  }
  assert.deepEqual(paths[0], [VIRTUAL, WETH]);
});

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (n: number | bigint) => pad(BigInt(n).toString(16));

// Real Base mainnet values for the DOTA / WETH Clanker v4 pool. The poolId,
// dynamic-fee flag, tickSpacing and hook were confirmed against on-chain data.
const WETH = "0x4200000000000000000000000000000000000006";
const DOTA = "0x5F09821CBb61e09D2a83124Ae0B56aaa3ae85B07";
const HOOK = "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC";
const POOL_ID =
  "0xecab64627a68ecbdb95da1fecde706c34ee4bec33843326f9f9689dde87d392d" as const;
const DYNAMIC_FEE = 0x800000;

function makeInitializeLog(fee: number, tickSpacing: number): RpcLog {
  return {
    address: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    topics: [
      "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
      POOL_ID,
      `0x${pad(WETH)}`,
      `0x${pad(DOTA)}`,
    ],
    // fee, tickSpacing, hooks, sqrtPriceX96, tick
    data: `0x${word(fee)}${word(tickSpacing)}${pad(HOOK)}${word(0)}${word(0)}`,
    blockNumber: "0x1",
  };
}

test("decodeV4InitializeLog recovers a Clanker dynamic-fee pool key", () => {
  const pool = decodeV4InitializeLog(makeInitializeLog(DYNAMIC_FEE, 200)) as V4PoolInit;
  assert.equal(pool.poolId, POOL_ID);
  assert.equal(pool.currency0, WETH.toLowerCase());
  assert.equal(pool.currency1, DOTA.toLowerCase());
  assert.equal(pool.fee, DYNAMIC_FEE); // 0x800000 dynamic-fee flag, not a percentage
  assert.equal(pool.tickSpacing, 200);
  assert.equal(pool.hooks, HOOK.toLowerCase());
});

test("decodeV4InitializeLog recovers a static-fee hooked pool key", () => {
  // e.g. POD's main pool: fee 10000 (1%) behind a hook.
  const pool = decodeV4InitializeLog(makeInitializeLog(10000, 200)) as V4PoolInit;
  assert.equal(pool.fee, 10000);
  assert.equal(pool.tickSpacing, 200);
  assert.equal(pool.hooks, HOOK.toLowerCase());
});

test("decodeV4InitializeLog returns null for malformed logs", () => {
  assert.equal(
    decodeV4InitializeLog({ ...makeInitializeLog(500, 10), topics: [] }),
    null,
  );
  assert.equal(decodeV4InitializeLog({ ...makeInitializeLog(500, 10), data: "0x" }), null);
});
