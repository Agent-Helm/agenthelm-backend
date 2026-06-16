import sha3 from "js-sha3";
import { getChainConfig } from "../chains.js";
import {
  decodeUint,
  encodeAddress,
  encodeAddressArray,
  encodeUint,
  words,
} from "../utils/evm.js";
import { ethCall } from "./rpc.js";

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

export async function quoteV2(
  chainId: number,
  tokenIn: `0x${string}`,
  amountIn: bigint,
): Promise<QuoteResult | null> {
  const chain = getChainConfig(chainId);
  if (!chain.v2Router02) return null;
  try {
    const path = [tokenIn, chain.weth];
    const result = await ethCall(chain.v2Router02, encodeV2GetAmountsOut(amountIn, path));
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

async function quoteV4(
  chainId: number,
  tokenIn: `0x${string}`,
  amountIn: bigint,
): Promise<QuoteResult[]> {
  const chain = getChainConfig(chainId);
  if (!chain.v4Quoter || amountIn > MAX_UINT128) return [];
  const pool = sortPoolCurrencies(tokenIn, chain.weth);

  const quotes = await Promise.all(
    V4_FEE_TIERS.map(async ({ feeTier, tickSpacing }): Promise<QuoteResult | null> => {
      try {
        const result = await ethCall(
          chain.v4Quoter!,
          encodeV4QuoteExactInputSingle({
            currency0: pool.currency0,
            currency1: pool.currency1,
            feeTier,
            tickSpacing,
            hooks: ZERO_ADDRESS,
            zeroForOne: pool.zeroForOne,
            amountIn,
          }),
        );
        const amountOut = decodeV3AmountOut(result);
        return amountOut > 0n
          ? {
              dex: "Uniswap",
              version: "v4",
              feeTier,
              tickSpacing,
              hooks: ZERO_ADDRESS,
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
