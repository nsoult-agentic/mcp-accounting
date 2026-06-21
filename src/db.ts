/**
 * PostgreSQL database module for structured accounting data.
 * Uses the existing Second Brain PostgreSQL instance with a separate `accounting` schema.
 *
 * Connection: hardcoded to second-brain-db on mcp_network.
 * Password: read from /secrets/db-password (same pattern as mcp-second-brain).
 *
 * Tables: time_off, compliance_filings, payroll_runs
 * All DDL is idempotent (CREATE IF NOT EXISTS).
 *
 * If the password file is missing, all functions gracefully return null/empty
 * and callers fall back to brain-search/brain-store.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SECRETS_DIR = process.env["SECRETS_DIR"] || "/secrets";

function loadDbPassword(): string | null {
  const path = resolve(SECRETS_DIR, "db-password");
  try {
    const pw = readFileSync(path, "utf-8").trim();
    return pw.length > 0 ? pw : null;
  } catch {
    return null;
  }
}

const DB_PASSWORD = loadDbPassword();

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (!DB_PASSWORD) return null;
  if (!pool) {
    pool = new pg.Pool({
      host: "second-brain-db",
      port: 5432,
      database: "second_brain",
      user: "pai",
      password: DB_PASSWORD,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    pool.on("error", (err) => {
      console.error("PostgreSQL pool error:", err.message);
    });
  }
  return pool;
}

export function isDbAvailable(): boolean {
  return !!DB_PASSWORD;
}

// ── Schema Initialization ─────────────────────────────────

export async function initSchema(): Promise<void> {
  const p = getPool();
  if (!p) {
    console.warn(
      "No db-password in secrets — database features disabled, using Second Brain fallback",
    );
    return;
  }

  try {
    await p.query(`CREATE SCHEMA IF NOT EXISTS accounting`);

    await p.query(`CREATE TABLE IF NOT EXISTS accounting.time_off (
      id          SERIAL PRIMARY KEY,
      date        DATE NOT NULL UNIQUE,
      type        TEXT NOT NULL CHECK (type IN ('sick', 'vacation', 'holiday', 'other')),
      note        TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    )`);

    await p.query(`CREATE TABLE IF NOT EXISTS accounting.compliance_filings (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      tax_year    INTEGER NOT NULL,
      filed_date  DATE NOT NULL,
      method      TEXT DEFAULT '',
      note        TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now(),
      UNIQUE(name, tax_year)
    )`);

    await p.query(`CREATE TABLE IF NOT EXISTS accounting.payroll_runs (
      id                    SERIAL PRIMARY KEY,
      month                 INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
      year                  INTEGER NOT NULL,
      gross_pay             NUMERIC(12,2) NOT NULL,
      federal_withholding   NUMERIC(12,2) NOT NULL,
      social_security       NUMERIC(12,2) NOT NULL,
      medicare              NUMERIC(12,2) NOT NULL,
      state_withholding     NUMERIC(12,2) DEFAULT 0,
      total_deductions      NUMERIC(12,2) NOT NULL,
      net_pay               NUMERIC(12,2) NOT NULL,
      employer_ss           NUMERIC(12,2) NOT NULL,
      employer_medicare     NUMERIC(12,2) NOT NULL,
      employer_futa         NUMERIC(12,2) NOT NULL,
      pay_stub_path         TEXT,
      created_at            TIMESTAMPTZ DEFAULT now(),
      updated_at            TIMESTAMPTZ DEFAULT now(),
      UNIQUE(month, year)
    )`);

    await p.query(`CREATE TABLE IF NOT EXISTS accounting.deposits (
      id              SERIAL PRIMARY KEY,
      form            TEXT NOT NULL,
      tax_period      TEXT NOT NULL,
      amount          NUMERIC(10,2) NOT NULL,
      deposit_date    DATE NOT NULL,
      eft_number      TEXT,
      method          TEXT DEFAULT 'EFTPS',
      status          TEXT DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'rejected')),
      payroll_run_id  INTEGER REFERENCES accounting.payroll_runs(id),
      note            TEXT DEFAULT '',
      created_at      TIMESTAMPTZ DEFAULT now(),
      created_by      TEXT DEFAULT 'neil',
      UNIQUE(form, tax_period, eft_number)
    )`);

    await p.query(`CREATE INDEX IF NOT EXISTS idx_time_off_date ON accounting.time_off(date)`);
    await p.query(
      `CREATE INDEX IF NOT EXISTS idx_deposits_form_period ON accounting.deposits(form, tax_period)`,
    );

    console.log(
      "PostgreSQL schema initialized (accounting.time_off, accounting.compliance_filings, accounting.payroll_runs, accounting.deposits)",
    );
  } catch (err) {
    console.error(
      "Failed to initialize database schema:",
      err instanceof Error ? err.message : err,
    );
    throw err;
  }
}

// ── Time Off Operations ───────────────────────────────────

export async function dbTimeOffInsert(date: string, type: string, note: string): Promise<void> {
  const p = getPool();
  if (!p) throw new Error("Database not configured");
  await p.query(
    `INSERT INTO accounting.time_off (date, type, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (date) DO UPDATE SET type = $2, note = $3, updated_at = now()`,
    [date, type, note],
  );
}

export async function dbTimeOffList(
  year: number,
  month: number,
): Promise<{ date: string; type: string; note: string }[]> {
  const p = getPool();
  if (!p) throw new Error("Database not configured");
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate =
    month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const result = await p.query(
    `SELECT date::text, type, COALESCE(note, '') AS note
     FROM accounting.time_off
     WHERE date >= $1 AND date < $2
     ORDER BY date`,
    [startDate, endDate],
  );
  return result.rows;
}

export async function dbTimeOffDelete(
  date: string,
): Promise<{ date: string; type: string; note: string } | null> {
  const p = getPool();
  if (!p) throw new Error("Database not configured");
  const result = await p.query(
    `DELETE FROM accounting.time_off WHERE date = $1
     RETURNING date::text, type, COALESCE(note, '') AS note`,
    [date],
  );
  return result.rows[0] ?? null;
}

// ── Compliance Operations ─────────────────────────────────

export async function dbComplianceFiled(
  name: string,
  taxYear: number,
  filedDate: string,
  method: string,
  note: string,
): Promise<{ action: "inserted" | "updated" }> {
  const p = getPool();
  if (!p) throw new Error("Database not configured");
  const result = await p.query(
    `INSERT INTO accounting.compliance_filings (name, tax_year, filed_date, method, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name, tax_year) DO UPDATE
       SET filed_date = $3, method = $4, note = $5, updated_at = now()
     RETURNING (xmax = 0) AS is_insert`,
    [name, taxYear, filedDate, method, note],
  );
  return { action: result.rows[0]?.is_insert ? "inserted" : "updated" };
}

export async function dbComplianceGetFiled(years: number[]): Promise<Set<string>> {
  const p = getPool();
  if (!p) return new Set();
  try {
    const result = await p.query(
      `SELECT DISTINCT name FROM accounting.compliance_filings WHERE tax_year = ANY($1)`,
      [years],
    );
    return new Set(result.rows.map((r: { name: string }) => r.name));
  } catch {
    return new Set();
  }
}

// ── Payroll Operations ────────────────────────────────────

export async function dbPayrollInsert(data: {
  month: number;
  year: number;
  grossPay: number;
  federalWithholding: number;
  socialSecurity: number;
  medicare: number;
  totalDeductions: number;
  netPay: number;
  employerSs: number;
  employerMedicare: number;
  employerFuta: number;
  payStubPath?: string;
}): Promise<void> {
  const p = getPool();
  if (!p) return; // Silently skip if DB not configured
  try {
    await p.query(
      `INSERT INTO accounting.payroll_runs
         (month, year, gross_pay, federal_withholding, social_security, medicare,
          total_deductions, net_pay, employer_ss, employer_medicare, employer_futa, pay_stub_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (month, year) DO UPDATE SET
         gross_pay = $3, federal_withholding = $4, social_security = $5, medicare = $6,
         total_deductions = $7, net_pay = $8, employer_ss = $9, employer_medicare = $10,
         employer_futa = $11, pay_stub_path = COALESCE($12, accounting.payroll_runs.pay_stub_path),
         updated_at = now()`,
      [
        data.month,
        data.year,
        data.grossPay,
        data.federalWithholding,
        data.socialSecurity,
        data.medicare,
        data.totalDeductions,
        data.netPay,
        data.employerSs,
        data.employerMedicare,
        data.employerFuta,
        data.payStubPath || null,
      ],
    );
  } catch (err) {
    console.error("Failed to persist payroll run:", err instanceof Error ? err.message : err);
    // Non-fatal — the PDF was already generated and uploaded
  }
}

// ── Deposit Operations ──────────────────────────────────

export async function dbDepositInsert(data: {
  form: string;
  taxPeriod: string;
  amount: number;
  depositDate: string;
  eftNumber?: string;
  method?: string;
  status?: string;
  payrollRunId?: number;
  note?: string;
  createdBy?: string;
}): Promise<{ action: "inserted" | "updated" }> {
  const p = getPool();
  if (!p) throw new Error("Database not configured");
  const result = await p.query(
    `INSERT INTO accounting.deposits
       (form, tax_period, amount, deposit_date, eft_number, method, status, payroll_run_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (form, tax_period, eft_number) DO UPDATE SET
       amount = $3, deposit_date = $4, method = $6, status = $7,
       payroll_run_id = $8, note = $9, created_by = $10
     RETURNING (xmax = 0) AS is_insert`,
    [
      data.form,
      data.taxPeriod,
      data.amount,
      data.depositDate,
      data.eftNumber || null,
      data.method || "EFTPS",
      data.status || "confirmed",
      data.payrollRunId || null,
      data.note || "",
      data.createdBy || "neil",
    ],
  );
  return { action: result.rows[0]?.is_insert ? "inserted" : "updated" };
}

export async function dbDepositGetByPeriod(
  form: string,
  taxPeriods: string[],
): Promise<
  Map<string, { amount: number; depositDate: string; eftNumber: string; status: string }>
> {
  const p = getPool();
  if (!p) return new Map();
  try {
    const result = await p.query(
      `SELECT tax_period, amount::float, deposit_date::text, COALESCE(eft_number, '') AS eft_number, status
       FROM accounting.deposits
       WHERE form = $1 AND tax_period = ANY($2)`,
      [form, taxPeriods],
    );
    const map = new Map<
      string,
      { amount: number; depositDate: string; eftNumber: string; status: string }
    >();
    for (const row of result.rows) {
      map.set(row.tax_period, {
        amount: row.amount,
        depositDate: row.deposit_date,
        eftNumber: row.eft_number,
        status: row.status,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}
