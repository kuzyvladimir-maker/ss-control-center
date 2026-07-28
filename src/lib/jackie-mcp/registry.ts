/**
 * Phase 3 — Jackie MCP server: tool registry.
 *
 * Convention: each tool exports `{ name, description, input_schema, handler }`
 * from a file in `./tools/`. The registry imports the barrel `./tools/index.ts`
 * which re-exports an array of every tool. Adding a new tool to Jackie =
 * one new file + one line in the barrel.
 *
 * Handler return shape: any JSON-serialisable value. The MCP endpoint
 * wraps it into the standard MCP `tools/call` content envelope.
 */

/**
 * Minimal JSON Schema shape we use. The MCP spec accepts the full
 * Draft-7 schema, but for tool inputs we only need the subset below
 * (object with typed properties + required[]). Keeps us free of the
 * @types/json-schema dep.
 */
export interface JackieToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JackieToolHandlerContext {
  /** Best-effort actor string for lifecycle logs. Always "jackie" for now;
   *  could be extended to carry a per-request id if Jackie ever needs to
   *  attribute several concurrent users. */
  actor: string;
}

export interface JackieTool {
  /** MCP tool name. Snake_case so it's identical across JSON-RPC and
   *  Jackie's tool invocation surface. */
  name: string;
  /** Short one-line description rendered in the agent's tool catalogue. */
  description: string;
  /** Optional long-form description rendered in some MCP clients as
   *  hover/help text. Falls back to `description` when absent. */
  long_description?: string;
  /** Marks tools that have side effects on marketplaces / DB writes.
   *  Read-only tools have `write: false`. Used by clients (and Jackie's
   *  system prompt) to gate confirmation prompts. */
  write: boolean;
  /** JSON Schema describing the input args. */
  input_schema: JackieToolInputSchema;
  /** Implementation. Receives parsed args (already schema-validated by
   *  the MCP endpoint) + context. */
  handler: (
    args: Record<string, unknown>,
    ctx: JackieToolHandlerContext,
  ) => Promise<unknown>;
}

/** Module-level registry, populated by `./tools/index.ts` on import. */
const REGISTRY = new Map<string, JackieTool>();

export function registerTool(tool: JackieTool): void {
  if (REGISTRY.has(tool.name)) {
    throw new Error(`Duplicate tool registration: ${tool.name}`);
  }
  REGISTRY.set(tool.name, tool);
}

export function getTool(name: string): JackieTool | undefined {
  return REGISTRY.get(name);
}

export function listTools(): JackieTool[] {
  return [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Verify the inbound Bearer token. Returns `null` when valid, an
 *  error message otherwise. The MCP endpoint AND the manifest endpoint
 *  call this — keeps the auth logic single-sourced. */
export function verifyJackieAuth(authHeader: string | null): string | null {
  if (!authHeader) return "Missing Authorization header";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return "Empty bearer token";
  const sscToken = process.env.SSCC_API_TOKEN;
  const jackieToken = process.env.JACKIE_API_TOKEN;
  if (sscToken && bearer === sscToken) return null;
  if (jackieToken && bearer === jackieToken) return null;
  return "Invalid bearer token";
}
