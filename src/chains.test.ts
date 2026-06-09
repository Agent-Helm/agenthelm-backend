import assert from "node:assert/strict";
import test from "node:test";
import { getChainConfig, getDustExecutorSetup } from "./chains.js";

test("Base chain config includes DustExecutor constructor and allow-list addresses", () => {
  const chain = getChainConfig(8453);
  const setup = getDustExecutorSetup(chain);

  assert.deepEqual(setup.constructorArgs, {
    weth: "0x4200000000000000000000000000000000000006",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  });
  assert.deepEqual(setup.allowlistedRouters, [
    "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
    "0x2626664c2603336E57B271c5C0b26F421741e481",
    "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  ]);
});
