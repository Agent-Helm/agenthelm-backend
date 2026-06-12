import { config } from "../config.js";
import { getAlchemyRpcUrl } from "./alchemy.js";

type RpcResponse<T> = {
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export class RpcMethodError extends Error {
  code: number;
  data: unknown;

  constructor(method: string, error: { code: number; message: string; data?: unknown }) {
    super(`RPC ${method} failed: ${error.message}`);
    this.name = "RpcMethodError";
    this.code = error.code;
    this.data = error.data;
  }
}

export function getReadRpcUrl(): string | undefined {
  return config.rpcUrl ?? getAlchemyRpcUrl();
}

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const rpcUrl = getReadRpcUrl();
  if (!rpcUrl) {
    throw Object.assign(new Error("RPC_URL or ALCHEMY_API_KEY is required"), {
      statusCode: 503,
    });
  }

  const response = await fetch(rpcUrl, {
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
    throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as RpcResponse<T>;
  if (body.error) {
    throw new RpcMethodError(method, body.error);
  }
  if (body.result === undefined) {
    throw new Error(`RPC ${method} returned no result`);
  }
  return body.result;
}

export function ethCall(to: `0x${string}`, data: `0x${string}`) {
  return rpc<`0x${string}`>("eth_call", [{ to, data }, "latest"]);
}

export function ethGetCode(address: `0x${string}`) {
  return rpc<`0x${string}`>("eth_getCode", [address, "latest"]);
}

export function gasPrice() {
  return rpc<`0x${string}`>("eth_gasPrice", []);
}
