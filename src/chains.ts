// Backend copy of the shared chain config map.
// Universal Router / Permit2 addresses are sourced from Uniswap v4 deployments:
// https://developers.uniswap.org/docs/protocols/v4/deployments

export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export type ChainConfig = {
  chainId: number;
  name: string;
  /** Uniswap Universal Router (v4-capable). */
  universalRouter: `0x${string}`;
  dustExecutor?: `0x${string}`;
  permit2: `0x${string}`;
  weth: `0x${string}`;
  v2Factory?: `0x${string}`;
  v3Router?: `0x${string}`;
  v3Factory?: `0x${string}`;
  v2Router02?: `0x${string}`;
  v3QuoterV2?: `0x${string}`;
  v4PoolManager?: `0x${string}`;
  v4Quoter?: `0x${string}`;
  v4StateView?: `0x${string}`;
  alchemyNetwork: string;
  defillamaSlug?: string;
  coingeckoPlatform?: string;
  isTestnet: boolean;
};

export const SUPPORTED_CHAINS: Record<number, ChainConfig> = {
  8453: {
    chainId: 8453,
    name: "Base",
    universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    permit2: PERMIT2_ADDRESS,
    weth: "0x4200000000000000000000000000000000000006",
    v2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    v2Router02: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
    v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    v3Router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    v3QuoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    v4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    v4Quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    v4StateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
    alchemyNetwork: "base-mainnet",
    defillamaSlug: "base",
    coingeckoPlatform: "base",
    isTestnet: false,
  },
};

export function getChainConfig(chainId: number): ChainConfig {
  const cfg = SUPPORTED_CHAINS[chainId];
  if (!cfg) throw new Error(`Unsupported chainId: ${chainId}`);
  return cfg;
}

export function getDustExecutorSetup(chain: ChainConfig) {
  const allowlistedRouters = [
    chain.v2Router02,
    chain.v3Router,
    chain.universalRouter,
  ].filter((router): router is `0x${string}` => Boolean(router));

  return {
    constructorArgs: {
      weth: chain.weth,
      permit2: chain.permit2,
    },
    allowlistedRouters,
  };
}
