import { Router } from "express";
import { config } from "../config.js";
import { getChainConfig } from "../chains.js";
import {
  getTokenBalances,
  getTokenMetadata,
  type AlchemyTokenMetadata,
} from "../services/alchemy.js";
import { resolveEnsName } from "../services/ens.js";
import { fetchMarketPrices } from "../services/pricing.js";
import { formatTokenUnits, isHexAddress, normalizeAddress } from "../utils/evm.js";

export const balancesRouter = Router();

type TokenRow = {
  tokenAddress: `0x${string}`;
  name: string | null;
  symbol: string;
  decimals: number;
  logo: string | null;
  balanceRaw: string;
  balanceFormatted: string;
  marketPriceUsd: number | null;
  marketPriceEth: number | null;
  marketValueUsd: number | null;
  marketValueEth: number | null;
  priceSource: string | null;
  priceStatus: "priced" | "pending";
};

async function resolveOwner(input: string): Promise<`0x${string}`> {
  const trimmed = input.trim();
  if (isHexAddress(trimmed)) return normalizeAddress(trimmed);

  const resolved = await resolveEnsName(trimmed);
  if (!resolved) {
    throw Object.assign(new Error("ENS name did not resolve"), { statusCode: 404 });
  }
  return resolved;
}

function parseDecimals(metadata: AlchemyTokenMetadata): number {
  const decimals =
    typeof metadata.decimals === "string"
      ? Number(metadata.decimals)
      : metadata.decimals;
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0
    ? decimals
    : 18;
}

function metadataMarksSpam(metadata: AlchemyTokenMetadata): boolean {
  return metadata.spam === true || metadata.isSpam === true;
}

function finiteNumber(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

balancesRouter.get("/api/balances", async (req, res) => {
  const ownerInput = typeof req.query.owner === "string" ? req.query.owner : "";
  if (!ownerInput.trim()) {
    res.status(400).json({ error: "owner_required" });
    return;
  }

  try {
    const owner = await resolveOwner(ownerInput);
    const chain = getChainConfig(config.chainId);
    const balanceResult = await getTokenBalances(owner);
    const nonZeroBalances = balanceResult.tokenBalances.filter((token) => {
      if (token.error || !token.tokenBalance) return false;
      try {
        return BigInt(token.tokenBalance) > 0n;
      } catch {
        return false;
      }
    });

    const metadataByAddress = new Map<string, AlchemyTokenMetadata>();
    await mapWithConcurrency(nonZeroBalances, 8, async (token) => {
      const metadata = await getTokenMetadata(token.contractAddress);
      metadataByAddress.set(token.contractAddress.toLowerCase(), metadata);
    });

    const usableBalances = nonZeroBalances.filter((token) => {
      const metadata = metadataByAddress.get(token.contractAddress.toLowerCase());
      return metadata ? !metadataMarksSpam(metadata) : true;
    });
    const prices = await fetchMarketPrices(
      usableBalances.map((token) => token.contractAddress),
    );

    const tokens: TokenRow[] = usableBalances.map((token) => {
      const metadata = metadataByAddress.get(token.contractAddress.toLowerCase()) ?? {};
      const decimals = parseDecimals(metadata);
      const balanceRaw = BigInt(token.tokenBalance ?? "0x0");
      const balanceFormatted = formatTokenUnits(balanceRaw, decimals);
      const balanceNumber = finiteNumber(balanceFormatted);
      const price = prices.get(token.contractAddress.toLowerCase()) ?? null;
      const marketValueUsd =
        price && balanceNumber !== null ? balanceNumber * price.priceUsd : null;
      const marketValueEth =
        price?.priceEth && balanceNumber !== null
          ? balanceNumber * price.priceEth
          : null;

      return {
        tokenAddress: normalizeAddress(token.contractAddress),
        name: metadata.name ?? null,
        symbol: metadata.symbol ?? "UNKNOWN",
        decimals,
        logo: metadata.logo ?? null,
        balanceRaw: balanceRaw.toString(),
        balanceFormatted,
        marketPriceUsd: price?.priceUsd ?? null,
        marketPriceEth: price?.priceEth ?? null,
        marketValueUsd,
        marketValueEth,
        priceSource: price?.source ?? null,
        priceStatus: price ? "priced" : "pending",
      };
    });

    tokens.sort((a, b) => (b.marketValueUsd ?? 0) - (a.marketValueUsd ?? 0));

    res.json({
      owner,
      chain: {
        id: chain.chainId,
        name: chain.name,
      },
      tokens,
      totals: {
        tokenCount: tokens.length,
        marketValueUsd: tokens.reduce((sum, token) => sum + (token.marketValueUsd ?? 0), 0),
        marketValueEth: tokens.reduce((sum, token) => sum + (token.marketValueEth ?? 0), 0),
        pricedTokenCount: tokens.filter((token) => token.priceStatus === "priced").length,
      },
      pricingNote:
        "Phase 2 uses best-effort market prices only; Phase 3 will replace headline values with on-chain quote realizable value.",
    });
  } catch (error) {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(statusCode).json({ error: "balances_failed", message });
  }
});
