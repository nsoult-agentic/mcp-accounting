/**
 * MCP server for SOULT IO LTD accounting — multi-agent accounting tools.
 * Deployed via GitHub Actions → ghcr.io → Portainer CE GitOps polling.
 *
 * Tools (Phase 1):
 *   accounting-payroll-calculate   — Calculate monthly payroll withholdings
 *   accounting-compliance-check    — Check upcoming compliance deadlines
 *   accounting-api-usage           — Server status and tool list
 *
 * Tools (Phase 2A — PDF + Time Tracking):
 *   accounting-invoice-generate    — Generate invoice PDF, upload to NextCloud
 *   accounting-payroll-paystub     — Generate pay stub PDF, upload to NextCloud
 *   accounting-time-off-log        — Record a day off (sick/vacation/holiday)
 *   accounting-time-off-list       — List time off for a month
 *
 * SECURITY: Credentials read from /secrets/quickbooks.env (mounted from /srv/).
 * SSN/EIN regex sanitizer on all responses (defense-in-depth).
 * Generic error messages only — no PII in error output.
 *
 * Usage: PORT=8906 SECRETS_DIR=/secrets bun run src/http.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { createRenderer } from "./pdf/index.js";
import type { InvoiceData, PaystubData } from "./pdf/types.js";
import {
  calculateWorkCalendar,
  formatInvoiceDescription,
  monthName,
  type DayOff,
} from "./calendar.js";
import {
  nextcloudUpload,
  nextcloudDownload,
  nextcloudList,
  brainStore,
  brainSearch,
} from "./mcp-client.js";
import {
  generateAuthUrl,
  validateState,
  isAuthWindowOpen,
  exchangeCode,
  readTokens,
  isAccessTokenExpired,
  isRefreshTokenExpired,
} from "./qbo-auth.js";
import {
  companyInfo as qboCompanyInfo,
  profitAndLoss as qboProfitAndLoss,
  listInvoices as qboListInvoices,
} from "./qbo-client.js";

// ── Configuration ──────────────────────────────────────────

const PORT = Number(process.env["PORT"]) || 8906;
const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";

// Company info — used in invoices and pay stubs
const COMPANY: {
  name: string;
  address: string[];
  email: string;
  phone: string;
  website: string;
} = {
  name: "Soult IO LTD",
  address: ["8 The Grn Ste B", "Dover, DE 19901"],
  email: "neil@soult.io",
  phone: "+1 (310) 571-5236",
  website: "www.soult.io",
};

const HOURLY_RATE = 100;
const HOURS_PER_DAY = 8;
const INVOICE_TERMS = "Net 15";
const LOGO_PATH = "/Shared/Corporate/logo-black.png";

// ── Credential Loading ─────────────────────────────────────

interface QBOCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
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
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
  }

  return {
    clientId: env["QBO_CLIENT_ID"] || "",
    clientSecret: env["QBO_CLIENT_SECRET"] || "",
    redirectUri: env["QBO_REDIRECT_URI"] || undefined,
    realmId: env["QBO_REALM_ID"] || undefined,
    accessToken: env["QBO_ACCESS_TOKEN"] || undefined,
    refreshToken: env["QBO_REFRESH_TOKEN"] || undefined,
  };
}

// Lazy-load QBO credentials only when a QBO tool is first called (Phase 2B)
let _qboCreds: QBOCredentials | null | undefined;
function getQBOCredentials(): QBOCredentials | null {
  if (_qboCreds === undefined) _qboCreds = loadCredentials();
  return _qboCreds;
}

// ── Sanitize Output ────────────────────────────────────────

function sanitize(s: string): string {
  return s
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+\S+/gi, "Basic [REDACTED]")
    .replace(/\b(sk-|pk_|rk_|whsec_|xox[bpas]-)[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/["']?access_token["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{20,}["']?/gi, "access_token=[REDACTED]")
    .replace(/["']?refresh_token["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{20,}["']?/gi, "refresh_token=[REDACTED]")
    .replace(/http:\/\/host\.docker\.internal[^\s]*/g, "[internal]")
    // PII sanitizer: catch any SSN (XXX-XX-XXXX) or EIN (XX-XXXXXXX) patterns
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN-REDACTED]")
    .replace(/\b\d{2}-\d{7}\b/g, "[EIN-REDACTED]");
}

// ── Tax Configuration (2026) ───────────────────────────────
// Source: IRS Rev. Proc. 2025-32, SSA COLA announcement Oct 2025

const TAX_CONFIG = {
  year: 2026,
  standardDeduction: 16_100,
  federalBrackets: [
    { min: 0, max: 12_400, rate: 0.10 },
    { min: 12_400, max: 50_400, rate: 0.12 },
    { min: 50_400, max: 105_700, rate: 0.22 },
    { min: 105_700, max: 201_775, rate: 0.24 },
    { min: 201_775, max: 256_225, rate: 0.32 },
    { min: 256_225, max: 640_600, rate: 0.35 },
    { min: 640_600, max: Infinity, rate: 0.37 },
  ],
  socialSecurityRate: 0.062,
  socialSecurityWageCap: 184_500,
  medicareRate: 0.0145,
  medicareAdditionalRate: 0.009,
  medicareAdditionalThreshold: 200_000,
  stateWithholding: 0,
  employerSocialSecurityRate: 0.062,
  employerMedicareRate: 0.0145,
  futaRate: 0.006,
  futaWageCap: 7_000,
};

// ── Payroll Calculation ────────────────────────────────────

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

  const annualGross = monthlySalary * 12;
  const annualTaxable = Math.max(0, annualGross - TAX_CONFIG.standardDeduction);
  let annualFederalTax = 0;
  let remaining = annualTaxable;
  for (const bracket of TAX_CONFIG.federalBrackets) {
    const taxableInBracket = Math.min(remaining, bracket.max - bracket.min);
    if (taxableInBracket <= 0) break;
    annualFederalTax += taxableInBracket * bracket.rate;
    remaining -= taxableInBracket;
  }
  const federalWithholding = annualFederalTax / 12;

  const ssThisMonth =
    priorYtdGross < TAX_CONFIG.socialSecurityWageCap
      ? Math.min(monthlySalary, TAX_CONFIG.socialSecurityWageCap - priorYtdGross) *
        TAX_CONFIG.socialSecurityRate
      : 0;

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

  const stateWithholding = TAX_CONFIG.stateWithholding;
  const totalDeductions = federalWithholding + ssThisMonth + medicare + stateWithholding;
  const netPay = monthlySalary - totalDeductions;

  const employerSS =
    priorYtdGross < TAX_CONFIG.socialSecurityWageCap
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

// ── Tool Handlers ──────────────────────────────────────────

async function payrollCalculate(params: {
  monthlySalary: number;
  month: number;
  year: number;
}): Promise<string> {
  if (params.year < 2020 || params.year > 2030) {
    return `Error: Year must be between 2020 and 2030.`;
  }
  const r = calculatePayroll(params.monthlySalary, params.month);

  return `## Payroll Calculation — ${params.year} Month ${params.month}

**Employee:** Neilson Soult | **Entity:** SOULT IO LTD

| Item | Amount |
|------|--------|
| Gross Pay | $${r.grossPay.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| Federal Withholding | -$${r.federalWithholding.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| Social Security (6.2%) | -$${r.socialSecurity.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| Medicare (1.45%) | -$${r.medicare.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| State Withholding | -$${r.stateWithholding.toFixed(2)} |
| **Total Deductions** | **-$${r.totalDeductions.toLocaleString("en-US", { minimumFractionDigits: 2 })}** |
| **Net Pay** | **$${r.netPay.toLocaleString("en-US", { minimumFractionDigits: 2 })}** |

### Employer Taxes
| Item | Amount |
|------|--------|
| Employer SS (6.2%) | $${r.employerSocialSecurity.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| Employer Medicare (1.45%) | $${r.employerMedicare.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| FUTA (0.6%) | $${r.employerFUTA.toLocaleString("en-US", { minimumFractionDigits: 2 })} |
| **Total Employer Cost** | **$${r.totalEmployerCost.toLocaleString("en-US", { minimumFractionDigits: 2 })}** |

**YTD Gross:** $${r.ytdGross.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

// ── Compliance Calendar ────────────────────────────────────

const COMPLIANCE_CALENDAR = [
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
  { name: "Delaware Franchise Tax", deadline: "03-01", description: "Annual report + franchise tax" },
  { name: "Delaware Registered Agent", deadline: "06-01", description: "Annual registered agent renewal (check exact date)" },
  { name: "FinCEN BOI Report", deadline: "01-01", description: "Beneficial Ownership Information annual update (if applicable)" },
  { name: "Form 1099-NEC", deadline: "01-31", description: "Contractor payments >$600 (if any contractors paid)" },
  { name: "Modelo 720", deadline: "03-31", description: "Foreign asset declaration (Spain)" },
  { name: "Spain IRPF Declaration", deadline: "06-30", description: "Spanish personal income tax" },
];

async function complianceCheck(): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const lines: string[] = ["## Compliance Deadlines", ""];

  // Query Second Brain for filed items to filter out completed deadlines
  const filedItems = new Set<string>();
  try {
    const results = await brainSearch("filed tax form modelo", {
      category: "decision",
      status: "done",
      limit: 30,
    });
    // Extract filed form names from results (match known deadline names)
    const resultLower = results.toLowerCase();
    for (const item of COMPLIANCE_CALENDAR) {
      // Check if the item name (or key parts) appears in a "done" decision entry
      const nameLower = item.name.toLowerCase();
      // Extract the core form identifier (e.g., "1120" from "Form 1120 (Corporate Tax)")
      const coreMatch = item.name.match(/(?:Form\s+)?(\d{3,4}(?:-\w+)?)|Modelo\s+(\d+)|W-2|W-3|Delaware|FinCEN|IRPF/i);
      const coreId = coreMatch ? (coreMatch[1] || coreMatch[2] || coreMatch[0]).toLowerCase() : nameLower;
      if (resultLower.includes(coreId) && resultLower.includes("filed")) {
        filedItems.add(item.name);
      }
    }
  } catch {
    // Second Brain unavailable — proceed without filtering
  }

  const upcoming: { name: string; deadline: string; daysUntil: number; description: string }[] = [];
  const overdue: typeof upcoming = [];
  const completed: typeof upcoming = [];

  for (const item of COMPLIANCE_CALENDAR) {
    const [mm, dd] = item.deadline.split("-").map(Number);
    for (const y of [year, year + 1]) {
      const deadlineDate = new Date(y, mm - 1, dd);
      const diffMs = deadlineDate.getTime() - now.getTime();
      const daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      if (daysUntil >= -30 && daysUntil <= 90) {
        const entry = { name: item.name, deadline: `${y}-${item.deadline}`, daysUntil, description: item.description };
        if (filedItems.has(item.name)) {
          completed.push(entry);
        } else if (daysUntil < 0) {
          overdue.push(entry);
        } else {
          upcoming.push(entry);
        }
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

  if (completed.length > 0) {
    lines.push("### ✅ Filed");
    for (const item of completed.sort((a, b) => a.daysUntil - b.daysUntil)) {
      lines.push(`- ~~${item.name}~~ — ${item.deadline} — ${item.description}`);
    }
    lines.push("");
  }

  if (overdue.length === 0 && upcoming.length === 0 && completed.length === 0) {
    lines.push("No deadlines within the next 90 days.");
  }

  lines.push(`*Checked: ${now.toISOString().split("T")[0]}*`);
  return lines.join("\n");
}

// ── Time Off ───────────────────────────────────────────────

const TIMEOFF_PREFIX = "TIMEOFF";

async function timeOffLog(params: {
  date: string;
  type: string;
  note: string;
}): Promise<string> {
  // RT-008: Validate the date is a weekday
  const [y, m, d] = params.date.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d);
  const dow = dateObj.getDay();
  if (dow === 0 || dow === 6) {
    return `Error: ${params.date} is a ${dow === 0 ? "Sunday" : "Saturday"}. Time off can only be logged for weekdays.`;
  }

  // RT-006: Sanitize note — strip newlines, limit length
  const cleanNote = (params.note || "").replace(/[\n\r]/g, " ").slice(0, 200).trim();

  const title = `${TIMEOFF_PREFIX}:${params.date}:${params.type}`;
  const text = `Time off record. Date: ${params.date}. Type: ${params.type}. Note: ${cleanNote || "none"}.`;

  try {
    await brainStore(title, text, "task", "active");
    return `## Time Off Logged\n\n- **Date:** ${params.date}\n- **Type:** ${params.type}\n- **Note:** ${cleanNote || "—"}\n\nStored in Second Brain.`;
  } catch (err) {
    return `Error storing time off: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

async function timeOffList(params: {
  month: number;
  year: number;
}): Promise<{ markdown: string; daysOff: DayOff[]; brainUnavailable: boolean }> {
  const monthStr = String(params.month).padStart(2, "0");
  const query = `${TIMEOFF_PREFIX} ${params.year}-${monthStr}`;

  let daysOff: DayOff[] = [];
  let brainUnavailable = false;
  try {
    const results = await brainSearch(query, {
      mode: "fulltext",
      category: "task",
      status: "active",
      limit: 31,
    });

    // Parse results — each line starting with # is an entry
    // Format from brain-search: "[N] #ID — TIMEOFF:YYYY-MM-DD:type"
    const lines = results.split("\n");
    for (const line of lines) {
      const match = line.match(/TIMEOFF:(\d{4}-\d{2}-\d{2}):(\w+)/);
      if (match) {
        const [, date, type] = match;
        // Only include entries matching the requested month
        if (date.startsWith(`${params.year}-${monthStr}`)) {
          // Extract note from the content line if available
          const noteMatch = line.match(/Note:\s*([^.]+)/);
          daysOff.push({ date, type, note: noteMatch?.[1]?.trim() });
        }
      }
    }
  } catch {
    brainUnavailable = true;
  }

  // Deduplicate by date
  const seen = new Set<string>();
  daysOff = daysOff.filter((d) => {
    if (seen.has(d.date)) return false;
    seen.add(d.date);
    return true;
  });

  daysOff.sort((a, b) => a.date.localeCompare(b.date));

  const mn = monthName(params.month);
  let markdown = `## Time Off — ${mn} ${params.year}\n\n`;
  if (brainUnavailable) {
    markdown += "⚠️ **Warning: Second Brain is unavailable.** Time-off data could not be retrieved. Invoice generation will assume zero days off — verify before sending.\n\n";
  }
  if (daysOff.length === 0 && !brainUnavailable) {
    markdown += "No time off recorded for this month.";
  } else if (daysOff.length === 0) {
    markdown += "No time off data available (see warning above).";
  } else {
    markdown += "| Date | Type | Note |\n|------|------|------|\n";
    for (const d of daysOff) {
      markdown += `| ${d.date} | ${d.type} | ${d.note || "—"} |\n`;
    }
    markdown += `\n**Total days off:** ${daysOff.length}`;
  }

  return { markdown, daysOff, brainUnavailable };
}

// ── Invoice Generation ─────────────────────────────────────

async function fetchLogo(): Promise<Buffer | undefined> {
  try {
    const result = await nextcloudDownload(LOGO_PATH);
    // The download tool returns binary as base64 in a resource content block
    for (const c of result.content) {
      if (c.data) {
        return Buffer.from(c.data, "base64");
      }
      if (c.type === "resource" && (c as any).resource?.blob) {
        return Buffer.from((c as any).resource.blob, "base64");
      }
    }
    // If we got text back, it might be a file path reference — logo not available as inline
    return undefined;
  } catch {
    console.error("Could not fetch logo from NextCloud — generating invoice without logo");
    return undefined;
  }
}

function addDays(dateStr: string, days: number): string {
  // Parse MM/DD/YYYY
  const [mm, dd, yyyy] = dateStr.split("/").map(Number);
  const d = new Date(yyyy, mm - 1, dd + days);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

async function detectNextInvoiceNumber(year: number): Promise<number> {
  try {
    const listing = await nextcloudList(`/Shared/Accounting/Invoices/${year}`);
    // Parse invoice numbers from filenames: "Invoice NNNN - ..."
    const numbers: number[] = [];
    const regex = /Invoice\s+(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(listing)) !== null) {
      numbers.push(parseInt(m[1], 10));
    }
    if (numbers.length > 0) {
      return Math.max(...numbers) + 1;
    }
  } catch {
    // NextCloud unavailable or directory doesn't exist
  }
  // Check previous year too
  try {
    const listing = await nextcloudList(`/Shared/Accounting/Invoices/${year - 1}`);
    const numbers: number[] = [];
    const regex = /Invoice\s+(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(listing)) !== null) {
      numbers.push(parseInt(m[1], 10));
    }
    if (numbers.length > 0) {
      return Math.max(...numbers) + 1;
    }
  } catch {
    // fallback
  }
  return 1001; // safe default
}

async function invoiceGenerate(params: {
  month: number;
  year: number;
  invoiceNumber?: number;
  client: string;
  dryRun: boolean;
}): Promise<string> {
  // 1. Get time off for the month
  const { daysOff, brainUnavailable } = await timeOffList({ month: params.month, year: params.year });

  // 2. Calculate work calendar
  const calendar = calculateWorkCalendar(params.year, params.month, daysOff, HOURS_PER_DAY);

  if (calendar.workDays === 0) {
    return `Error: No work days calculated for ${monthName(params.month)} ${params.year}. Check time-off records.`;
  }

  // 3. Determine invoice number
  const invoiceNumber = params.invoiceNumber ?? await detectNextInvoiceNumber(params.year);

  // 4. Build dates
  const mn = monthName(params.month);
  const invoiceDate = `${String(params.month + 1 > 12 ? 1 : params.month + 1).padStart(2, "0")}/01/${params.month === 12 ? params.year + 1 : params.year}`;
  const dueDate = addDays(invoiceDate, 15);

  // 5. Build description with week ranges
  const description = formatInvoiceDescription(mn, calendar.weekRanges);

  // 6. Fetch logo
  const logo = await fetchLogo();

  // 7. Build invoice data
  const invoiceData: InvoiceData = {
    invoiceNumber,
    invoiceDate,
    dueDate,
    terms: INVOICE_TERMS,
    from: COMPANY,
    billTo: params.client,
    shipTo: params.client,
    lineItems: [
      {
        service: "Services",
        description,
        quantity: calendar.totalHours,
        rate: HOURLY_RATE,
      },
    ],
    logo,
  };

  // 8. Render PDF
  const renderer = createRenderer();
  const pdfBuffer = await renderer.renderInvoice(invoiceData);

  // 9. Summary
  const total = calendar.totalHours * HOURLY_RATE;
  const summary = [
    `## Invoice Generated`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Invoice # | ${invoiceNumber} |`,
    `| Client | ${params.client} |`,
    `| Period | ${mn} ${params.year} |`,
    `| Work Days | ${calendar.workDays} / ${calendar.businessDaysInMonth} business days |`,
    `| Days Off | ${daysOff.length} |`,
    `| Hours | ${calendar.totalHours} |`,
    `| Rate | $${HOURLY_RATE}/hr |`,
    `| **Total** | **$${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}** |`,
    `| Invoice Date | ${invoiceDate} |`,
    `| Due Date | ${dueDate} |`,
    ``,
    `### Week Ranges`,
    ...calendar.weekRanges.map((r) => `- ${r}`),
  ];

  if (brainUnavailable) {
    summary.push(``, `⚠️ **Warning:** Second Brain was unavailable — time-off data could not be verified. This invoice assumes zero days off. **Do not send without verifying.**`);
  }

  if (daysOff.length > 0) {
    summary.push(``, `### Days Off`);
    for (const d of daysOff) {
      summary.push(`- ${d.date} (${d.type})${d.note ? ` — ${d.note}` : ""}`);
    }
  }

  // 10. Upload to NextCloud (unless dry run)
  if (!params.dryRun) {
    const fileName = `Invoice ${invoiceNumber} - SOULT IO LTD ${invoiceDate.split("/")[2]}-${invoiceDate.split("/")[0]}-${invoiceDate.split("/")[1]}.pdf`;
    const uploadPath = `/Shared/Accounting/Invoices/${params.year}/${fileName}`;
    try {
      await nextcloudUpload(uploadPath, pdfBuffer.toString("base64"), "base64");
      summary.push(``, `**Uploaded to:** ${uploadPath}`);
    } catch (err) {
      summary.push(``, `**Upload failed:** ${err instanceof Error ? err.message : "unknown error"}`);
      summary.push(`PDF generated (${(pdfBuffer.length / 1024).toFixed(1)} KB) but could not be uploaded.`);
    }
  } else {
    summary.push(``, `*Dry run — PDF generated (${(pdfBuffer.length / 1024).toFixed(1)} KB) but not uploaded.*`);
  }

  return summary.join("\n");
}

// ── Pay Stub Generation ────────────────────────────────────

async function paystubGenerate(params: {
  month: number;
  year: number;
  monthlySalary: number;
  dryRun: boolean;
  federalWithholding?: number;
  socialSecurity?: number;
  medicare?: number;
  adjustments?: { label: string; amount: number }[];
}): Promise<string> {
  if (params.year < 2020 || params.year > 2030) {
    return `Error: Year must be between 2020 and 2030.`;
  }

  // 1. Calculate payroll or use overrides
  const payroll = calculatePayroll(params.monthlySalary, params.month);
  const mn = monthName(params.month);

  // If explicit deduction amounts are provided, use them (for recreating historical stubs)
  const fedTax = params.federalWithholding ?? payroll.federalWithholding;
  const ssTax = params.socialSecurity ?? payroll.socialSecurity;
  const medTax = params.medicare ?? payroll.medicare;
  const totalDeductions = fedTax + ssTax + medTax;
  const totalAdjustments = (params.adjustments || []).reduce((s, a) => s + a.amount, 0);
  const netPay = params.monthlySalary - totalDeductions - totalAdjustments;

  // 2. Build paystub data
  const paystubData: PaystubData = {
    employee: "Neilson Soult",
    entity: COMPANY.name,
    period: `${mn} ${params.year}`,
    payDate: `${String(params.month).padStart(2, "0")}/15/${params.year}`,
    gross: params.monthlySalary,
    deductions: [
      { label: "Federal Income Tax", amount: fedTax },
      { label: "Social Security (6.2%)", amount: ssTax },
      { label: "Medicare (1.45%)", amount: medTax },
    ],
    adjustments: params.adjustments && params.adjustments.length > 0 ? params.adjustments : undefined,
    netPay,
    ytdGross: params.monthlySalary * params.month,
    employerCosts: [
      { label: "Employer Social Security (6.2%)", amount: payroll.employerSocialSecurity },
      { label: "Employer Medicare (1.45%)", amount: payroll.employerMedicare },
      { label: "FUTA (0.6%)", amount: payroll.employerFUTA },
    ],
  };

  // Filter out zero-value deductions
  paystubData.deductions = paystubData.deductions.filter((d) => d.amount > 0);
  paystubData.employerCosts = paystubData.employerCosts.filter((d) => d.amount > 0);

  // 3. Render PDF
  const renderer = createRenderer();
  const pdfBuffer = await renderer.renderPaystub(paystubData);

  // 4. Summary
  const summary = [
    `## Pay Stub Generated — ${mn} ${params.year}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Employee | Neilson Soult |`,
    `| Gross Pay | $${params.monthlySalary.toLocaleString("en-US", { minimumFractionDigits: 2 })} |`,
    `| Total Deductions | -$${totalDeductions.toLocaleString("en-US", { minimumFractionDigits: 2 })} |`,
    ...(totalAdjustments > 0 ? [`| Adjustments | -$${totalAdjustments.toLocaleString("en-US", { minimumFractionDigits: 2 })} |`] : []),
    `| **Net Pay** | **$${netPay.toLocaleString("en-US", { minimumFractionDigits: 2 })}** |`,
    `| YTD Gross | $${(params.monthlySalary * params.month).toLocaleString("en-US", { minimumFractionDigits: 2 })} |`,
  ];

  // 5. Upload
  if (!params.dryRun) {
    const monthPadded = String(params.month).padStart(2, "0");
    const fileName = `paystub-${params.year}-${monthPadded}.pdf`;
    const uploadPath = `/Shared/Payroll/${params.year}/${fileName}`;
    try {
      await nextcloudUpload(uploadPath, pdfBuffer.toString("base64"), "base64");
      summary.push(``, `**Uploaded to:** ${uploadPath}`);
    } catch (err) {
      summary.push(``, `**Upload failed:** ${err instanceof Error ? err.message : "unknown error"}`);
    }
  } else {
    summary.push(``, `*Dry run — PDF generated (${(pdfBuffer.length / 1024).toFixed(1)} KB) but not uploaded.*`);
  }

  return summary.join("\n");
}

// ── API Usage ──────────────────────────────────────────────

async function apiUsage(): Promise<string> {
  const qboStatus = getQBOStatus();

  return `## mcp-accounting Status

| Item | Status |
|------|--------|
| Server | Running on port ${PORT} |
| Tools | 11 active |
| QBO API | ${qboStatus} |
| Tax Config | ${TAX_CONFIG.year} rates loaded |
| PDF Renderer | pdfmake |

### Available Tools
**Phase 1 — Payroll & Compliance:**
- **accounting-payroll-calculate** — Monthly payroll withholding calculation
- **accounting-compliance-check** — Upcoming tax/compliance deadlines
- **accounting-api-usage** — This status page

**Phase 2A — PDF & Time Tracking:**
- **accounting-payroll-paystub** — Generate pay stub PDF + upload to NextCloud
- **accounting-invoice-generate** — Generate invoice PDF + upload to NextCloud
- **accounting-time-off-log** — Record sick day, vacation, or holiday
- **accounting-time-off-list** — List time off for a month

**Phase 2B — QuickBooks Online:**
- **accounting-qbo-auth-url** — Generate OAuth2 authorization URL
- **accounting-qbo-status** — Check QBO connection status
- **accounting-invoice-status** — Read invoices from QBO
- **accounting-bookkeeping-summary** — Profit & Loss report from QBO`;
}

// ── OAuth Callback HTML ───────────────────────────────────

function callbackHtml(message: string, success: boolean): string {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>QBO Auth</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
.card{text-align:center;padding:2rem;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1);background:#fff;max-width:400px}
.icon{font-size:3rem;color:${color}}</style></head>
<body><div class="card"><div class="icon">${icon}</div><p>${message}</p></div></body></html>`;
}

// ── QBO Connection Status ─────────────────────────────────

function getQBOStatus(): string {
  const creds = getQBOCredentials();
  if (!creds?.clientId) return "Not configured (missing credentials)";

  const tokens = readTokens();
  if (!tokens) return "Configured — not yet authorized";

  if (isRefreshTokenExpired(tokens)) return "Refresh token expired — re-authorization required";
  if (isAccessTokenExpired(tokens)) return "Access token expired — will auto-refresh on next call";
  return "Connected";
}

// ── MCP Server ─────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-accounting",
    version: "0.3.0",
  });

  // ── Phase 1 Tools ──

  server.tool(
    "accounting-payroll-calculate",
    "Calculate monthly payroll withholdings for SOULT IO LTD. Returns federal tax, FICA, net pay, and employer costs.",
    {
      monthlySalary: z.number().positive().describe("Monthly gross salary in USD"),
      month: z.number().int().min(1).max(12).describe("Month number (1-12)"),
      year: z.number().int().min(2020).max(2030).default(2026).describe("Tax year (default: 2026)"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: sanitize(await payrollCalculate(params)) }],
    }),
  );

  server.tool(
    "accounting-compliance-check",
    "Check upcoming tax and compliance deadlines for SOULT IO LTD (US federal, Delaware, Spain).",
    {},
    async () => ({
      content: [{ type: "text" as const, text: sanitize(await complianceCheck()) }],
    }),
  );

  server.tool(
    "accounting-api-usage",
    "Show mcp-accounting server status, available tools, and connection status.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: sanitize(await apiUsage()) }],
    }),
  );

  // ── Phase 2A Tools ──

  server.tool(
    "accounting-time-off-log",
    "Record a day off (sick, vacation, holiday). Stores in Second Brain for invoice calculation.",
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date (YYYY-MM-DD)"),
      type: z.enum(["sick", "vacation", "holiday", "other"]).describe("Type of time off"),
      note: z.string().default("").describe("Optional note (e.g., 'Good Friday trip')"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: sanitize(await timeOffLog(params)) }],
    }),
  );

  server.tool(
    "accounting-time-off-list",
    "List recorded time off for a given month. Used by invoice generator to calculate work days.",
    {
      month: z.number().int().min(1).max(12).describe("Month (1-12)"),
      year: z.number().int().default(2026).describe("Year"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: sanitize((await timeOffList(params)).markdown) }],
    }),
  );

  server.tool(
    "accounting-invoice-generate",
    "Generate a Crexi invoice PDF for a given month. Calculates work days from calendar minus time off, renders PDF, uploads to NextCloud.",
    {
      month: z.number().int().min(1).max(12).describe("Month to invoice (1-12)"),
      year: z.number().int().default(2026).describe("Year"),
      invoiceNumber: z.number().int().optional().describe("Invoice number (auto-detects from NextCloud if omitted)"),
      client: z.string().default("Crexi").describe("Client name (default: Crexi)"),
      dryRun: z.boolean().default(false).describe("If true, generate PDF but don't upload to NextCloud"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: sanitize(await invoiceGenerate(params)) }],
    }),
  );

  server.tool(
    "accounting-payroll-paystub",
    "Generate a pay stub PDF for a given month. Renders PDF, uploads to NextCloud. Optional override params for recreating historical stubs with actual withholding amounts.",
    {
      month: z.number().int().min(1).max(12).describe("Month (1-12)"),
      year: z.number().int().min(2020).max(2030).default(2026).describe("Year"),
      monthlySalary: z.number().positive().describe("Monthly gross salary in USD"),
      dryRun: z.boolean().default(false).describe("If true, generate PDF but don't upload"),
      federalWithholding: z.number().nonnegative().optional().describe("Override: actual federal tax withheld (skip calculation)"),
      socialSecurity: z.number().nonnegative().optional().describe("Override: actual SS tax withheld (skip calculation)"),
      medicare: z.number().nonnegative().optional().describe("Override: actual Medicare tax withheld (skip calculation)"),
      adjustments: z.array(z.object({
        label: z.string().describe("Adjustment description (e.g., 'Federal Tax Withholding Jan')"),
        amount: z.number().nonnegative().describe("Adjustment amount"),
      })).optional().describe("Additional adjustment line items (e.g., catch-up withholding corrections)"),
    },
    async (params) => ({
      content: [{ type: "text" as const, text: sanitize(await paystubGenerate(params)) }],
    }),
  );

  // ── Phase 2B Tools (QBO OAuth + API) ──

  server.tool(
    "accounting-qbo-auth-url",
    "Generate a QuickBooks OAuth2 authorization URL. Open the returned URL in any browser to authorize. The callback window is active for 10 minutes.",
    {},
    async () => {
      const creds = getQBOCredentials();
      if (!creds?.clientId || !creds?.redirectUri) {
        return {
          content: [{
            type: "text" as const,
            text: "Error: QBO_CLIENT_ID or QBO_REDIRECT_URI not configured in quickbooks.env",
          }],
        };
      }
      const { url, expiresIn } = generateAuthUrl(creds.clientId, creds.redirectUri);
      return {
        content: [{
          type: "text" as const,
          text: `## QBO Authorization\n\nOpen this URL in your browser:\n\n${url}\n\nCallback window expires in ${expiresIn}.`,
        }],
      };
    },
  );

  server.tool(
    "accounting-qbo-status",
    "Check QuickBooks Online connection status. Shows whether OAuth is configured, authorized, and token freshness.",
    {},
    async () => {
      const status = getQBOStatus();
      const tokens = readTokens();
      let details = `## QBO Connection Status\n\n**Status:** ${status}\n`;

      if (tokens && !isRefreshTokenExpired(tokens)) {
        const accessExpiry = new Date(tokens.expiresAt).toISOString();
        const refreshExpiry = new Date(tokens.refreshExpiresAt).toISOString();
        details += `\n| Field | Value |\n|-------|-------|\n`;
        details += `| Realm ID | ${tokens.realmId} |\n`;
        details += `| Access Token Expires | ${accessExpiry} |\n`;
        details += `| Refresh Token Expires | ${refreshExpiry} |\n`;
      }

      return {
        content: [{ type: "text" as const, text: sanitize(details) }],
      };
    },
  );

  server.tool(
    "accounting-invoice-status",
    "Read invoice data from QuickBooks Online for a date range.",
    {
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
    },
    async (params) => {
      const creds = getQBOCredentials();
      if (!creds?.clientId || !creds?.clientSecret) {
        return { content: [{ type: "text" as const, text: "Error: QBO credentials not configured" }] };
      }
      try {
        const data = await qboListInvoices({ clientId: creds.clientId, clientSecret: creds.clientSecret }, params.startDate, params.endDate);
        return { content: [{ type: "text" as const, text: sanitize(JSON.stringify(data, null, 2)) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: sanitize(`Error: ${err instanceof Error ? err.message : "unknown"}`) }] };
      }
    },
  );

  server.tool(
    "accounting-bookkeeping-summary",
    "Get Profit & Loss report from QuickBooks Online for a date range.",
    {
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
    },
    async (params) => {
      const creds = getQBOCredentials();
      if (!creds?.clientId || !creds?.clientSecret) {
        return { content: [{ type: "text" as const, text: "Error: QBO credentials not configured" }] };
      }
      try {
        const data = await qboProfitAndLoss({ clientId: creds.clientId, clientSecret: creds.clientSecret }, params.startDate, params.endDate);
        return { content: [{ type: "text" as const, text: sanitize(JSON.stringify(data, null, 2)) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: sanitize(`Error: ${err instanceof Error ? err.message : "unknown"}`) }] };
      }
    },
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

    // ── OAuth Callback (browser redirect from Intuit) ──
    if (url.pathname === "/oauth/callback" && req.method === "GET") {
      if (!isAuthWindowOpen()) {
        return new Response("Not Found", { status: 404 });
      }

      const code = url.searchParams.get("code");
      const realmId = url.searchParams.get("realmId");
      const state = url.searchParams.get("state");

      if (!code || !realmId || !state) {
        return new Response(callbackHtml("Missing parameters", false), {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (!validateState(state)) {
        return new Response(callbackHtml("Invalid or expired state", false), {
          status: 403,
          headers: { "Content-Type": "text/html" },
        });
      }

      const creds = getQBOCredentials();
      if (!creds?.clientId || !creds?.clientSecret) {
        return new Response(callbackHtml("Server credentials not configured", false), {
          status: 500,
          headers: { "Content-Type": "text/html" },
        });
      }

      const redirectUri = creds.redirectUri || `https://${req.headers.get("host")}/oauth/callback`;

      try {
        await exchangeCode(code, realmId, creds.clientId, creds.clientSecret, redirectUri);
        return new Response(callbackHtml("Authorization successful! You can close this tab.", true), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      } catch (err) {
        console.error("OAuth token exchange failed:", err instanceof Error ? err.message : err);
        return new Response(callbackHtml("Token exchange failed. Check server logs.", false), {
          status: 500,
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    // ── MCP endpoint — loopback only (defense in depth) ──
    if (url.pathname === "/mcp") {
      // Reject requests forwarded from external sources via reverse proxy
      const forwarded = req.headers.get("x-forwarded-for");
      if (forwarded) {
        return new Response("Forbidden", { status: 403 });
      }

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
console.log("Tools: 11 (Phase 1 + 2A + 2B) | PDF: pdfmake | QBO: OAuth2 ready");

process.on("SIGTERM", () => {
  httpServer.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  httpServer.stop();
  process.exit(0);
});
