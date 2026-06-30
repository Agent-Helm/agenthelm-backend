import sha3 from "js-sha3";
import { getChainConfig } from "../chains.js";
import {
  decodeUint,
  encodeAddress,
  encodeAddressArray,
  encodeUint,
  normalizeAddress,
  words,
} from "../utils/evm.js";
import { ethCall, ethGetLogs, type RpcLog } from "./rpc.js";

export type QuoteResult = {
  dex: "Uniswap";
  version: "v2" | "v3" | "v4";
  amountOutRaw: string;
  feeTier?: number;
  tickSpacing?: number;
  hooks?: `0x${string}`;
  route: `0x${string}`[];
};

const V3_FEE_TIERS = [100, 500, 3000, 10000];
const V4_FEE_TIERS = [
  { feeTier: 100, tickSpacing: 1 },
  { feeTier: 500, tickSpacing: 10 },
  { feeTier: 3000, tickSpacing: 60 },
  { feeTier: 10000, tickSpacing: 200 },
];
const MAX_UINT128 = 2n ** 128n - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// Uniswap V4 PoolManager.Initialize(id, currency0, currency1, fee, tickSpacing,
// hooks, sqrtPriceX96, tick). `id`, `currency0`, `currency1` are indexed.
const V4_INITIALIZE_TOPIC =
  `0x${sha3.keccak_256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")}` as `0x${string}`;
// Cap how many discovered pools we quote per token to bound RPC fan-out.
const MAX_V4_POOLS_TO_QUOTE = 16;
// Clanker pools use tickSpacing 200 with either the dynamic-fee flag or a static
// 1% fee. Probed directly via the Quoter when getLogs discovery is unavailable.
const DYNAMIC_FEE_FLAG = 0x800000;
const V4_CLANKER_FEES = [DYNAMIC_FEE_FLAG, 10000];
const V4_CLANKER_TICK_SPACING = 200;

type V4PoolCandidate = {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
};

export type V4PoolInit = {
  poolId: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
};

function addressTopic(address: `0x${string}`): `0x${string}` {
  return `0x${normalizeAddress(address).slice(2).padStart(64, "0")}`;
}

function addressFromWord(word: string): `0x${string}` {
  return normalizeAddress(`0x${word.slice(-40)}`);
}

function decodeInt24Word(word: string): number {
  // ABI sign-extends int24 across the full 256-bit word.
  const value = BigInt(`0x${word}`);
  return value >= 1n << 255n ? Number(value - (1n << 256n)) : Number(value);
}

export function decodeV4InitializeLog(log: RpcLog): V4PoolInit | null {
  if (log.topics.length < 4) return null;
  const dataWords = words(log.data);
  if (dataWords.length < 5) return null;
  return {
    poolId: log.topics[1],
    currency0: addressFromWord(log.topics[2]),
    currency1: addressFromWord(log.topics[3]),
    fee: Number(decodeUint(dataWords[0])),
    tickSpacing: decodeInt24Word(dataWords[1]),
    hooks: addressFromWord(dataWords[2]),
  };
}

/// Discover every V4 pool that pairs `token` with WETH by reading the
/// PoolManager's Initialize events. This recovers the real (fee, tickSpacing,
/// hooks) for hooked pools (Clanker and others) generically, with no hardcoded
/// hook list. currency0/currency1 in a V4 PoolKey are address-sorted, so we know
/// exactly which slot each of (token, WETH) occupies and can pin both indexed
/// topics — one precise query returns all token/WETH pools across every
/// fee/tickSpacing/hook. Needs an RPC with full-range eth_getLogs (Alchemy PAYG);
/// on a range-capped tier it disables itself and callers fall back to probing.
export async function discoverV4WethPools(
  chainId: number,
  token: `0x${string}`,
): Promise<V4PoolInit[]> {
  const chain = getChainConfig(chainId);
  if (!chain.v4PoolManager) return [];

  const [currency0, currency1] =
    BigInt(token) < BigInt(chain.weth) ? [token, chain.weth] : [chain.weth, token];

  let logs: RpcLog[];
  try {
    logs = await ethGetLogs({
      address: chain.v4PoolManager,
      topics: [V4_INITIALIZE_TOPIC, null, addressTopic(currency0), addressTopic(currency1)],
    });
  } catch {
    // Range-limited / unsupported getLogs (e.g. a free RPC tier): let the
    // Quoter-based candidate fallback take over for this token.
    return [];
  }

  const seen = new Set<string>();
  const pools: V4PoolInit[] = [];
  for (const log of logs) {
    const pool = decodeV4InitializeLog(log);
    if (!pool) continue;
    const key = pool.poolId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pools.push(pool);
  }
  return pools;
}

function selector(signature: string): string {
  return sha3.keccak_256(signature).slice(0, 8);
}

function encodeV2GetAmountsOut(
  amountIn: bigint,
  path: `0x${string}`[],
): `0x${string}` {
  return `0x${selector("getAmountsOut(uint256,address[])")}${encodeUint(amountIn)}${encodeUint(
    64,
  )}${encodeAddressArray(path)}`;
}

function decodeV2AmountOut(result: `0x${string}`): bigint {
  const decodedWords = words(result);
  if (decodedWords.length < 4) throw new Error("Malformed V2 quote");
  const length = Number(decodeUint(decodedWords[1]));
  if (length < 2) throw new Error("Malformed V2 quote length");
  return decodeUint(decodedWords[1 + length]);
}

function encodeV3QuoteExactInputSingle(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  fee: number,
): `0x${string}` {
  return `0x${selector(
    "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
  )}${encodeAddress(tokenIn)}${encodeAddress(tokenOut)}${encodeUint(amountIn)}${encodeUint(
    fee,
  )}${encodeUint(0)}`;
}

function decodeV3AmountOut(result: `0x${string}`): bigint {
  const decodedWords = words(result);
  if (decodedWords.length < 1) throw new Error("Malformed V3 quote");
  return decodeUint(decodedWords[0]);
}

function encodeBool(value: boolean): string {
  return encodeUint(value ? 1 : 0);
}

function encodeV4QuoteExactInputSingle(params: {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  feeTier: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  zeroForOne: boolean;
  amountIn: bigint;
}): `0x${string}` {
  return `0x${selector(
    "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))",
  )}${encodeUint(32)}${encodeAddress(params.currency0)}${encodeAddress(
    params.currency1,
  )}${encodeUint(params.feeTier)}${encodeUint(params.tickSpacing)}${encodeAddress(
    params.hooks,
  )}${encodeBool(params.zeroForOne)}${encodeUint(params.amountIn)}${encodeUint(
    256,
  )}${encodeUint(0)}`;
}

function sortPoolCurrencies(tokenIn: `0x${string}`, weth: `0x${string}`) {
  const token = tokenIn.toLowerCase() as `0x${string}`;
  const wrapped = weth.toLowerCase() as `0x${string}`;
  return BigInt(token) < BigInt(wrapped)
    ? {
        currency0: token,
        currency1: wrapped,
        zeroForOne: true,
      }
    : {
        currency0: wrapped,
        currency1: token,
        zeroForOne: false,
      };
}

export function buildV2Paths(
  chain: ReturnType<typeof getChainConfig>,
  tokenIn: `0x${string}`,
): `0x${string}`[][] {
  const tokenLower = tokenIn.toLowerCase();
  const wethLower = chain.weth.toLowerCase();
  const paths: `0x${string}`[][] = [[tokenIn, chain.weth]];
  for (const mid of chain.v2Intermediaries ?? []) {
    const midLower = mid.toLowerCase();
    if (midLower === tokenLower || midLower === wethLower) continue;
    // token -> intermediary -> WETH (e.g. agentToken -> VIRTUAL -> WETH).
    paths.push([tokenIn, mid, chain.weth]);
  }
  return paths;
}

async function quoteV2Path(
  router: `0x${string}`,
  amountIn: bigint,
  path: `0x${string}`[],
): Promise<QuoteResult | null> {
  try {
    const result = await ethCall(router, encodeV2GetAmountsOut(amountIn, path));
    const amountOut = decodeV2AmountOut(result);
    return amountOut > 0n
      ? {
          dex: "Uniswap",
          version: "v2",
          amountOutRaw: amountOut.toString(),
          route: path,
        }
      : null;
  } catch {
    return null;
  }
}

export async function quoteV2(
  chainId: number,
  tokenIn: `0x${string}`,
  amountIn: bigint,
): Promise<QuoteResult | null> {
  const chain = getChainConfig(chainId);
  if (!chain.v2Router02) return null;

  // Try the direct token->WETH path plus each allow-listed intermediary hop, and
  // keep whichever yields the most WETH. The contract's V2 route already accepts
  // an arbitrary path, so multi-hop needs no contract change.
  const quotes = await Promise.all(
    buildV2Paths(chain, tokenIn).map((path) =>
      quoteV2Path(chain.v2Router02!, amountIn, path),
    ),
  );
  return quotes
    .filter((quote): quote is QuoteResult => quote !== null)
    .sort((a, b) => {
      const left = BigInt(a.amountOutRaw);
      const right = BigInt(b.amountOutRaw);
      return left === right ? 0 : left > right ? -1 : 1;
    })[0] ?? null;
}

async function quoteV3(
  chainId: number,
  tokenIn: `0x${string}`,
  amountIn: bigint,
): Promise<QuoteResult[]> {
  const chain = getChainConfig(chainId);
  if (!chain.v3QuoterV2) return [];

  const quotes = await Promise.all(
    V3_FEE_TIERS.map(async (feeTier): Promise<QuoteResult | null> => {
      try {
        const result = await ethCall(
          chain.v3QuoterV2!,
          encodeV3QuoteExactInputSingle(tokenIn, chain.weth, amountIn, feeTier),
        );
        const amountOut = decodeV3AmountOut(result);
        return amountOut > 0n
          ? {
              dex: "Uniswap",
              version: "v3",
              feeTier,
              amountOutRaw: amountOut.toString(),
              route: [tokenIn, chain.weth],
            }
          : null;
      } catch {
        return null;
      }
    }),
  );

  return quotes.filter((quote): quote is QuoteResult => quote !== null);
}

async function quoteV4Pool(
  chainId: number,
  tokenIn: `0x${string}`,
  amountIn: bigint,
  pool: {
    currency0: `0x${string}`;
    currency1: `0x${string}`;
    fee: number;
    tickSpacing: number;
    hooks: `0x${string}`;
  },
): Promise<QuoteResult | null> {
  const chain = getChainConfig(chainId);
  try {
    const zeroForOne = pool.currency0.toLowerCase() === tokenIn.toLowerCase();
    const result = await ethCall(
      chain.v4Quoter!,
      encodeV4QuoteExactInputSingle({
        currency0: pool.currency0,
        currency1: pool.currency1,
        feeTier: pool.fee,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
        zeroForOne,
        amountIn,
      }),
    );
    const amountOut = decodeV3AmountOut(result);
    return amountOut > 0n
      ? {
          dex: "Uniswap",
          version: "v4",
          feeTier: pool.fee,
          tickSpacing: pool.tickSpacing,
          hooks: pool.hooks,
          amountOutRaw: amountOut.toString(),
          route: [tokenIn, chain.weth],
        }
      : null;
  } catch {
    return null;
  }
}

/// Candidate token/WETH pools to probe via the Quoter when getLogs discovery is
/// unavailable (range-capped RPC tier). Covers the standard hookless fee tiers
/// plus the known Clanker hooks (dynamic + static 1%, tickSpacing 200), so
/// Clanker / Bankr tokens stay quotable without full-range logs.
export function buildV4CandidatePools(
  chain: ReturnType<typeof getChainConfig>,
  tokenIn: `0x${string}`,
): V4PoolCandidate[] {
  const sorted = sortPoolCurrencies(tokenIn, chain.weth);
  const base = { currency0: sorted.currency0, currency1: sorted.currency1 };
  const pools: V4PoolCandidate[] = V4_FEE_TIERS.map(({ feeTier, tickSpacing }) => ({
    ...base,
    fee: feeTier,
    tickSpacing,
    hooks: ZERO_ADDRESS,
  }));
  for (const hooks of chain.v4Hooks ?? []) {
    for (const fee of V4_CLANKER_FEES) {
      pools.push({ ...base, fee, tickSpacing: V4_CLANKER_TICK_SPACING, hooks });
    }
  }
  return pools;
}

async function quoteV4(
  chainId: number,
  tokenIn: `0x${string}`,
  amountIn: bigint,
): Promise<QuoteResult[]> {
  const chain = getChainConfig(chainId);
  if (!chain.v4Quoter || amountIn > MAX_UINT128) return [];

  // Primary: discover real pools (any fee/tickSpacing/hook) from Initialize
  // events. Fallback: probe known hookless tiers + Clanker hooks when discovery
  // is unavailable or finds nothing on this RPC.
  const discovered = await discoverV4WethPools(chainId, tokenIn);
  const pools: V4PoolCandidate[] =
    discovered.length > 0 ? discovered : buildV4CandidatePools(chain, tokenIn);

  const quotes = await Promise.all(
    pools
      .slice(0, MAX_V4_POOLS_TO_QUOTE)
      .map((pool) => quoteV4Pool(chainId, tokenIn, amountIn, pool)),
  );
  return quotes.filter((quote): quote is QuoteResult => quote !== null);
}

export async function findBestTokenToWethQuote(
  chainId: number,
  tokenIn: `0x${string}`,
  amountIn: bigint,
): Promise<QuoteResult | null> {
  const [v2, v3Quotes, v4Quotes] = await Promise.all([
    quoteV2(chainId, tokenIn, amountIn),
    quoteV3(chainId, tokenIn, amountIn),
    quoteV4(chainId, tokenIn, amountIn),
  ]);
  const candidates = [v2, ...v3Quotes, ...v4Quotes].filter(
    (quote): quote is QuoteResult => quote !== null,
  );
  candidates.sort((a, b) => {
    const left = BigInt(a.amountOutRaw);
    const right = BigInt(b.amountOutRaw);
    return left === right ? 0 : left > right ? -1 : 1;
  });
  return candidates[0] ?? null;
}
