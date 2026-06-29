import sha3 from "js-sha3";
import { decodeUint, normalizeAddress, words } from "../utils/evm.js";
import { rpc } from "./rpc.js";

// DustExecutor events we care about for outcome detection.
const SWAP_SKIPPED_TOPIC =
  `0x${sha3.keccak_256("SwapSkipped(address,address,uint8,string)")}` as `0x${string}`;
const DUST_CONVERTED_TOPIC =
  `0x${sha3.keccak_256("DustConverted(address,address,uint8,uint256,uint256)")}` as `0x${string}`;
const TRANSFER_TOPIC =
  `0x${sha3.keccak_256("Transfer(address,address,uint256)")}` as `0x${string}`;
// eth_simulateV1 emits native-ETH movements (traceTransfers) from this address.
const NATIVE_TRANSFER_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

type RpcSimLog = { address: string; topics: string[]; data: string };
type RpcSimCall = {
  status?: string;
  gasUsed?: string;
  logs?: RpcSimLog[];
  error?: { message?: string };
  returnData?: string;
};

export type SimulationRequest = {
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: `0x${string}`;
};

export type SimulationResult = {
  status: "success" | "reverted";
  revertReason: string | null;
  converted: { token: `0x${string}`; ethOut: string }[];
  skipped: { token: `0x${string}`; reason: string }[];
  /** Net native ETH credited to the caller (settlement payout), in wei. */
  userEthWei: string;
  gasUsed: number | null;
};

function tokenFromTopic(topic: string): `0x${string}` {
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

/// Decode an ABI-encoded `string` from event data (offset, length, bytes).
function decodeAbiString(data: string): string {
  const w = words(data);
  if (w.length < 2) return "";
  const length = Number(decodeUint(w[1]));
  if (length === 0) return "";
  const hex = data.replace(/^0x/, "").slice(128, 128 + length * 2);
  return Buffer.from(hex, "hex").toString("utf8");
}

/// Try to surface a human revert reason from Error(string) return data.
function decodeRevertReason(returnData?: string): string | null {
  if (!returnData || returnData === "0x") return null;
  // Error(string) selector 0x08c379a0, then an ABI string.
  if (returnData.startsWith("0x08c379a0")) {
    try {
      return decodeAbiString(`0x${returnData.slice(10)}`) || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function decodeSimulationCall(
  call: RpcSimCall,
  caller: `0x${string}`,
): SimulationResult {
  const reverted = call.status === "0x0";
  const converted: SimulationResult["converted"] = [];
  const skipped: SimulationResult["skipped"] = [];
  let userEthWei = 0n;
  const callerLower = caller.toLowerCase();

  for (const log of call.logs ?? []) {
    const topic0 = (log.topics[0] ?? "").toLowerCase();
    if (topic0 === SWAP_SKIPPED_TOPIC && log.topics.length >= 3) {
      skipped.push({ token: tokenFromTopic(log.topics[2]), reason: decodeAbiString(log.data) });
    } else if (topic0 === DUST_CONVERTED_TOPIC && log.topics.length >= 3) {
      const dataWords = words(log.data);
      converted.push({
        token: tokenFromTopic(log.topics[2]),
        ethOut: dataWords[1] ? decodeUint(dataWords[1]).toString() : "0",
      });
    } else if (
      topic0 === TRANSFER_TOPIC &&
      log.address.toLowerCase() === NATIVE_TRANSFER_ADDRESS &&
      log.topics.length >= 3 &&
      tokenFromTopic(log.topics[2]).toLowerCase() === callerLower
    ) {
      // Native ETH credited to the caller (settlement payout).
      const w = words(log.data);
      if (w[0]) userEthWei += decodeUint(w[0]);
    }
  }

  return {
    status: reverted ? "reverted" : "success",
    revertReason: reverted
      ? (call.error?.message ?? decodeRevertReason(call.returnData) ?? "execution reverted")
      : null,
    converted,
    skipped,
    userEthWei: userEthWei.toString(),
    gasUsed: call.gasUsed ? Number(decodeUint(call.gasUsed.replace(/^0x/, ""))) : null,
  };
}

/// Simulate a DustExecutor convertDust call with eth_simulateV1 and report, per
/// token, whether it would actually convert or silently skip (the contract
/// catches failed swaps and returns the token instead of reverting), plus the
/// net ETH the caller would receive. Approvals are read from live state, so this
/// must run after the user has approved the executor.
export async function simulateConvertDust(
  request: SimulationRequest,
): Promise<SimulationResult> {
  const response = await rpc<{ calls: RpcSimCall[] }[]>("eth_simulateV1", [
    {
      blockStateCalls: [
        {
          calls: [
            {
              from: request.from,
              to: request.to,
              data: request.data,
              value: request.value ?? "0x0",
            },
          ],
        },
      ],
      traceTransfers: true,
      validation: false,
    },
    "latest",
  ]);

  const call = response?.[0]?.calls?.[0];
  if (!call) {
    throw new Error("eth_simulateV1 returned no call result");
  }
  return decodeSimulationCall(call, request.from);
}
