import { Router } from "express";
import { getReadRpcUrl } from "../services/rpc.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

const readOnlyRpcMethods = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "net_version",
  "web3_clientVersion",
]);

export const rpcRouter = Router();

function getRequests(body: unknown): JsonRpcRequest[] | null {
  if (Array.isArray(body)) return body as JsonRpcRequest[];
  if (body && typeof body === "object") return [body as JsonRpcRequest];
  return null;
}

function getRequestId(request: JsonRpcRequest, fallback: number) {
  return request.id ?? fallback;
}

rpcRouter.post("/rpc", async (req, res, next) => {
  const requests = getRequests(req.body);
  if (!requests || requests.length === 0) {
    res.status(400).json({ error: "invalid_json_rpc_request" });
    return;
  }

  const forbiddenRequest = requests.find(
    (request) =>
      typeof request.method !== "string" ||
      !readOnlyRpcMethods.has(request.method),
  );
  if (forbiddenRequest) {
    res.status(403).json({
      jsonrpc: "2.0",
      id: getRequestId(forbiddenRequest, 1),
      error: {
        code: -32601,
        message: `RPC method is not proxied: ${String(forbiddenRequest.method)}`,
      },
    });
    return;
  }

  const rpcUrl = getReadRpcUrl();
  if (!rpcUrl) {
    res.status(503).json({
      jsonrpc: "2.0",
      id: getRequestId(requests[0], 1),
      error: {
        code: -32000,
        message: "RPC_URL or ALCHEMY_API_KEY is required",
      },
    });
    return;
  }

  try {
    const upstream = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const text = await upstream.text();
    res
      .status(upstream.status)
      .type(upstream.headers.get("content-type") ?? "application/json")
      .send(text);
  } catch (err) {
    next(err);
  }
});
