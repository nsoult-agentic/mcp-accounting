/**
 * QBO REST API v3 client with auto-refresh.
 *
 * All requests go through qboFetch() which checks token freshness
 * and refreshes automatically before making the API call.
 *
 * SECURITY:
 *   - Token values never appear in return values or logs.
 *   - API errors are sanitized before returning to callers.
 */

import { getValidAccessToken } from "./qbo-auth.js";

// ── Configuration ─────────────────────────────────────

const QBO_BASE_URL = "https://quickbooks.api.intuit.com/v3/company";
const QBO_MINOR_VERSION = "73"; // Latest minor version as of 2026

// ── Core Fetch ────────────────────────────────────────

interface QBOClientConfig {
  clientId: string;
  clientSecret: string;
}

async function qboFetch(
  config: QBOClientConfig,
  path: string,
  opts: { method?: string; body?: string } = {},
): Promise<unknown> {
  const auth = await getValidAccessToken(config.clientId, config.clientSecret);
  if (!auth) {
    throw new Error(
      "QBO not connected — run accounting-qbo-auth-url to authorize",
    );
  }

  const separator = path.includes("?") ? "&" : "?";
  const url = `${QBO_BASE_URL}/${auth.realmId}${path}${separator}minorversion=${QBO_MINOR_VERSION}`;

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    // Sanitize — never include token info in error messages
    throw new Error(
      `QBO API error ${res.status}: ${text.slice(0, 200).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")}`,
    );
  }

  return res.json();
}

// ── Public API ────────────────────────────────────────

/**
 * Run a QBO SQL-like query.
 * Example: query(config, "SELECT * FROM Invoice WHERE TxnDate > '2026-01-01'")
 */
export async function query(
  config: QBOClientConfig,
  sql: string,
): Promise<unknown> {
  const encoded = encodeURIComponent(sql);
  return qboFetch(config, `/query?query=${encoded}`);
}

/**
 * Read a single entity by type and ID.
 * Example: read(config, "CompanyInfo", "1234567890")
 */
export async function read(
  config: QBOClientConfig,
  entity: string,
  id: string,
): Promise<unknown> {
  return qboFetch(config, `/${entity.toLowerCase()}/${id}`);
}

/**
 * Read company info (uses realmId as the entity ID).
 */
export async function companyInfo(config: QBOClientConfig): Promise<unknown> {
  // realmId needed for the path — qboFetch also validates token freshness
  const auth = await getValidAccessToken(config.clientId, config.clientSecret);
  if (!auth) {
    throw new Error(
      "QBO not connected — run accounting-qbo-auth-url to authorize",
    );
  }
  // Pass realmId in path; qboFetch will re-validate token (harmless, avoids refactor)
  return qboFetch(config, `/companyinfo/${auth.realmId}`);
}

/**
 * Get Profit & Loss report for a date range.
 */
export async function profitAndLoss(
  config: QBOClientConfig,
  startDate: string,
  endDate: string,
): Promise<unknown> {
  return qboFetch(
    config,
    `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}`,
  );
}

/**
 * List invoices for a date range.
 */
export async function listInvoices(
  config: QBOClientConfig,
  startDate: string,
  endDate: string,
): Promise<unknown> {
  return query(
    config,
    `SELECT * FROM Invoice WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' ORDERBY TxnDate DESC`,
  );
}
