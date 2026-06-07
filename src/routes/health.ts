import { Router } from "express";
import { config } from "../config.js";
import { getChainConfig, getDustExecutorSetup } from "../chains.js";
import { getReadRpcUrl } from "../services/rpc.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  let chainName: string | null = null;
  let chainConfigured = true;
  try {
    chainName = getChainConfig(config.chainId).name;
  } catch {
    chainConfigured = false;
    chainName = null;
  }
  const rpcConfigured = Boolean(getReadRpcUrl());
  const chain = chainConfigured ? getChainConfig(config.chainId) : null;
  const dustExecutor = config.dustExecutorAddress ?? chain?.dustExecutor ?? null;
  const blockers = [
    chainConfigured ? null : `Unsupported CHAIN_ID ${config.chainId}`,
    config.alchemyApiKey ? null : "ALCHEMY_API_KEY is required for token balances",
    rpcConfigured ? null : "RPC_URL or ALCHEMY_API_KEY is required for quotes",
    config.goplusAppKey ? null : "GOPLUS_APP_KEY is required for production security checks",
    dustExecutor ? null : "DUST_EXECUTOR_ADDRESS must be configured",
  ].filter((blocker): blocker is string => blocker !== null);

  res.json({
    status: blockers.length === 0 ? "ok" : "degraded",
    ready: blockers.length === 0,
    blockers,
    service: "agenthelm-backend",
    chainId: config.chainId,
    chain: chainName,
    // Surface which integrations are configured (booleans only — never the keys).
    integrations: {
      alchemy: Boolean(config.alchemyApiKey),
      rpc: Boolean(config.rpcUrl),
      coingecko: Boolean(config.coingeckoApiKey),
      coinmarketcap: Boolean(config.coinmarketcapApiKey),
      goplus: Boolean(config.goplusAppKey),
    },
    executor: {
      address: dustExecutor,
      configured: Boolean(dustExecutor),
      setup: chain ? getDustExecutorSetup(chain) : null,
    },
    uniswap: chain
      ? {
          universalRouter: chain.universalRouter,
          permit2: chain.permit2,
          weth: chain.weth,
          v2: {
            factory: chain.v2Factory ?? null,
            router02: chain.v2Router02 ?? null,
          },
          v3: {
            factory: chain.v3Factory ?? null,
            swapRouter02: chain.v3Router ?? null,
            quoterV2: chain.v3QuoterV2 ?? null,
          },
          v4: {
            poolManager: chain.v4PoolManager ?? null,
            quoter: chain.v4Quoter ?? null,
            stateView: chain.v4StateView ?? null,
            universalRouter: chain.universalRouter,
          },
        }
      : null,
    time: new Date().toISOString(),
  });
});
