/**
 * Phase 3 — Jackie tool manifest (REST fallback for clients that
 * don't speak MCP). Returns the same catalogue as MCP `tools/list`
 * as a plain JSON document.
 *
 *   GET /api/sscc/manifest
 *   Authorization: Bearer <JACKIE_API_TOKEN|SSCC_API_TOKEN>
 *
 * Response shape:
 *   {
 *     server: { name, version },
 *     generated_at: ISO,
 *     tools: [
 *       { name, description, write, input_schema }
 *     ]
 *   }
 */

import { NextResponse } from "next/server";
import { ensureRegistered } from "@/lib/jackie-mcp/tools";
import { listTools, verifyJackieAuth } from "@/lib/jackie-mcp/registry";
import {
  REST_ENDPOINTS,
  REST_ENDPOINTS_COUNT,
} from "@/lib/jackie-mcp/rest-endpoints.generated";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyJackieAuth(request.headers.get("Authorization"));
  if (authError) {
    return NextResponse.json(
      { error: "Unauthorized", reason: authError },
      { status: 401 },
    );
  }
  ensureRegistered();
  const tools = listTools().map((t) => ({
    name: t.name,
    description: t.description,
    long_description: t.long_description,
    write: t.write,
    input_schema: t.input_schema,
  }));

  // ?full=1 (or ?rest=1) adds the complete REST surface a token client can
  // call as admin — the 36 MCP tools are a curated subset; this is the map
  // for everything else (e.g. the Financial Plan lives under /api/finance/*).
  const url = new URL(request.url);
  const full = url.searchParams.has("full") || url.searchParams.has("rest");

  return NextResponse.json({
    server: { name: "sscc-mcp", version: "1.0.0" },
    generated_at: new Date().toISOString(),
    protocol: "rest-manifest-v1",
    tools_count: tools.length,
    tools,
    ...(full
      ? {
          rest_endpoints_count: REST_ENDPOINTS_COUNT,
          rest_endpoints: REST_ENDPOINTS,
          rest_note:
            "Bearer token has full admin on all of these. Methods are the HTTP verbs each route exports. Financial Plan = /api/finance/*.",
        }
      : {
          rest_endpoints_hint:
            "Append ?full=1 to get the complete REST endpoint map (all /api/* paths the token can call as admin).",
        }),
  });
}
