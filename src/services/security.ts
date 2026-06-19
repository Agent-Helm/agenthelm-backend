import { config } from "../config.js";

export type SecurityFinding = {
  source: "goplus" | "honeypot";
  severity: "info" | "warning" | "block";
  message: string;
};

export type TokenSecurityResult = {
  findings: SecurityFinding[];
  sellTaxBips: number | null;
  buyTaxBips: number | null;
  honeypotChecked: boolean;
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

type HoneypotResponse = {
  honeypotResult?: {
    isHoneypot?: boolean;
  };
  simulationResult?: {
    buyTax?: number;
    sellTax?: number;
  };
  summary?: {
    risk?: string;
    flags?: Array<
      | string
      | {
          flag?: string;
          description?: string;
          severity?: string;
          severityIndex?: number;
        }
    >;
  };
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

function formatProviderStatus(source: SecurityFinding["source"], status: number): string {
  if (status === 401 || status === 403) {
    return `${source === "goplus" ? "GoPlus" : "honeypot.is"} auth/rate limit (${status})`;
  }
  return `${source === "goplus" ? "GoPlus" : "honeypot.is"} unavailable (${status})`;
}

export function honeypotFlagToFinding(
  flag: NonNullable<NonNullable<HoneypotResponse["summary"]>["flags"]>[number],
  summaryRisk: string | undefined,
): SecurityFinding {
  if (typeof flag === "string") {
    return {
      source: "honeypot",
      severity: summaryRisk === "high" ? "block" : "warning",
      message: flag,
    };
  }

  const label = flag.flag?.trim() || "Honeypot warning";
  const description = flag.description?.trim();
  const providerSeverity = flag.severity?.toLowerCase();
  const severity =
    summaryRisk === "high" || providerSeverity === "high" || providerSeverity === "critical"
      ? "block"
      : "warning";

  return {
    source: "honeypot",
    severity,
    message: description && description !== label ? `${label}: ${description}` : label,
  };
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
          message: formatProviderStatus("goplus", response.status),
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

async function fetchHoneypot(
  chainId: number,
  tokenAddress: `0x${string}`,
): Promise<Partial<TokenSecurityResult>> {
  const url = new URL("https://api.honeypot.is/v2/IsHoneypot");
  url.searchParams.set("address", tokenAddress);
  url.searchParams.set("chainID", String(chainId));

  const response = await fetch(url);
  if (!response.ok) {
    return {
      honeypotChecked: false,
      findings: [
        {
          source: "honeypot",
          severity: "warning",
          message: formatProviderStatus("honeypot", response.status),
        },
      ],
    };
  }

  const body = (await response.json()) as HoneypotResponse;
  const findings: SecurityFinding[] = [];
  if (body.honeypotResult?.isHoneypot) {
    findings.push({
      source: "honeypot",
      severity: "block",
      message: "honeypot.is flags token as honeypot",
    });
  }
  for (const flag of body.summary?.flags ?? []) {
    findings.push(honeypotFlagToFinding(flag, body.summary?.risk));
  }

  return {
    honeypotChecked: true,
    sellTaxBips: percentToBips(body.simulationResult?.sellTax),
    buyTaxBips: percentToBips(body.simulationResult?.buyTax),
    findings,
  };
}

export async function checkTokenSecurity(
  chainId: number,
  tokenAddress: `0x${string}`,
): Promise<TokenSecurityResult> {
  const [goplus, honeypot] = await Promise.all([
    fetchGoPlus(chainId, tokenAddress),
    fetchHoneypot(chainId, tokenAddress),
  ]);

  return {
    findings: [...(goplus.findings ?? []), ...(honeypot.findings ?? [])],
    sellTaxBips: honeypot.sellTaxBips ?? goplus.sellTaxBips ?? null,
    buyTaxBips: honeypot.buyTaxBips ?? goplus.buyTaxBips ?? null,
    honeypotChecked: honeypot.honeypotChecked ?? false,
    goplusChecked: goplus.goplusChecked ?? false,
  };
}
