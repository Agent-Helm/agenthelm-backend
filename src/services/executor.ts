import sha3 from "js-sha3";
import { config } from "../config.js";
import { getChainConfig } from "../chains.js";
import { decodeUint, normalizeAddress, words } from "../utils/evm.js";
import { ethCall, ethGetCode } from "./rpc.js";

export type ExecutorFeeState = {
  collector: `0x${string}`;
  bips: number;
};

function selector(signature: string): `0x${string}` {
  return `0x${sha3.keccak_256(signature).slice(0, 8)}`;
}

function decodeAddressWord(word: string): `0x${string}` {
  return normalizeAddress(`0x${word.slice(-40)}`);
}

export function decodeExecutorFeeStateResults(
  collectorResult: `0x${string}`,
  feeBpsResult: `0x${string}`,
): ExecutorFeeState | null {
  const collectorWord = words(collectorResult)[0];
  const feeBpsWord = words(feeBpsResult)[0];
  if (!collectorWord || !feeBpsWord) return null;

  return {
    collector: decodeAddressWord(collectorWord),
    bips: Number(decodeUint(feeBpsWord)),
  };
}

export async function getExecutorFeeState(
  chainId = config.chainId,
): Promise<ExecutorFeeState | null> {
  const chain = getChainConfig(chainId);
  const dustExecutor = config.dustExecutorAddress ?? chain.dustExecutor;
  if (!dustExecutor) return null;

  const code = await ethGetCode(dustExecutor);
  if (code === "0x") return null;

  // Contract now charges a mode-dependent fee: ethFeeBps (10%) when the user
  // takes ETH, helmFeeBps (5%) when they take HELM. We read ethFeeBps as the
  // conservative (higher) estimate for net-out quoting; pass an explicit mode
  // through to refine this once the frontend exposes the HELM option.
  const [collectorResult, feeBpsResult] = await Promise.all([
    ethCall(dustExecutor, selector("ownerWallet()")),
    ethCall(dustExecutor, selector("ethFeeBps()")),
  ]);
  return decodeExecutorFeeStateResults(collectorResult, feeBpsResult);
}
