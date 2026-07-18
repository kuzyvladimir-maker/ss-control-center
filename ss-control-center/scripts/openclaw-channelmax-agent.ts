/**
 * Local, fail-closed bridge to a dedicated OpenClaw ChannelMAX agent.
 *
 * This script never loads or mutates OpenClaw global config. It only calls the
 * explicitly configured Gateway Responses endpoint. Gateway credentials come
 * from the environment, never from a command-line flag.
 *
 * Safe default (read-only audit, non-streaming):
 *   OPENCLAW_GATEWAY_TOKEN=... npx tsx scripts/openclaw-channelmax-agent.ts
 *
 * Prepare an exact plan:
 *   npx tsx scripts/openclaw-channelmax-agent.ts prepare \
 *     --job-id=channelmax-20260718-001 --message="Prepare the Manual-model canary"
 *
 * Commit an already sealed plan (approval proof is hashed before transmission):
 *   OPENCLAW_CHANNELMAX_APPROVAL_TOKEN=... npx tsx scripts/openclaw-channelmax-agent.ts commit \
 *     --job-id=channelmax-20260718-001 --plan-sha256=<64 hex>
 *
 * Check the same job without mutation:
 *   npx tsx scripts/openclaw-channelmax-agent.ts status \
 *     --job-id=channelmax-20260718-001
 */

import { readFile } from "node:fs/promises";

import {
  DEFAULT_OPENCLAW_CHANNELMAX_AGENT_ID,
  DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY,
  DEFAULT_OPENCLAW_CHANNELMAX_TIMEOUT_MS,
  DEFAULT_OPENCLAW_GATEWAY_URL,
  OpenClawChannelMaxAgentClient,
  OpenClawChannelMaxClientError,
  redactChannelMaxSecrets,
  type ChannelMaxAgentAction,
  type JsonObject,
} from "@/lib/openclaw/channelmax-agent-client";

interface CliOptions {
  action: ChannelMaxAgentAction;
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  sessionKey: string;
  jobId?: string;
  planSha256?: string;
  approvalToken?: string;
  message?: string;
  requestFile?: string;
  stream: boolean;
  timeoutMs: number;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/openclaw-channelmax-agent.ts [audit|prepare|commit|status] [options]",
    "",
    "No action defaults to the read-only audit action.",
    "",
    "Options:",
    `  --url=URL                     Gateway URL (default env OPENCLAW_GATEWAY_URL or ${DEFAULT_OPENCLAW_GATEWAY_URL}).`,
    `  --agent=ID                    Dedicated agent id (default ${DEFAULT_OPENCLAW_CHANNELMAX_AGENT_ID}).`,
    `  --session-key=KEY             Stable session key (default ${DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY}).`,
    "  --job-id=ID                   Stable workflow/job id. Required for commit and status.",
    "  --message=TEXT                Operator objective/context (never use for secrets).",
    "  --request-file=PATH           UTF-8 JSON object merged into the task request.",
    "  --stream                      Use the Responses SSE transport.",
    `  --timeout-ms=N                Request timeout, 100-1800000 (default ${DEFAULT_OPENCLAW_CHANNELMAX_TIMEOUT_MS}).`,
    "  --plan-sha256=HEX             Exact sealed plan hash; required for commit.",
    "  --approval-token-file=PATH    Read one-time commit approval proof from a file.",
    "  --approval-token-env=NAME     Read approval proof from an environment variable.",
    "  --help                        Show this help.",
    "",
    "Gateway auth must be in OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD.",
    "Commit approval defaults to OPENCLAW_CHANNELMAX_APPROVAL_TOKEN. Raw approval",
    "proofs and Gateway credentials are never serialized into output or task transcripts.",
  ].join("\n");
}

function parsePositiveInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function takeValue(arg: string, prefix: string): string | null {
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}

async function parseArgs(argv: string[]): Promise<CliOptions> {
  let action: ChannelMaxAgentAction = "audit";
  let actionSeen = false;
  let gatewayUrl = process.env.OPENCLAW_GATEWAY_URL?.trim() || DEFAULT_OPENCLAW_GATEWAY_URL;
  let agentId = DEFAULT_OPENCLAW_CHANNELMAX_AGENT_ID;
  let sessionKey = DEFAULT_OPENCLAW_CHANNELMAX_SESSION_KEY;
  let jobId: string | undefined;
  let planSha256: string | undefined;
  let message: string | undefined;
  let requestFile: string | undefined;
  let approvalTokenFile: string | undefined;
  let approvalTokenEnv = "OPENCLAW_CHANNELMAX_APPROVAL_TOKEN";
  let stream = false;
  let timeoutMs = DEFAULT_OPENCLAW_CHANNELMAX_TIMEOUT_MS;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (["audit", "prepare", "commit", "status"].includes(arg)) {
      if (actionSeen) throw new Error("Specify exactly one action.");
      action = arg as ChannelMaxAgentAction;
      actionSeen = true;
      continue;
    }
    if (arg === "--stream") {
      stream = true;
      continue;
    }

    const url = takeValue(arg, "--url=");
    const agent = takeValue(arg, "--agent=");
    const session = takeValue(arg, "--session-key=");
    const job = takeValue(arg, "--job-id=");
    const plan = takeValue(arg, "--plan-sha256=");
    const objective = takeValue(arg, "--message=");
    const requestPath = takeValue(arg, "--request-file=");
    const approvalPath = takeValue(arg, "--approval-token-file=");
    const approvalEnv = takeValue(arg, "--approval-token-env=");
    const timeout = takeValue(arg, "--timeout-ms=");
    if (url != null) gatewayUrl = url;
    else if (agent != null) agentId = agent;
    else if (session != null) sessionKey = session;
    else if (job != null) jobId = job;
    else if (plan != null) planSha256 = plan;
    else if (objective != null) message = objective;
    else if (requestPath != null) requestFile = requestPath;
    else if (approvalPath != null) approvalTokenFile = approvalPath;
    else if (approvalEnv != null) approvalTokenEnv = approvalEnv;
    else if (timeout != null) timeoutMs = parsePositiveInteger("--timeout-ms", timeout);
    else throw new Error(`Unknown argument ${arg}.\n\n${usage()}`);
  }

  const gatewayToken =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    "";
  if (!gatewayToken) {
    throw new Error(
      "Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD; credentials are intentionally not accepted in argv.",
    );
  }

  if ((action === "commit" || action === "status") && !jobId) {
    throw new Error(`${action} requires --job-id.`);
  }
  if (action === "commit" && !planSha256) {
    throw new Error("commit requires --plan-sha256.");
  }
  if (action !== "commit" && (planSha256 || approvalTokenFile)) {
    throw new Error(`${action} is read-only and cannot receive commit authorization.`);
  }

  let approvalToken: string | undefined;
  if (action === "commit") {
    if (approvalTokenFile) {
      approvalToken = (await readFile(approvalTokenFile, "utf8")).trim();
    } else {
      approvalToken = process.env[approvalTokenEnv]?.trim();
    }
    if (!approvalToken) {
      throw new Error(
        `commit requires --approval-token-file or a non-empty ${approvalTokenEnv} environment variable.`,
      );
    }
  }

  return {
    action,
    gatewayUrl,
    gatewayToken,
    agentId,
    sessionKey,
    jobId,
    planSha256,
    approvalToken,
    message,
    requestFile,
    stream,
    timeoutMs,
  };
}

async function requestPayload(options: CliOptions): Promise<JsonObject> {
  let payload: JsonObject = {};
  if (options.requestFile) {
    const raw = await readFile(options.requestFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--request-file must contain one JSON object.");
    }
    payload = parsed as JsonObject;
  }
  if (options.message) payload = { ...payload, objective: options.message };
  return payload;
}

async function main(): Promise<void> {
  const options = await parseArgs(process.argv.slice(2));
  const request = await requestPayload(options);
  const client = new OpenClawChannelMaxAgentClient({
    gatewayUrl: options.gatewayUrl,
    gatewayToken: options.gatewayToken,
    agentId: options.agentId,
    sessionKey: options.sessionKey,
    timeoutMs: options.timeoutMs,
  });

  const common = {
    request,
    stream: options.stream,
    timeoutMs: options.timeoutMs,
  };
  let result;
  if (options.action === "audit") {
    result = await client.audit({ ...common, jobId: options.jobId });
  } else if (options.action === "prepare") {
    result = await client.prepare({ ...common, jobId: options.jobId });
  } else if (options.action === "status") {
    result = await client.status({ ...common, jobId: options.jobId! });
  } else {
    result = await client.commit({
      ...common,
      jobId: options.jobId!,
      planSha256: options.planSha256!,
      approvalToken: options.approvalToken!,
    });
  }

  console.log(
    JSON.stringify(
      redactChannelMaxSecrets(result, [
        options.gatewayToken,
        options.approvalToken ?? "",
      ]),
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const known = error instanceof OpenClawChannelMaxClientError ? error : null;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const gatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD ?? "";
  const approvalToken = process.env.OPENCLAW_CHANNELMAX_APPROVAL_TOKEN ?? "";
  const safeMessage = redactChannelMaxSecrets(
    error instanceof Error ? error.message : String(error),
    [gatewayToken, gatewayPassword, approvalToken],
  );
  console.error(
    JSON.stringify({
      ok: false,
      code: known?.code ?? "CLI_ERROR",
      http_status: known?.httpStatus ?? null,
      job_id: known?.jobId ?? null,
      error: safeMessage,
    }),
  );
  process.exitCode = 1;
});
