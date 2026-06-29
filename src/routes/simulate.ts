import { Router } from "express";
import { isHexAddress, normalizeAddress } from "../utils/evm.js";
import { simulateConvertDust } from "../services/simulation.js";

export const simulateRouter = Router();

function isHexData(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);
}

simulateRouter.post("/api/simulate", async (req, res) => {
  const body = req.body ?? {};
  const { from, to, data, value } = body as Record<string, unknown>;

  if (!isHexAddress(String(from)) || !isHexAddress(String(to))) {
    res.status(400).json({ error: "invalid_address", message: "from and to must be addresses" });
    return;
  }
  if (!isHexData(data)) {
    res.status(400).json({ error: "invalid_data", message: "data must be 0x-prefixed hex" });
    return;
  }
  if (value !== undefined && !isHexData(value)) {
    res.status(400).json({ error: "invalid_value", message: "value must be 0x-prefixed hex" });
    return;
  }

  try {
    const result = await simulateConvertDust({
      from: normalizeAddress(String(from)),
      to: normalizeAddress(String(to)),
      data,
      value: value as `0x${string}` | undefined,
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(502).json({ error: "simulation_failed", message });
  }
});
