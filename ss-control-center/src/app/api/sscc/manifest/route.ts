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
  return NextResponse.json({
    server: { name: "sscc-mcp", version: "1.0.0" },
    generated_at: new Date().toISOString(),
    protocol: "rest-manifest-v1",
    tools_count: tools.length,
    tools,
  });
}
