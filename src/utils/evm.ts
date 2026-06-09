export function isHexAddress(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function normalizeAddress(value: string): `0x${string}` {
  if (!isHexAddress(value)) {
    throw new Error("Invalid EVM address");
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

export function formatTokenUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole.toString()}${
    fractionText ? `.${fractionText}` : ""
  }`;
}

export function parseTokenUnits(value: string, decimals: number): bigint {
  const [wholePart, fractionPart = ""] = value.split(".");
  const whole = BigInt(wholePart || "0") * 10n ** BigInt(decimals);
  const fractionText = fractionPart.slice(0, decimals).padEnd(decimals, "0");
  const fraction = fractionText ? BigInt(fractionText) : 0n;
  return whole + fraction;
}

export function encodeUint(value: bigint | number): string {
  const bigintValue = typeof value === "number" ? BigInt(value) : value;
  return bigintValue.toString(16).padStart(64, "0");
}

export function encodeAddress(address: `0x${string}`): string {
  return normalizeAddress(address).slice(2).padStart(64, "0");
}

export function encodeAddressArray(addresses: `0x${string}`[]): string {
  return `${encodeUint(addresses.length)}${addresses.map(encodeAddress).join("")}`;
}

export function decodeUint(hexWord: string): bigint {
  return BigInt(`0x${hexWord.replace(/^0x/, "")}`);
}

export function words(hex: string): string[] {
  const clean = hex.replace(/^0x/, "");
  const result: string[] = [];
  for (let i = 0; i < clean.length; i += 64) {
    result.push(clean.slice(i, i + 64));
  }
  return result;
}
