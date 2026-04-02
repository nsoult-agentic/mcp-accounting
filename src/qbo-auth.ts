/**
 * QBO OAuth2 — authorization URL, code exchange, token refresh, persistence.
 *
 * Tokens live at ${TOKENS_DIR}/qbo-tokens.json (writable volume).
 * Static credentials (clientId, clientSecret) come from loadCredentials() in http.ts.
 *
 * SECURITY:
 *   - Token values are NEVER logged or returned to MCP tool output.
 *   - File writes use atomic rename (tmp → final) to prevent partial-write data loss.
 *   - CSRF state is a 32-byte random hex string with 10-minute TTL.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

// ── Configuration ─────────────────────────────────────

const TOKENS_DIR = process.env["TOKENS_DIR"] || "/tokens";
const TOKENS_FILE = resolve(TOKENS_DIR, "qbo-tokens.json");
const TOKENS_TMP = resolve(TOKENS_DIR, "qbo-tokens.json.tmp");

const INTUIT_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const INTUIT_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_SCOPE = "com.intuit.quickbooks.accounting";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Types ─────────────────────────────────────────────

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  expiresAt: number; // Unix ms
  refreshExpiresAt: number; // Unix ms
}

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

// ── CSRF State Management ─────────────────────────────

const pendingStates = new Map<string, number>(); // state → expiry timestamp

function generateState(): string {
  const state = randomBytes(32).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

export function validateState(state: string): boolean {
  const expiry = pendingStates.get(state);
  if (!expiry) return false;
  pendingStates.delete(state);
  if (Date.now() > expiry) return false;
  return true;
}

/** True if at least one state is pending (auth window is open). */
export function isAuthWindowOpen(): boolean {
  // Clean expired states
  const now = Date.now();
  for (const [key, expiry] of pendingStates) {
    if (now > expiry) pendingStates.delete(key);
  }
  return pendingStates.size > 0;
}

// ── Auth URL Generation ───────────────────────────────

export function generateAuthUrl(
  clientId: string,
  redirectUri: string,
): { url: string; expiresIn: string } {
  const state = generateState();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: QBO_SCOPE,
    state,
  });
  return {
    url: `${INTUIT_AUTH_URL}?${params.toString()}`,
    expiresIn: "10 minutes",
  };
}

// ── Token Exchange ────────────────────────────────────

async function postTokenEndpoint(
  body: URLSearchParams,
  clientId: string,
  clientSecret: string,
): Promise<IntuitTokenResponse> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const res = await fetch(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    // Sanitize — Intuit error responses could echo sensitive data
    const safe = text.slice(0, 200)
      .replace(/["']?access_token["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{20,}["']?/gi, "access_token=[REDACTED]")
      .replace(/["']?refresh_token["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{20,}["']?/gi, "refresh_token=[REDACTED]");
    throw new Error(`Intuit token endpoint returned ${res.status}: ${safe}`);
  }

  return (await res.json()) as IntuitTokenResponse;
}

export async function exchangeCode(
  code: string,
  realmId: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const data = await postTokenEndpoint(body, clientId, clientSecret);
  const now = Date.now();

  const tokens: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    realmId,
    expiresAt: now + data.expires_in * 1000,
    refreshExpiresAt: now + data.x_refresh_token_expires_in * 1000,
  };

  writeTokens(tokens);
  console.log("QBO OAuth: tokens obtained and saved successfully");
}

export async function refreshTokens(
  clientId: string,
  clientSecret: string,
): Promise<StoredTokens> {
  const current = readTokens();
  if (!current) {
    throw new Error("No stored tokens to refresh");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  });

  const data = await postTokenEndpoint(body, clientId, clientSecret);
  const now = Date.now();

  const updated: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    realmId: current.realmId,
    expiresAt: now + data.expires_in * 1000,
    refreshExpiresAt: now + data.x_refresh_token_expires_in * 1000,
  };

  writeTokens(updated);
  console.log("QBO OAuth: tokens refreshed successfully");
  return updated;
}

// ── Token Persistence (atomic write) ──────────────────

function writeTokens(tokens: StoredTokens): void {
  const json = JSON.stringify(tokens);
  // Atomic: write to tmp file, then rename
  writeFileSync(TOKENS_TMP, json, { mode: 0o600 });
  renameSync(TOKENS_TMP, TOKENS_FILE);
}

export function readTokens(): StoredTokens | null {
  if (!existsSync(TOKENS_FILE)) return null;
  try {
    const raw = readFileSync(TOKENS_FILE, "utf-8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

// ── Token Freshness ───────────────────────────────────

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export function isAccessTokenExpired(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.expiresAt - REFRESH_BUFFER_MS;
}

export function isRefreshTokenExpired(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.refreshExpiresAt;
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns null if no tokens exist or refresh token is expired.
 */
export async function getValidAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; realmId: string } | null> {
  let tokens = readTokens();
  if (!tokens) return null;

  if (isRefreshTokenExpired(tokens)) {
    console.log("QBO OAuth: refresh token expired — re-authorization required");
    return null;
  }

  if (isAccessTokenExpired(tokens)) {
    tokens = await refreshTokens(clientId, clientSecret);
  }

  return { accessToken: tokens.accessToken, realmId: tokens.realmId };
}
