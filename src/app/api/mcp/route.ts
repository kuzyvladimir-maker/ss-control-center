/**
 * Phase 3 — Jackie MCP server (Streamable HTTP transport).
 *
 * Implements the minimum JSON-RPC 2.0 surface of the MCP spec needed
 * for tool calling:
 *
 *   initialize                 — protocol handshake + capabilities
 *   notifications/initialized  — no-op acknowledgement
 *   ping                       — health check
 *   tools/list                 — return the full tool catalogue
 *   tools/call                 — invoke a registered tool
 *
 * Auth: Bearer ${JACKIE_API_TOKEN} or ${SSCC_API_TOKEN}. The /api/*
 * middleware in src/proxy.ts already enforces this — by the time we
 * reach this handler we know the request is authenticated. This file
 * keeps a defence-in-depth check anyway in case middleware ordering
 * ever changes.
 *
 * Single endpoint accepts every JSON-RPC method as a POST body. The MCP
 * Streamable HTTP transport spec also supports server-initiated events
 * (SSE), but Jackie's V1 use cases — request/response tool calls —
 * don't need them, so we return plain JSON responses for now.
 */

import { NextResponse } from "next/server";
import { ensureRegistered } from "@/lib/jackie-mcp/tools";
import { getTool, listTools, verifyJackieAuth } from "@/lib/jackie-mcp/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PROTOCOL_VERSION = "2025-03-26"; // MCP spec version we conform to
const SERVER_NAME = "sscc-mcp";
const SERVER_VERSION = "1.0.0";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

async function handleMethod(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case "initialize": {
      return ok(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Salutem Solutions Control Center MCP server. Tools cover " +
          "Listings, Orders, Customer Hub, Account Health, Critical " +
          "Alerts, and Bundle Factory. Tools with side effects expose " +
          "a dry_run flag — use it before committing destructive ops.",
      });
    }
    case "notifications/initialized":
      // Per MCP spec, this is a notification (no id). Return null so
      // we don't reply.
      return null;
    case "ping":
      return ok(req.id, {});
    case "tools/list": {
      const tools = listTools().map((t) => ({
        name: t.name,
        description:
          t.description + (t.write ? " [WRITE]" : "") +
          (t.long_description ? `\n\n${t.long_description}` : ""),
        inputSchema: t.input_schema,
      }));
      return ok(req.id, { tools });
    }
    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
      const name = params.name;
      if (typeof name !== "string") {
        return err(req.id, -32602, "tools/call requires string 'name' param");
      }
      const tool = getTool(name);
      if (!tool) {
        return err(req.id, -32601, `Unknown tool: ${name}`);
      }
      const argsRaw = params.arguments;
      const args =
        argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
          ? (argsRaw as Record<string, unknown>)
          : {};
      try {
        const result = await tool.handler(args, { actor: "jackie" });
        return ok(req.id, {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: result,
          isError: false,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return ok(req.id, {
          content: [{ type: "text", text: `Tool error: ${message}` }],
          isError: true,
        });
      }
    }
    default:
      return err(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export async function POST(request: Request) {
  // Defence-in-depth auth check (middleware already enforces this).
  const authError = verifyJackieAuth(request.headers.get("Authorization"));
  if (authError) {
    return NextResponse.json(
      { error: "Unauthorized", reason: authError },
      { status: 401 },
    );
  }
  ensureRegistered();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // JSON-RPC supports batch (array). Handle both.
  if (Array.isArray(payload)) {
    const responses: JsonRpcResponse[] = [];
    for (const item of payload) {
      if (!isJsonRpcRequest(item)) {
        responses.push(err(null, -32600, "Invalid request in batch"));
        continue;
      }
      const r = await handleMethod(item);
      if (r) responses.push(r);
    }
    return NextResponse.json(responses);
  }

  if (!isJsonRpcRequest(payload)) {
    return NextResponse.json(err(null, -32600, "Invalid Request"));
  }
  const response = await handleMethod(payload);
  if (response === null) {
    // Notification — JSON-RPC says no response body. Return 204.
    return new NextResponse(null, { status: 204 });
  }
  return NextResponse.json(response);
}

export async function GET() {
  // MCP Streamable HTTP supports GET for SSE event streams. We don't
  // need server-push for V1 (tool calls are request/response). Return
  // 405 so clients know to switch to POST.
  return NextResponse.json(
    { error: "Method Not Allowed — use POST with a JSON-RPC 2.0 payload." },
    { status: 405 },
  );
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return r.jsonrpc === "2.0" && typeof r.method === "string";
}
