import sha3 from "js-sha3";
import { config } from "../config.js";
import { normalizeAddress } from "../utils/evm.js";

const ENS_REGISTRY = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e";
const RESOLVER_SELECTOR = "0178b8bf";
const ADDR_SELECTOR = "3b3b57de";

type JsonRpcResponse = {
  result?: string;
  error?: {
    message: string;
  };
};

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function keccakHex(bytes: Uint8Array): string {
  return sha3.keccak_256(bytes);
}

function namehash(name: string): string {
  let node = "00".repeat(32);
  if (!name) return node;

  const labels = name.toLowerCase().split(".").reverse();
  for (const label of labels) {
    const labelHash = keccakHex(new TextEncoder().encode(label));
    node = keccakHex(hexToBytes(`${node}${labelHash}`));
  }
  return node;
}

async function rpcCall(rpcUrl: string, to: string, data: string): Promise<string | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });

  if (!response.ok) {
    throw new Error(`ENS RPC failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) throw new Error(`ENS RPC failed: ${body.error.message}`);
  if (!body.result || body.result === "0x") return null;
  return body.result;
}

function decodeAddress(result: string | null): `0x${string}` | null {
  if (!result || result.length < 66) return null;
  const address = `0x${result.slice(-40)}`;
  if (/^0x0{40}$/.test(address)) return null;
  return normalizeAddress(address);
}

function ensRpcUrl(): string {
  return config.ensRpcUrl ?? "https://ethereum-rpc.publicnode.com";
}

export async function resolveEnsName(name: string): Promise<`0x${string}` | null> {
  const rpcUrl = ensRpcUrl();

  const node = namehash(name);
  const resolverResult = await rpcCall(
    rpcUrl,
    ENS_REGISTRY,
    `0x${RESOLVER_SELECTOR}${node}`,
  );
  const resolver = decodeAddress(resolverResult);
  if (!resolver) return null;

  const addressResult = await rpcCall(rpcUrl, resolver, `0x${ADDR_SELECTOR}${node}`);
  return decodeAddress(addressResult);
}
