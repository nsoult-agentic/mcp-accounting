/**
 * Lightweight MCP client for calling sibling MCP servers via HTTP.
 *
 * Used to call mcp-nextcloud (upload/download) and mcp-second-brain
 * (brain-store/brain-search) from within the accounting container.
 *
 * Servers use Streamable HTTP transport — responses come as SSE events.
 */

// ── Configuration ─────────────────────────────────────

const NEXTCLOUD_MCP_URL =
  process.env["NEXTCLOUD_MCP_URL"] || "http://host.docker.internal:8902/mcp";
const SECOND_BRAIN_MCP_URL =
  process.env["SECOND_BRAIN_MCP_URL"] || "http://host.docker.internal:8904/mcp";

// ── Core RPC ──────────────────────────────────────────

const MCP_TIMEOUT_MS = 15_000;
let rpcId = 0;

interface McpToolResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

async function callMcp(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const id = ++rpcId;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`${toolName} failed: HTTP ${res.status}`);
  }

  const text = await res.text();

  // Parse SSE response — find the result event (skip notifications)
  let lastResult: McpToolResult | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6));
      if (json.error) {
        throw new Error(`${toolName} error: ${json.error.message}`);
      }
      if (json.result) {
        lastResult = json.result as McpToolResult;
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`${toolName} error:`)) throw e;
      // skip unparseable SSE lines
    }
  }
  if (lastResult) return lastResult;

  // Fallback: try parsing entire response as JSON (non-SSE servers)
  try {
    const json = JSON.parse(text);
    if (json.result) return json.result as McpToolResult;
    if (json.error) throw new Error(`${toolName} error: ${json.error.message}`);
  } catch {
    // not JSON
  }

  throw new Error(`No valid response from ${toolName}`);
}

function extractText(result: McpToolResult): string {
  for (const c of result.content) {
    if (c.type === "text" && c.text) return c.text;
  }
  return "";
}

// ── NextCloud Operations ──────────────────────────────

/**
 * Upload a file to NextCloud.
 * @param path - Destination path (e.g., "Shared/Accounting/Invoices/2026/invoice.pdf")
 * @param content - Base64-encoded content for binary files, or plain text
 * @param encoding - "base64" or "text"
 */
export async function nextcloudUpload(
  path: string,
  content: string,
  encoding: "base64" | "text" = "base64",
): Promise<string> {
  const result = await callMcp(NEXTCLOUD_MCP_URL, "nextcloud-upload", {
    path,
    content,
    encoding,
  });
  return extractText(result);
}

/**
 * Download a file from NextCloud. Returns the raw text response
 * (for binary files, the MCP server saves to a temp file and returns a resource).
 */
export async function nextcloudDownload(path: string): Promise<McpToolResult> {
  return callMcp(NEXTCLOUD_MCP_URL, "nextcloud-download", { path });
}

/**
 * List files in a NextCloud directory.
 */
export async function nextcloudList(path: string): Promise<string> {
  const result = await callMcp(NEXTCLOUD_MCP_URL, "nextcloud-list", { path });
  return extractText(result);
}

// ── Second Brain Operations ───────────────────────────

/**
 * Store an item in the Second Brain.
 */
export async function brainStore(
  title: string,
  text: string,
  category: string = "task",
  status: string = "active",
): Promise<string> {
  const result = await callMcp(SECOND_BRAIN_MCP_URL, "brain-store", {
    title,
    text,
    category,
    status,
  });
  return extractText(result);
}

/**
 * Search the Second Brain.
 */
export async function brainSearch(
  query: string,
  opts: {
    category?: string;
    after?: string;
    before?: string;
    limit?: number;
    mode?: "semantic" | "fulltext" | "hybrid";
    status?: string;
  } = {},
): Promise<string> {
  const result = await callMcp(SECOND_BRAIN_MCP_URL, "brain-search", {
    query,
    ...opts,
  });
  return extractText(result);
}
