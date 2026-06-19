import { Router } from "express";
import { config } from "../config.js";
import { getChainConfig } from "../chains.js";
import { findBestTokenToWethQuote, quoteV2, type QuoteResult } from "../services/quotes.js";
import { checkTokenSecurity, type SecurityFinding } from "../services/security.js";
import { getEthUsd } from "../services/pricing.js";
import { gasPrice } from "../services/rpc.js";
import { getExecutorFeeState, type ExecutorFeeState } from "../services/executor.js";
import { formatTokenUnits, isHexAddress, normalizeAddress } from "../utils/evm.js";

export const sellabilityRouter = Router();

type ScanTokenInput = {
  tokenAddress: string;
  symbol?: string;
  decimals?: number;
  balanceRaw: string;
};

type ScanResult = {
  tokenAddress: `0x${string}`;
  symbol: string;
  status: "sellable" | "unsellable" | "not_worth_selling";
  reason: string;
  route: QuoteResult | null;
  expectedEthOut: string | null;
  expectedEthOutRaw: string | null;
  expectedUsdOut: number | null;
  feeEth: string | null;
  estimatedGasEth: string | null;
  netEthAfterFeeGas: string | null;
  netUsdAfterFeeGas: number | null;
  gasUnits: number | null;
  sellTaxBips: number | null;
  buyTaxBips: number | null;
  securityFindings: SecurityFinding[];
  simulation: {
    status: "not_run" | "external_check";
    note: string;
  };
};

const GAS_BY_ROUTE: Record<"v2" | "v3" | "v4" | "weth", number> = {
  v2: 160_000,
  v3: 210_000,
  v4: 240_000,
  weth: 65_000,
};
const MAX_SCAN_TOKENS = 200;

function applySellTax(amount: bigint, sellTaxBips: number | null) {
  if (!sellTaxBips || sellTaxBips <= 0) return amount;
  const cappedTaxBips = Math.min(10_000, Math.max(0, sellTaxBips));
  return (amount * BigInt(10_000 - cappedTaxBips)) / 10_000n;
}

function parseToken(raw: ScanTokenInput): {
  tokenAddress: `0x${string}`;
  symbol: string;
  balanceRaw: bigint;
} {
  if (!isHexAddress(raw.tokenAddress)) {
    throw Object.assign(new Error(`Invalid token address: ${raw.tokenAddress}`), {
      statusCode: 400,
    });
  }
  const balanceRaw = BigInt(raw.balanceRaw);
  if (balanceRaw <= 0n) {
    throw Object.assign(new Error(`Invalid token balance for ${raw.tokenAddress}`), {
      statusCode: 400,
    });
  }
  return {
    tokenAddress: normalizeAddress(raw.tokenAddress),
    symbol: raw.symbol?.trim() || "UNKNOWN",
    balanceRaw,
  };
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

function weiToEthNumber(value: bigint): number {
  return Number(formatTokenUnits(value, 18));
}

function makeResult(
  token: ReturnType<typeof parseToken>,
  status: ScanResult["status"],
  reason: string,
  overrides: Partial<ScanResult> = {},
): ScanResult {
  return {
    tokenAddress: token.tokenAddress,
    symbol: token.symbol,
    status,
    reason,
    route: null,
    expectedEthOut: null,
    expectedEthOutRaw: null,
    expectedUsdOut: null,
    feeEth: null,
    estimatedGasEth: null,
    netEthAfterFeeGas: null,
    netUsdAfterFeeGas: null,
    gasUnits: null,
    sellTaxBips: null,
    buyTaxBips: null,
    securityFindings: [],
    simulation: {
      status: "not_run",
      note: "DustExecutor simulation has not run yet.",
    },
    ...overrides,
  };
}

async function scanOne(
  chainId: number,
  token: ReturnType<typeof parseToken>,
  gasPriceWei: bigint,
  ethUsd: number | null,
  feeState: ExecutorFeeState,
): Promise<ScanResult> {
  const chain = getChainConfig(chainId);
  const isWeth = token.tokenAddress.toLowerCase() === chain.weth.toLowerCase();
  let quote = isWeth
    ? {
        dex: "Uniswap" as const,
        version: "v2" as const,
        amountOutRaw: token.balanceRaw.toString(),
        route: [chain.weth],
      }
    : await findBestTokenToWethQuote(chainId, token.tokenAddress, token.balanceRaw);

  if (!quote) {
    return makeResult(token, "unsellable", "no route to WETH");
  }

  const security = isWeth
    ? {
        findings: [],
        sellTaxBips: null,
        buyTaxBips: null,
        honeypotChecked: true,
        goplusChecked: true,
      }
    : await checkTokenSecurity(chainId, token.tokenAddress);

  if (!isWeth && security.sellTaxBips && security.sellTaxBips > 0) {
    const postTaxAmountIn = applySellTax(token.balanceRaw, security.sellTaxBips);
    if (postTaxAmountIn <= 0n) {
      return makeResult(token, "unsellable", "sell tax leaves no swappable input");
    }

    const taxAdjustedV2Quote = await quoteV2(chainId, token.tokenAddress, postTaxAmountIn);
    if (!taxAdjustedV2Quote) {
      return makeResult(
        token,
        "unsellable",
        "sell-tax token requires a tax-adjusted V2 route",
      );
    }
    quote = taxAdjustedV2Quote;
  }

  const blockingFinding = security.findings.find((finding) => finding.severity === "block");
  const expectedOutWei = BigInt(quote.amountOutRaw);
  const gasUnits = isWeth ? GAS_BY_ROUTE.weth : GAS_BY_ROUTE[quote.version];
  const gasWei = gasPriceWei * BigInt(gasUnits);
  const feeWei = (expectedOutWei * BigInt(feeState.bips)) / 10_000n;
  const netWei = expectedOutWei - feeWei - gasWei;
  const expectedEth = formatTokenUnits(expectedOutWei, 18);
  const feeEth = formatTokenUnits(feeWei, 18);
  const gasEth = formatTokenUnits(gasWei, 18);
  const netEth = netWei > 0n ? formatTokenUnits(netWei, 18) : "0";
  const expectedUsdOut = ethUsd ? weiToEthNumber(expectedOutWei) * ethUsd : null;
  const netUsdAfterFeeGas = ethUsd && netWei > 0n ? weiToEthNumber(netWei) * ethUsd : null;

  const shared = {
    route: quote,
    expectedEthOut: expectedEth,
    expectedEthOutRaw: expectedOutWei.toString(),
    expectedUsdOut,
    feeEth,
    estimatedGasEth: gasEth,
    netEthAfterFeeGas: netEth,
    netUsdAfterFeeGas,
    gasUnits,
    sellTaxBips: security.sellTaxBips,
    buyTaxBips: security.buyTaxBips,
    securityFindings: security.findings,
    simulation: {
      status: security.honeypotChecked ? "external_check" : "not_run",
      note: security.honeypotChecked
        ? "honeypot.is external buy/sell simulation checked; DustExecutor simulation runs immediately before execution."
        : "DustExecutor simulation runs immediately before execution.",
    },
  } satisfies Partial<ScanResult>;

  if (blockingFinding) {
    return makeResult(token, "unsellable", blockingFinding.message, shared);
  }
  if (netWei <= 0n) {
    return makeResult(token, "not_worth_selling", "dust-below-gas", shared);
  }
  return makeResult(token, "sellable", "route + external security checks passed", shared);
}

sellabilityRouter.post("/api/sellability", async (req, res) => {
  const tokensInput = Array.isArray(req.body?.tokens) ? req.body.tokens : [];
  if (tokensInput.length === 0) {
    res.status(400).json({ error: "tokens_required" });
    return;
  }
  if (tokensInput.length > MAX_SCAN_TOKENS) {
    res.status(413).json({
      error: "too_many_tokens",
      message: `Scan at most ${MAX_SCAN_TOKENS} tokens at a time.`,
      maxTokens: MAX_SCAN_TOKENS,
    });
    return;
  }

  try {
    const chain = getChainConfig(config.chainId);
    const tokens = (tokensInput as ScanTokenInput[]).map(parseToken);
    const [gasPriceHex, ethUsd, executorFeeState] = await Promise.all([
      gasPrice(),
      getEthUsd(),
      getExecutorFeeState(config.chainId),
    ]);
    const gasPriceWei = BigInt(gasPriceHex);
    if (!executorFeeState) {
      throw Object.assign(new Error("DustExecutor fee state is not available"), {
        statusCode: 503,
      });
    }
    const feeState: ExecutorFeeState = executorFeeState;

    const results = await mapWithConcurrency(tokens, 4, (token) =>
      scanOne(config.chainId, token, gasPriceWei, ethUsd, feeState),
    );

    res.json({
      chain: {
        id: chain.chainId,
        name: chain.name,
      },
      fee: {
        recipient: feeState.collector,
        bips: feeState.bips,
      },
      gas: {
        gasPriceWei: gasPriceWei.toString(),
      },
      totals: {
        scanned: results.length,
        sellable: results.filter((result) => result.status === "sellable").length,
        notWorthSelling: results.filter((result) => result.status === "not_worth_selling")
          .length,
        unsellable: results.filter((result) => result.status === "unsellable").length,
      },
      results,
      note:
        "Quotes include V2/V3 plus hookless single-hop V4 where available. External risk checks run during scan; DustExecutor simulation runs again immediately before execution.",
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
    res.status(statusCode).json({ error: "sellability_failed", message });
  }
});
