import "dotenv/config";
import { getChainConfig } from "./chains.js";

// The backend holds ALL third-party API keys. The browser never sees these.

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function optionalAddress(name: string): `0x${string}` | undefined {
  const value = optional(name);
  if (!value) return undefined;
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? (value as `0x${string}`) : undefined;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num("PORT", 4000),

  chainId: num("CHAIN_ID", 8453),
  rpcUrl: optional("RPC_URL"),
  ensRpcUrl: optional("ENS_RPC_URL"),
  dustExecutorAddress: optionalAddress("DUST_EXECUTOR_ADDRESS"),

  // Third-party API keys (server-side only).
  alchemyApiKey: optional("ALCHEMY_API_KEY"),
  goplusAppKey: optional("GOPLUS_APP_KEY"),
  coingeckoApiKey: optional("COINGECKO_API_KEY"),
  coinmarketcapApiKey: optional("COINMARKETCAP_API_KEY"),

  // CORS allow-list for the frontend origin(s); comma-separated.
  corsOrigins: (
    optional("CORS_ORIGINS") ??
    "http://localhost:3000,http://localhost:3001,http://localhost:3002"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
} as const;

// Sanity warnings for missing-but-needed config (don't crash on boot in dev).
export function warnMissingConfig(): void {
  let dustExecutorConfigured = false;
  try {
    dustExecutorConfigured = Boolean(
      config.dustExecutorAddress || getChainConfig(config.chainId).dustExecutor,
    );
  } catch {
    dustExecutorConfigured = false;
  }
  const warnIfMissing: Array<[string, unknown]> = [
    ["ALCHEMY_API_KEY", config.alchemyApiKey],
    ["RPC_URL", config.rpcUrl],
  ];
  for (const [name, value] of warnIfMissing) {
    if (!value) console.warn(`[config] Missing env var ${name}`);
  }
  if (!dustExecutorConfigured) {
    console.warn("[config] Missing env var DUST_EXECUTOR_ADDRESS");
  }
}
