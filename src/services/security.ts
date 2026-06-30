import { config } from "../config.js";

export type SecurityFinding = {
  source: "goplus";
  severity: "info" | "warning" | "block";
  message: string;
};

export type TokenSecurityResult = {
  findings: SecurityFinding[];
  sellTaxBips: number | null;
  buyTaxBips: number | null;
  goplusChecked: boolean;
};

type GoPlusResponse = {
  code?: number;
  message?: string;
  result?: Record<
    string,
    {
      is_honeypot?: string;
      sell_tax?: string;
      buy_tax?: string;
      cannot_sell_all?: string;
      is_blacklisted?: string;
      is_in_dex?: string;
      trading_cooldown?: string;
      transfer_pausable?: string;
    }
  >;
};

export function percentToBips(value: string | number | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function isOne(value: string | undefined): boolean {
  return value === "1";
}

function formatProviderStatus(status: number): string {
  if (status === 401 || status === 403) {
    return `GoPlus auth/rate limit (${status})`;
  }
  return `GoPlus unavailable (${status})`;
}

async function fetchGoPlus(
  chainId: number,
  tokenAddress: `0x${string}`,
): Promise<Partial<TokenSecurityResult>> {
  const url = new URL(`https://api.gopluslabs.io/api/v1/token_security/${chainId}`);
  url.searchParams.set("contract_addresses", tokenAddress);
  const headers: Record<string, string> = {};
  if (config.goplusAppKey) {
    headers["x-api-key"] = config.goplusAppKey.replace(/^Bearer\s+/i, "");
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    return {
      goplusChecked: false,
      findings: [
        {
          source: "goplus",
          severity: "warning",
          message: formatProviderStatus(response.status),
        },
      ],
    };
  }

  const body = (await response.json()) as GoPlusResponse;
  if (body.code !== undefined && body.code !== 1) {
    return {
      goplusChecked: false,
      findings: [
        {
          source: "goplus",
          severity: "warning",
          message: `GoPlus unavailable (${body.message ?? `code ${body.code}`})`,
        },
      ],
    };
  }
  const token = body.result?.[tokenAddress.toLowerCase()];
  if (!token) return { goplusChecked: false, findings: [] };

  const findings: SecurityFinding[] = [];
  if (isOne(token.is_honeypot)) {
    findings.push({
      source: "goplus",
      severity: "block",
      message: "GoPlus flags token as honeypot",
    });
  }
  if (isOne(token.cannot_sell_all)) {
    findings.push({
      source: "goplus",
      severity: "block",
      message: "Cannot sell full balance",
    });
  }
  if (isOne(token.is_blacklisted)) {
    findings.push({
      source: "goplus",
      severity: "block",
      message: "Blacklist behavior detected",
    });
  }
  if (isOne(token.transfer_pausable)) {
    findings.push({
      source: "goplus",
      severity: "warning",
      message: "Transfers may be pausable",
    });
  }
  if (isOne(token.trading_cooldown)) {
    findings.push({
      source: "goplus",
      severity: "warning",
      message: "Trading cooldown detected",
    });
  }

  return {
    goplusChecked: true,
    sellTaxBips: percentToBips(token.sell_tax),
    buyTaxBips: percentToBips(token.buy_tax),
    findings,
  };
}

export async function checkTokenSecurity(
  chainId: number,
  tokenAddress: `0x${string}`,
): Promise<TokenSecurityResult> {
  const goplus = await fetchGoPlus(chainId, tokenAddress);

  return {
    findings: goplus.findings ?? [],
    sellTaxBips: goplus.sellTaxBips ?? null,
    buyTaxBips: goplus.buyTaxBips ?? null,
    goplusChecked: goplus.goplusChecked ?? false,
  };
}
