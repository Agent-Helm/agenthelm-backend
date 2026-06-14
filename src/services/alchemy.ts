import { config } from "../config.js";
import { getChainConfig } from "../chains.js";

type JsonRpcError = {
  code: number;
  message: string;
};

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: JsonRpcError;
};

export type AlchemyTokenBalance = {
  contractAddress: `0x${string}`;
  tokenBalance: `0x${string}` | null;
  error?: string | null;
};

export type AlchemyTokenBalancesResult = {
  address: `0x${string}`;
  tokenBalances: AlchemyTokenBalance[];
};

export type AlchemyTokenMetadata = {
  decimals?: number | string | null;
  logo?: string | null;
  name?: string | null;
  symbol?: string | null;
  spam?: boolean;
  isSpam?: boolean;
};

export function getAlchemyRpcUrl(chainId = config.chainId): string | undefined {
  if (!config.alchemyApiKey) return undefined;
  const chain = getChainConfig(chainId);
  return `https://${chain.alchemyNetwork}.g.alchemy.com/v2/${config.alchemyApiKey}`;
}

export async function alchemyRpc<T>(
  method: string,
  params: unknown[],
): Promise<T> {
  const url = getAlchemyRpcUrl();
  if (!url) {
    throw new Error("ALCHEMY_API_KEY is required for this endpoint");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`Alchemy request failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as JsonRpcResponse<T>;
  if (body.error) {
    throw new Error(`Alchemy ${method} failed: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error(`Alchemy ${method} returned no result`);
  }
  return body.result;
}

export function getTokenBalances(owner: `0x${string}`) {
  return alchemyRpc<AlchemyTokenBalancesResult>("alchemy_getTokenBalances", [
    owner,
    "erc20",
  ]);
}

export function getTokenMetadata(tokenAddress: `0x${string}`) {
  return alchemyRpc<AlchemyTokenMetadata>("alchemy_getTokenMetadata", [
    tokenAddress,
  ]);
}
