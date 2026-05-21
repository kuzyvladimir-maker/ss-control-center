/**
 * Phase 3 smoke — exercise the Jackie MCP endpoints WITHOUT spinning up
 * Next.js. We invoke the route handlers directly with synthesised
 * Request objects. This catches:
 *   - auth wiring (Bearer JACKIE_API_TOKEN)
 *   - JSON-RPC method dispatch (initialize, tools/list, tools/call)
 *   - manifest endpoint shape
 *   - a read-only tool actually returning data from Prisma
 *
 *   npx tsx scripts/smoke-jackie-mcp.ts
 */

import "dotenv/config";

const TOKEN = process.env.JACKIE_API_TOKEN ?? process.env.SSCC_API_TOKEN ?? "smoke-token";
// Pin a known token if neither is set — proxy middleware allows either.
if (!process.env.JACKIE_API_TOKEN && !process.env.SSCC_API_TOKEN) {
  process.env.JACKIE_API_TOKEN = TOKEN;
}

function fakeRequest(method: "GET" | "POST", body?: unknown): Request {
  return new Request("https://example.local/api/mcp", {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function main() {
  const mcpRoute = await import("@/app/api/mcp/route");
  const manifestRoute = await import("@/app/api/sscc/manifest/route");

  let failed = false;
  try {
    // ── initialize ───────────────────────────────────────────────────
    {
      const res = await mcpRoute.POST(
        fakeRequest("POST", {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        }),
      );
      const json = await res.json();
      assertEq(res.status, 200, "initialize status");
      assertEq(json.id, 1, "initialize id");
      assertOk(json.result?.serverInfo?.name === "sscc-mcp", "initialize serverInfo");
      assertOk(json.result?.capabilities?.tools, "initialize capabilities.tools present");
      console.log("✓ initialize");
    }
    // ── tools/list ───────────────────────────────────────────────────
    let toolCatalogue: Array<{ name: string }> = [];
    {
      const res = await mcpRoute.POST(
        fakeRequest("POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }),
      );
      const json = await res.json();
      assertEq(res.status, 200, "tools/list status");
      assertOk(Array.isArray(json.result?.tools), "tools is array");
      toolCatalogue = json.result.tools;
      console.log(`✓ tools/list — ${toolCatalogue.length} tools`);
      assertOk(toolCatalogue.length >= 20, "≥20 tools registered");
    }
    // ── manifest fallback ────────────────────────────────────────────
    {
      const res = await manifestRoute.GET(
        new Request("https://example.local/api/sscc/manifest", {
          method: "GET",
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      );
      const json = await res.json();
      assertEq(res.status, 200, "manifest status");
      assertEq(json.tools_count, toolCatalogue.length, "manifest count matches MCP");
      console.log("✓ manifest mirrors tool catalogue");
    }
    // ── auth rejection ───────────────────────────────────────────────
    {
      const res = await mcpRoute.POST(
        new Request("https://example.local/api/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer wrong" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
        }),
      );
      assertEq(res.status, 401, "wrong token rejected");
      console.log("✓ auth rejects bad token");
    }
    // ── tools/call (critical_alerts_list — read-only, safe) ──────────
    {
      const res = await mcpRoute.POST(
        fakeRequest("POST", {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "critical_alerts_list", arguments: { limit: 5 } },
        }),
      );
      const json = await res.json();
      assertEq(res.status, 200, "tools/call status");
      assertOk(!json.result?.isError, `tools/call should not error: ${JSON.stringify(json.result?.content?.[0]?.text ?? "").slice(0, 200)}`);
      const parsed = json.result?.structuredContent;
      assertOk(typeof parsed?.count === "number", "structured content has count");
      console.log(`✓ tools/call critical_alerts_list — count=${parsed.count}`);
    }
    // ── tools/call unknown tool ──────────────────────────────────────
    {
      const res = await mcpRoute.POST(
        fakeRequest("POST", {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "non_existent_tool", arguments: {} },
        }),
      );
      const json = await res.json();
      assertEq(json.error?.code, -32601, "unknown tool → method-not-found");
      console.log("✓ unknown tool surfaces error");
    }
    console.log("\nPASS");
  } catch (e) {
    failed = true;
    console.error("\nFAIL:", e);
  }
  if (failed) process.exit(1);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertOk(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
