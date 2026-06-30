import { describe, test, expect } from "bun:test";

import { handleMcpRequest } from "../src/http.js";

// Access control now lives solely at the NPM reverse proxy (fleet policy,
// second-brain #2526). The app must NOT gate requests by client IP. This test
// pins that contract: a proxied /mcp request whose first X-Forwarded-For hop is
// not in any allowlist must NOT be rejected with the IP gate's 403 Forbidden —
// it has to be handled like any other request.
describe("/mcp IP gate removed (access control is NPM-only)", () => {
  test("unlisted X-Forwarded-For first hop is not rejected with 403 Forbidden", async () => {
    const req = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // An IP that would never appear in an allowlist.
        "x-forwarded-for": "203.0.113.7",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    const res = await handleMcpRequest(req);

    // The old app-level gate answered exactly `403 "Forbidden"`. The request
    // must get past that — whatever the MCP transport returns for the body is
    // fine, it just must not be the IP gate's denial.
    expect(res.status).not.toBe(403);
  });
});
