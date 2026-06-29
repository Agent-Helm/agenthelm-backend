import express from "express";
import cors from "cors";
import { config, warnMissingConfig } from "./config.js";
import { healthRouter } from "./routes/health.js";
import { balancesRouter } from "./routes/balances.js";
import { sellabilityRouter } from "./routes/sellability.js";
import { simulateRouter } from "./routes/simulate.js";
import { rpcRouter } from "./routes/rpc.js";

warnMissingConfig();

const app = express();

app.use(
  cors({
    origin: config.corsOrigins,
  }),
);
app.use(express.json());

// Routes. Phase 1 ships only the health check; later phases add /api/* routes.
app.use("/", healthRouter);
app.use("/", balancesRouter);
app.use("/", sellabilityRouter);
app.use("/", simulateRouter);
app.use("/", rpcRouter);

// 404 fallback.
app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(config.port, () => {
  console.log(
    `[backend] listening on http://localhost:${config.port} (chainId=${config.chainId})`,
  );
});
