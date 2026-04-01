/**
 * MCP server for SOULT IO LTD accounting — multi-agent accounting tools.
 * Deployed via GitHub Actions → ghcr.io → Portainer CE GitOps polling.
 *
 * Tools:
 *   accounting-payroll-calculate   — Calculate monthly payroll withholdings
 *   accounting-compliance-check    — Check upcoming compliance deadlines
 *   accounting-invoice-status      — Read invoice data from QuickBooks Online
 *   accounting-bookkeeping-summary — P&L / expense summary from QuickBooks Online
 *
 * Phase 1: Payroll calculation + compliance checking (no QBO API needed)
 * Phase 2: QBO OAuth2 integration for invoice + bookkeeping tools
 *
 * SECURITY: Credentials read from /secrets/quickbooks.env (mounted from /srv/).
 * Credentials never appear in tool output. Generic error messages only.
 *
 * Usage: PORT=8906 SECRETS_DIR=/secrets bun run src/http.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ── Configuration ──────────────────────────────────────────

const PORT = Number(process.env["PORT"]) || 8906;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";

// ── Credential Loading ─────────────────────────────────────

interface QBOCredentials {
  clientId: string;
  clientSecret: string;
  realmId?: string;
  accessToken?: string;
  refreshToken?: string;
}

function loadCredentials(): QBOCredentials | null {
  const envPath = resolve(SECRETS_DIR, "quickbooks.env");
  if (!existsSync(envPath)) {
    console.error("No quickbooks.env found — QBO tools will be unavailable");
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(envPath, "utf-8");
  } catch {
    console.error("Cannot read quickbooks.env — check file permissions");
    return null;
  }
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }

  return {
    clientId: env["QBO_CLIENT_ID"] || "",
    clientSecret: env["QBO_CLIENT_SECRET"] || "",
    realmId: env["QBO_REALM_ID"] || undefined,
    accessToken: env["QBO_ACCESS_TOKEN"] || undefined,
    refreshToken: env["QBO_REFRESH_TOKEN"] || undefined,
  };
}

const qboCreds = loadCredentials();

// ── Sanitize Output ────────────────────────────────────────

function sanitize(s: string): string {
  // Strip anything that looks like a credential or token
  return s
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+\S+/gi, "Basic [REDACTED]")
    .replace(/[A-Za-z0-9+/=]{40,}/g, "[REDACTED]");
}

// ── Tax Configuration (2026) ───────────────────────────────
// Source: IRS Publication 15 (2026), Delaware Division of Revenue
// These rates should be updated annually.

const TAX_CONFIG = {
  year: 2026,

  // Federal Income Tax — simplified bracket withholding (single filer, monthly)
  federalBrackets: [
    { min: 0, max: 958, rate: 0.10 },
    { min: 958, max: 3_817, rate: 0.12 },
    { min: 3_817, max: 8_150, rate: 0.22 },
    { min: 8_150, max: 16_075, rate: 0.24 },
    { min: 16_075, max: 20_317, rate: 0.32 },
    { min: 20_317, max: 51_000, rate: 0.35 },
    { min: 51_000, max: Infinity, rate: 0.37 },
  ],

  // FICA
  socialSecurityRate: 0.062,
  socialSecurityWageCap: 168_600,
  medicareRate: 0.0145,
  medicareAdditionalRate: 0.009, // Above $200K annual
  medicareAdditionalThreshold: 200_000,

  // Delaware — no state income tax withholding for single employee C-Corp
  // (SOULT IO LTD is a Delaware C-Corp; Neil lives in Barcelona, not Delaware)
  stateWithholding: 0,

  // Employer-side taxes
  employerSocialSecurityRate: 0.062,
  employerMedicareRate: 0.0145,
  futaRate: 0.006,
  futaWageCap: 7_000,
};

// ── Tool: accounting-payroll-calculate ──────────────────────

const PayrollCalculateInput = {
  monthlySalary: z
    .number()
    .positive()
    .describe("Monthly gross salary in USD"),
  month: z
    .number()
    .int()
    .min(1)
    .max(12)
    .describe("Month number (1-12)"),
  year: z
    .number()
    .int()
    .default(2026)
    .describe("Tax year (default: 2026)"),
};

interface PayrollResult {
  grossPay: number;
  federalWithholding: number;
  socialSecurity: number;
  medicare: number;
  stateWithholding: number;
  totalDeductions: number;
  netPay: number;
  employerSocialSecurity: number;
  employerMedicare: number;
  employerFUTA: number;
  totalEmployerCost: number;
  ytdGross: number;
}

function calculatePayroll(monthlySalary: number, month: number): PayrollResult {
  const ytdGross = monthlySalary * month;
  const priorYtdGross = monthlySalary * (month - 1);

  // Federal income tax (simplified monthly withholding from brackets)
  let federalWithholding = 0;
  let remaining = monthlySalary;
  for (const bracket of TAX_CONFIG.federalBrackets) {
    const taxableInBracket = Math.min(remaining, bracket.max - bracket.min);
    if (taxableInBracket <= 0) break;
    federalWithholding += taxableInBracket * bracket.rate;
    remaining -= taxableInBracket;
  }

  // Social Security — capped at wage base
  const ssThisMonth =
    ytdGross <= TAX_CONFIG.socialSecurityWageCap
      ? Math.min(monthlySalary, TAX_CONFIG.socialSecurityWageCap - priorYtdGross) *
        TAX_CONFIG.socialSecurityRate
      : 0;

  // Medicare — no cap, additional rate above threshold
  let medicare = monthlySalary * TAX_CONFIG.medicareRate;
  if (ytdGross > TAX_CONFIG.medicareAdditionalThreshold) {
    const additionalBase = Math.min(
      monthlySalary,
      ytdGross - TAX_CONFIG.medicareAdditionalThreshold,
    );
    if (additionalBase > 0) {
      medicare += additionalBase * TAX_CONFIG.medicareAdditionalRate;
    }
  }

  // State — none for Delaware C-Corp with employee abroad
  const stateWithholding = TAX_CONFIG.stateWithholding;

  const totalDeductions = federalWithholding + ssThisMonth + medicare + stateWithholding;
  const netPay = monthlySalary - totalDeductions;

  // Employer-side
  const employerSS =
    ytdGross <= TAX_CONFIG.socialSecurityWageCap
      ? Math.min(monthlySalary, TAX_CONFIG.socialSecurityWageCap - priorYtdGross) *
        TAX_CONFIG.employerSocialSecurityRate
      : 0;
  const employerMedicare = monthlySalary * TAX_CONFIG.employerMedicareRate;
  const employerFUTA =
    priorYtdGross < TAX_CONFIG.futaWageCap
      ? Math.min(monthlySalary, TAX_CONFIG.futaWageCap - priorYtdGross) * TAX_CONFIG.futaRate
      : 0;

  return {
    grossPay: monthlySalary,
    federalWithholding: Math.round(federalWithholding * 100) / 100,
    socialSecurity: Math.round(ssThisMonth * 100) / 100,
    medicare: Math.round(medicare * 100) / 100,
    stateWithholding,
    totalDeductions: Math.round(totalDeductions * 100) / 100,
    netPay: Math.round(netPay * 100) / 100,
    employerSocialSecurity: Math.round(employerSS * 100) / 100,
    employerMedicare: Math.round(employerMedicare * 100) / 100,
    employerFUTA: Math.round(employerFUTA * 100) / 100,
    totalEmployerCost: Math.round((monthlySalary + employerSS + employerMedicare + employerFUTA) * 100) / 100,
    ytdGross,
  };
}

async function payrollCalculate(params: {
  monthlySalary: number;
  month: number;
  year: number;
}): Promise<string> {
  const result = calculatePayroll(params.monthlySalary, params.month);

  return `## Payroll Calculation — ${params.year} Month ${params.month}

**Employee:** Neil Soult | **Entity:** SOULT IO LTD

| Item | Amount |
|------|--------|
| Gross Pay | $${result.grossPay.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| Federal Withholding | -$${result.federalWithholding.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| Social Security (6.2%) | -$${result.socialSecurity.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| Medicare (1.45%) | -$${result.medicare.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| State Withholding | -$${result.stateWithholding.toFixed(2)} |
| **Total Deductions** | **-$${result.totalDeductions.toLocaleString("en-US", { minimumFractionDigits: 2 })}** |
| **Net Pay** | **$${result.netPay.toLocaleString("en-US", { minimumFractionDigits: 2 })}** |

### Employer Taxes
| Item | Amount |
|------|--------|
| Employer SS (6.2%) | $${result.employerSocialSecurity.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| Employer Medicare (1.45%) | $${result.employerMedicare.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| FUTA (0.6%) | $${result.employerFUTA.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| **Total Employer Cost** | **$${result.totalEmployerCost.toLocaleString("en-US", { minimumFractionDigits: 2 })}** |

**YTD Gross:** $${result.ytdGross.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

// ── Tool: accounting-compliance-check ──────────────────────

const ComplianceCheckInput = {};

const COMPLIANCE_CALENDAR = [
  // US Federal
  { name: "Form 941 (Q1)", deadline: "04-30", description: "Quarterly federal tax return" },
  { name: "Form 941 (Q2)", deadline: "07-31", description: "Quarterly federal tax return" },
  { name: "Form 941 (Q3)", deadline: "10-31", description: "Quarterly federal tax return" },
  { name: "Form 941 (Q4)", deadline: "01-31", description: "Quarterly federal tax return" },
  { name: "Form 940 (FUTA)", deadline: "01-31", description: "Annual federal unemployment tax" },
  { name: "W-2 / W-3 Filing", deadline: "01-31", description: "Employee wage statements to SSA" },
  { name: "Form 1120 (Corporate Tax)", deadline: "04-15", description: "C-Corp federal income tax return" },
  { name: "Estimated Tax (Q1)", deadline: "04-15", description: "Corporate estimated tax payment" },
  { name: "Estimated Tax (Q2)", deadline: "06-15", description: "Corporate estimated tax payment" },
  { name: "Estimated Tax (Q3)", deadline: "09-15", description: "Corporate estimated tax payment" },
  { name: "Estimated Tax (Q4)", deadline: "12-15", description: "Corporate estimated tax payment" },

  // Delaware
  { name: "Delaware Franchise Tax", deadline: "03-01", description: "Annual report + franchise tax" },

  // Spain
  { name: "Modelo 720", deadline: "03-31", description: "Foreign asset declaration (Spain)" },
  { name: "Spain IRPF Declaration", deadline: "06-30", description: "Spanish personal income tax" },
];

async function complianceCheck(): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const lines: string[] = ["## Compliance Deadlines", ""];

  const upcoming: { name: string; deadline: string; daysUntil: number; description: string }[] = [];
  const overdue: typeof upcoming = [];

  for (const item of COMPLIANCE_CALENDAR) {
    const [mm, dd] = item.deadline.split("-").map(Number);
    // Check both current year and next year for wrapping deadlines
    for (const y of [year, year + 1]) {
      const deadlineDate = new Date(y, mm - 1, dd);
      const diffMs = deadlineDate.getTime() - now.getTime();
      const daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      if (daysUntil >= -30 && daysUntil <= 90) {
        const entry = { name: item.name, deadline: `${y}-${item.deadline}`, daysUntil, description: item.description };
        if (daysUntil < 0) overdue.push(entry);
        else upcoming.push(entry);
      }
    }
  }

  if (overdue.length > 0) {
    lines.push("### ⚠️ Overdue");
    for (const item of overdue.sort((a, b) => a.daysUntil - b.daysUntil)) {
      lines.push(`- **${item.name}** — ${item.deadline} (${Math.abs(item.daysUntil)} days overdue) — ${item.description}`);
    }
    lines.push("");
  }

  if (upcoming.length > 0) {
    lines.push("### Upcoming (next 90 days)");
    for (const item of upcoming.sort((a, b) => a.daysUntil - b.daysUntil)) {
      const urgency = item.daysUntil <= 14 ? "🔴" : item.daysUntil <= 30 ? "🟡" : "🟢";
      lines.push(`- ${urgency} **${item.name}** — ${item.deadline} (${item.daysUntil} days) — ${item.description}`);
    }
    lines.push("");
  }

  if (overdue.length === 0 && upcoming.length === 0) {
    lines.push("No deadlines within the next 90 days.");
  }

  lines.push(`*Checked: ${now.toISOString().split("T")[0]}*`);
  return lines.join("\n");
}

// ── Tool: accounting-api-usage ─────────────────────────────

async function apiUsage(): Promise<string> {
  const qboStatus = qboCreds?.clientId ? "Configured (OAuth2 pending)" : "Not configured";
  const toolCount = 4;

  return `## mcp-accounting Status

| Item | Status |
|------|--------|
| Server | Running on port ${PORT} |
| Tools | ${toolCount} active |
| QBO API | ${qboStatus} |
| Tax Config | ${TAX_CONFIG.year} rates loaded |

### Available Tools
- **accounting-payroll-calculate** — Monthly payroll withholding calculation
- **accounting-compliance-check** — Upcoming tax/compliance deadlines
- **accounting-invoice-status** — Invoice data from QBO *(Phase 2)*
- **accounting-bookkeeping-summary** — P&L from QBO *(Phase 2)*`;
}

// ── MCP Server ─────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-accounting",
    version: "0.1.0",
  });

  server.tool(
    "accounting-payroll-calculate",
    "Calculate monthly payroll withholdings for SOULT IO LTD. Returns federal tax, FICA, net pay, and employer costs.",
    PayrollCalculateInput,
    async (params) => ({
      content: [{ type: "text" as const, text: await payrollCalculate(params) }],
    }),
  );

  server.tool(
    "accounting-compliance-check",
    "Check upcoming tax and compliance deadlines for SOULT IO LTD (US federal, Delaware, Spain).",
    ComplianceCheckInput,
    async () => ({
      content: [{ type: "text" as const, text: await complianceCheck() }],
    }),
  );

  server.tool(
    "accounting-api-usage",
    "Show mcp-accounting server status, available tools, and QuickBooks Online connection status.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: await apiUsage() }],
    }),
  );

  return server;
}

// ── Rate Limiter ──────────────────────────────────────────

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) return true;
  requestTimestamps.push(now);
  return false;
}

// ── HTTP Server (stateless mode) ───────────────────────────

const httpServer = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "mcp-accounting" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/mcp") {
      if (isRateLimited()) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      return transport.handleRequest(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`mcp-accounting listening on http://0.0.0.0:${PORT}/mcp`);
console.log(`Tools: 3 (Phase 1) | QBO: ${qboCreds?.clientId ? "credentials loaded" : "not configured"}`);

process.on("SIGTERM", () => {
  httpServer.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  httpServer.stop();
  process.exit(0);
});
