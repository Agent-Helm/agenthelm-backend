import { config } from "../config.js";
import { getChainConfig } from "../chains.js";

export type MarketPrice = {
  priceUsd: number;
  priceEth: number | null;
  source: "defillama" | "coingecko";
};

type DefiLlamaResponse = {
  coins?: Record<
    string,
    {
      price?: number;
    }
  >;
};

type AlchemyPricesResponse = {
  data?: {
    symbol?: string;
    prices?: { currency?: string; value?: string }[];
    error?: unknown;
  }[];
};

type CoinGeckoTokenPrice = Record<
  string,
  {
    usd?: number;
    eth?: number;
  }
>;

const CHUNK_SIZE = 80;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function parseAlchemyEthUsd(body: AlchemyPricesResponse | null): number | null {
  const value = body?.data
    ?.find((entry) => entry.symbol === "ETH")
    ?.prices?.find((price) => price.currency === "usd")?.value;
  if (value == null) return null;
  const price = Number(value);
  return Number.isFinite(price) ? price : null;
}

async function fetchEthUsdFromAlchemy(): Promise<number | null> {
  if (!config.alchemyApiKey) return null;
  const url = `https://api.g.alchemy.com/prices/v1/${config.alchemyApiKey}/tokens/by-symbol?symbols=ETH`;
  return parseAlchemyEthUsd(await fetchJson<AlchemyPricesResponse>(url));
}

async function fetchEthUsdFromDefiLlama(): Promise<number | null> {
  const url = "https://coins.llama.fi/prices/current/coingecko:ethereum";
  const body = await fetchJson<DefiLlamaResponse>(url);
  const price = body?.coins?.["coingecko:ethereum"]?.price;
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

export async function getEthUsd(): Promise<number | null> {
  // Prefer Alchemy Prices (consolidated with the RPC/Token API on one paid plan,
  // SLA-backed). Fall back to DeFiLlama so ETH/USD still resolves if Alchemy is
  // unavailable or the key is unset.
  return (await fetchEthUsdFromAlchemy()) ?? (await fetchEthUsdFromDefiLlama());
}

export async function fetchMarketPrices(
  tokenAddresses: `0x${string}`[],
): Promise<Map<string, MarketPrice>> {
  const chain = getChainConfig(config.chainId);
  const uniqueAddresses = [...new Set(tokenAddresses.map((a) => a.toLowerCase()))];
  const prices = new Map<string, MarketPrice>();
  const ethUsd = await getEthUsd();

  if (chain.defillamaSlug) {
    for (const addressChunk of chunk(uniqueAddresses, CHUNK_SIZE)) {
      const coins = addressChunk.map((address) => `${chain.defillamaSlug}:${address}`);
      const url = `https://coins.llama.fi/prices/current/${coins.join(",")}`;
      const body = await fetchJson<DefiLlamaResponse>(url);
      for (const coin of coins) {
        const priceUsd = body?.coins?.[coin]?.price;
        if (typeof priceUsd !== "number" || !Number.isFinite(priceUsd)) continue;
        const address = coin.split(":")[1];
        prices.set(address, {
          priceUsd,
          priceEth: ethUsd ? priceUsd / ethUsd : null,
          source: "defillama",
        });
      }
    }
  }

  const missing = uniqueAddresses.filter((address) => !prices.has(address));
  if (missing.length > 0 && chain.coingeckoPlatform) {
    for (const addressChunk of chunk(missing, CHUNK_SIZE)) {
      const url = new URL(
        `https://api.coingecko.com/api/v3/simple/token_price/${chain.coingeckoPlatform}`,
      );
      url.searchParams.set("contract_addresses", addressChunk.join(","));
      url.searchParams.set("vs_currencies", "usd,eth");
      const headers: Record<string, string> = {};
      if (config.coingeckoApiKey) {
        headers["x-cg-demo-api-key"] = config.coingeckoApiKey;
      }

      const body = await fetchJson<CoinGeckoTokenPrice>(url.toString(), {
        headers,
      });
      if (!body) continue;
      for (const [address, tokenPrice] of Object.entries(body)) {
        if (typeof tokenPrice.usd !== "number" || !Number.isFinite(tokenPrice.usd)) {
          continue;
        }
        prices.set(address.toLowerCase(), {
          priceUsd: tokenPrice.usd,
          priceEth:
            typeof tokenPrice.eth === "number" && Number.isFinite(tokenPrice.eth)
              ? tokenPrice.eth
              : ethUsd
                ? tokenPrice.usd / ethUsd
                : null,
          source: "coingecko",
        });
      }
    }
  }

  return prices;
}
