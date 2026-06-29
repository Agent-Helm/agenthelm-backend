import assert from "node:assert/strict";
import test from "node:test";
import sha3 from "js-sha3";
import { decodeSimulationCall } from "./simulation.js";

const topic0 = (sig: string) => `0x${sha3.keccak_256(sig)}`;
const SWAP_SKIPPED = topic0("SwapSkipped(address,address,uint8,string)");
const DUST_CONVERTED = topic0("DustConverted(address,address,uint8,uint256,uint256)");
const TRANSFER = topic0("Transfer(address,address,uint256)");
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (n: number | bigint) => pad(BigInt(n).toString(16));
const USER = "0x4f330c68ddcfef0ed08450bdc5122b623f314297";
const TOKEN_A = "0xeD664536023d8E4b1640C394777D34aBAFF1dF8F";
const TOKEN_B = "0x5F09821CBb61e09D2a83124Ae0B56aaa3ae85B07";

function abiString(s: string): string {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return word(32) + word(s.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
}

test("decodeSimulationCall reports converted tokens, skips, and user ETH", () => {
  const result = decodeSimulationCall(
    {
      status: "0x1",
      gasUsed: "0x5208",
      logs: [
        // TOKEN_A converted, ethOut 1e15
        {
          address: "0xexec",
          topics: [DUST_CONVERTED, `0x${pad(USER)}`, `0x${pad(TOKEN_A)}`, `0x${word(1)}`],
          data: `0x${word(BigInt(1e18))}${word(BigInt(1e15))}`,
        },
        // TOKEN_B skipped "swap failed"
        {
          address: "0xexec",
          topics: [SWAP_SKIPPED, `0x${pad(USER)}`, `0x${pad(TOKEN_B)}`, `0x${word(1)}`],
          data: `0x${abiString("swap failed")}`,
        },
        // native ETH credited to the user (settlement payout)
        {
          address: NATIVE,
          topics: [TRANSFER, `0x${pad("0xexec")}`, `0x${pad(USER)}`],
          data: `0x${word(BigInt(9e14))}`,
        },
      ],
    },
    USER,
  );

  assert.equal(result.status, "success");
  assert.equal(result.converted.length, 1);
  assert.equal(result.converted[0].token, TOKEN_A.toLowerCase());
  assert.equal(result.converted[0].ethOut, String(BigInt(1e15)));
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].token, TOKEN_B.toLowerCase());
  assert.equal(result.skipped[0].reason, "swap failed");
  assert.equal(result.userEthWei, String(BigInt(9e14)));
});

test("decodeSimulationCall surfaces a revert reason", () => {
  const result = decodeSimulationCall(
    {
      status: "0x0",
      // Error("Deadline expired")
      returnData: `0x08c379a0${abiString("Deadline expired")}`,
    },
    USER,
  );
  assert.equal(result.status, "reverted");
  assert.equal(result.revertReason, "Deadline expired");
  assert.equal(result.converted.length, 0);
});

test("decodeSimulationCall ignores native transfers not credited to the caller", () => {
  const result = decodeSimulationCall(
    {
      status: "0x1",
      logs: [
        {
          address: NATIVE,
          topics: [TRANSFER, `0x${pad("0xexec")}`, `0x${pad(TOKEN_A)}`],
          data: `0x${word(BigInt(5e14))}`,
        },
      ],
    },
    USER,
  );
  assert.equal(result.userEthWei, "0");
});
