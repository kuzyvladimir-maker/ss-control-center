/**
 * Walmart API diagnostic — empirically discovers which Seller Performance
 * endpoints Walmart actually exposes for our seller account.
 *
 * Background: Walmart restructured the Seller Performance API. The previous
 * single `/v3/sellerPerformance/summary` endpoint no longer responds, and
 * the new shape is allegedly 11 per-metric endpoints whose exact URL paths
 * aren't reliably documented in the public portal. This module tries every
 * plausible URL shape, plus the On-Request Reports fallback, and returns
 * structured findings so a follow-up commit can hard-code the path that
 * actually works.
 *
 * Used by:
 *   - GET /api/settings/walmart-diagnose       (admin-gated, runs on Vercel)
 *   - scripts/walmart-diagnose-api.ts          (local, npx tsx)
 *
 * Reads credentials from WALMART_CLIENT_ID_STORE{N} + secret + seller id
 * via the existing `WalmartClient`. NO mock data. NO swallowing of errors —
 * every non-2xx response is captured with status + body so the diagnostic
 * report explains exactly why each variant failed.
 */

import { randomUUID } from "crypto";
import { WalmartClient } from "./client";

const BASE_URL =
  process.env.WALMART_API_BASE_URL || "https://marketplace.walmartapis.com";
const API_VERSION = process.env.WALMART_API_VERSION || "v3";
const SVC_NAME = "Walmart Marketplace";

/**
 * URL shapes to try for the On-Time Delivery summary. If one returns 2xx,
 * the same shape (parameterised by metric name) likely works for all 11
 * metrics. We treat OTD as the canary because it's the metric Walmart
 * highlights on the public scorecard.
 */
export const OTD_URL_VARIANTS = [
  "/sellerPerformance/onTimeDelivery/summary",
  "/insights/sellerPerformance/onTimeDelivery",
  "/insights/onTimeDelivery/summary",
  "/getOtd",
  "/sellerPerformance/getOtd",
  "/sellerPerformanceStandards/onTimeDelivery",
  // Extra plausible shapes observed in Walmart partner blogs (added because
  // the prompt list is "examples to try, not exhaustive").
  "/insights/getOtd",
  "/sellerPerformance/onTimeDelivery",
];

/**
 * reportType values to try against the On-Request Reports API. These names
 * are SCREAMING_SNAKE_CASE per Walmart's documented convention for other
 * report types like RECONCILIATION / ITEM / INVENTORY.
 */
export const REPORT_TYPES_TO_TRY = [
  "CANCELLATION",
  "DELIVERY_DEFECT",
  "ITEM_PERFORMANCE",
  "SELLER_PERFORMANCE",
  "SELLER_PERFORMANCE_SUMMARY",
  "ON_TIME_DELIVERY",
  "VALID_TRACKING",
  "NEGATIVE_FEEDBACK",
  "RETURNS",
  "ITEM_NOT_RECEIVED",
  // Additional plausible names worth probing.
  "PERFORMANCE",
  "SCORECARD",
];

export interface ProbeResult {
  url: string;
  status: number | "error";
  ok: boolean;
  bodyPreview: string;
  correlationId: string;
  notes: string;
}

export interface ReportRequestProbe {
  reportType: string;
  status: number | "error";
  ok: boolean;
  requestId?: string;
  bodyPreview: string;
  correlationId: string;
}

export interface DiagnosticFindings {
  ranAt: string;
  storeIndex: number;
  storeName: string;
  sellerId: string | null;
  tokenIssued: boolean;
  tokenError?: string;
  tokenScopes: unknown;
  tokenDetailStatus: number | "error";
  otdProbes: ProbeResult[];
  reportProbes: ReportRequestProbe[];
  winner: {
    /** "live-summary" | "on-request-reports" | "none" */
    approach: string;
    note: string;
  };
}

/**
 * Issue an authenticated GET (or POST) against Walmart's API capturing the
 * full response shape regardless of status code. The native WalmartClient
 * throws on non-2xx — we want the body anyway here, so we do our own fetch
 * using the client's token.
 */
async function probe(
  client: WalmartClient,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number>
): Promise<ProbeResult> {
  const token = await client.getAccessToken();
  const correlationId = randomUUID();
  const query = params
    ? "?" +
      Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const url = `${BASE_URL}/${API_VERSION}${path.startsWith("/") ? path : `/${path}`}${query}`;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "WM_SEC.ACCESS_TOKEN": token.accessToken,
        "WM_QOS.CORRELATION_ID": correlationId,
        "WM_SVC.NAME": SVC_NAME,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    return {
      url,
      status: res.status,
      ok: res.ok,
      bodyPreview: text.slice(0, 500),
      correlationId,
      notes: res.ok
        ? "✅ 2xx — surface this endpoint to Account Health"
        : extractWalmartErrorNote(text, res.status),
    };
  } catch (err) {
    return {
      url,
      status: "error",
      ok: false,
      bodyPreview: err instanceof Error ? err.message : String(err),
      correlationId,
      notes: "network/transport error before Walmart could respond",
    };
  }
}

function extractWalmartErrorNote(body: string, status: number): string {
  // Walmart wraps errors as { error: [ { code, field, description } ] }.
  try {
    const j = JSON.parse(body) as {
      error?: Array<{ code?: string; description?: string }>;
    };
    const first = j.error?.[0];
    if (first?.code || first?.description) {
      return `Walmart code=${first.code ?? "?"} — ${first.description ?? "(no description)"}`;
    }
  } catch {
    // not json, fall through
  }
  if (status === 404) return "404 — endpoint not found at this path";
  if (status === 401) return "401 — auth rejected (token / scope problem)";
  if (status === 403) return "403 — token valid but lacks scope for this resource";
  if (status === 429) return "429 — rate limited";
  if (status >= 500) return `${status} — Walmart server error`;
  return `${status} — see body`;
}

export async function runDiagnostic(storeIndex = 1): Promise<DiagnosticFindings> {
  const findings: DiagnosticFindings = {
    ranAt: new Date().toISOString(),
    storeIndex,
    storeName: "(pending)",
    sellerId: null,
    tokenIssued: false,
    tokenScopes: null,
    tokenDetailStatus: "error",
    otdProbes: [],
    reportProbes: [],
    winner: { approach: "none", note: "diagnostic incomplete" },
  };

  // 1. Construct client — surfaces missing-creds early.
  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
    findings.storeName = client.credentials.storeName;
    findings.sellerId = client.credentials.sellerId;
  } catch (err) {
    findings.tokenError = err instanceof Error ? err.message : String(err);
    return findings;
  }

  // 2. Issue token. If this fails the rest is meaningless.
  try {
    await client.getAccessToken();
    findings.tokenIssued = true;
  } catch (err) {
    findings.tokenError = err instanceof Error ? err.message : String(err);
    return findings;
  }

  // 3. /v3/token/detail — surfaces scopes (key piece of evidence).
  const tokenDetail = await probe(client, "GET", "/token/detail");
  findings.tokenDetailStatus = tokenDetail.status;
  if (tokenDetail.ok) {
    try {
      findings.tokenScopes = JSON.parse(tokenDetail.bodyPreview);
    } catch {
      findings.tokenScopes = tokenDetail.bodyPreview;
    }
  } else {
    findings.tokenScopes = {
      error: tokenDetail.notes,
      status: tokenDetail.status,
      body: tokenDetail.bodyPreview,
    };
  }

  // 4. Probe OTD URL variants. Sequential (Walmart rate-limits aggressively).
  for (const path of OTD_URL_VARIANTS) {
    const result = await probe(client, "GET", path, { windowDays: 30 });
    findings.otdProbes.push(result);
    // No early break — we want the full picture even if one variant wins.
  }

  // 5. Probe On-Request Reports. POST to /reports/reportRequests with each
  // reportType. Don't poll for results yet — we only want to know which
  // reportType values Walmart accepts at request time.
  for (const reportType of REPORT_TYPES_TO_TRY) {
    const result = await probe(client, "POST", "/reports/reportRequests", {
      reportType,
      reportVersion: "v1",
    });
    findings.reportProbes.push({
      reportType,
      status: result.status,
      ok: result.ok,
      requestId: extractRequestId(result.bodyPreview),
      bodyPreview: result.bodyPreview,
      correlationId: result.correlationId,
    });
  }

  // 6. Pick the winning approach.
  const liveWinner = findings.otdProbes.find((p) => p.ok);
  const reportWinner = findings.reportProbes.find((p) => p.ok);
  if (liveWinner) {
    findings.winner = {
      approach: "live-summary",
      note: `Use URL shape: ${liveWinner.url.replace(BASE_URL, "")}. Apply the same shape to all 11 metrics.`,
    };
  } else if (reportWinner) {
    findings.winner = {
      approach: "on-request-reports",
      note: `Live endpoints all 404. Use Reports API with reportType=${reportWinner.reportType} (15-45 min async).`,
    };
  } else {
    findings.winner = {
      approach: "none",
      note: "Neither live nor Reports paths worked. Likely a scope / activation issue — open Walmart Support ticket with this diagnostic attached.",
    };
  }

  return findings;
}

function extractRequestId(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { requestId?: string; requestID?: string };
    return j.requestId || j.requestID;
  } catch {
    return undefined;
  }
}

/**
 * Render the findings as the markdown that should land in
 * docs/WALMART_API_DIAGNOSTIC_RESULTS.md. Returned by the API route so the
 * frontend can offer a copy-to-clipboard / download button.
 */
export function findingsToMarkdown(f: DiagnosticFindings): string {
  const lines: string[] = [];
  lines.push("# Walmart API Diagnostic Results");
  lines.push("");
  lines.push(`- Run at: ${f.ranAt}`);
  lines.push(`- Store: ${f.storeName} (index ${f.storeIndex}, sellerId ${f.sellerId ?? "n/a"})`);
  lines.push(`- Token issued: ${f.tokenIssued ? "yes" : `no — ${f.tokenError ?? "unknown error"}`}`);
  lines.push("");

  lines.push("## Token scopes (`/v3/token/detail`)");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(f.tokenScopes, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## On-Time Delivery endpoint variants");
  lines.push("");
  lines.push("| URL | Status | Note |");
  lines.push("|---|---|---|");
  for (const p of f.otdProbes) {
    lines.push(
      `| \`${p.url.replace(BASE_URL, "")}\` | ${p.status}${p.ok ? " ✅" : ""} | ${p.notes} |`
    );
  }
  lines.push("");

  lines.push("## On-Request Reports — accepted reportType values");
  lines.push("");
  lines.push("| reportType | Status | requestID | Note |");
  lines.push("|---|---|---|---|");
  for (const p of f.reportProbes) {
    const note = p.ok ? "✅ accepted" : extractFromBody(p.bodyPreview);
    lines.push(`| \`${p.reportType}\` | ${p.status} | ${p.requestId ?? "—"} | ${note} |`);
  }
  lines.push("");

  lines.push("## Winning approach");
  lines.push("");
  lines.push(`**${f.winner.approach}** — ${f.winner.note}`);
  lines.push("");

  return lines.join("\n");
}

function extractFromBody(body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: Array<{ description?: string }>;
    };
    return j.error?.[0]?.description?.slice(0, 80) ?? "(no body)";
  } catch {
    return body.slice(0, 80) || "(empty)";
  }
}
