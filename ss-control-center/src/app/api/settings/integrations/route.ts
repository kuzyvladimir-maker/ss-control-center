/**
 * GET /api/settings/integrations
 *
 * Live status of the PAID external services the command center uses. For each:
 *   - configured (key present)
 *   - subscription/connection healthy (a cheap live ping)
 *   - remaining usage where the vendor exposes it (credits / balance)
 *
 * BlueCart has a free /account endpoint (real plan + credits). Anthropic/OpenAI
 * are validated with a free models ping. Unwrangle has no balance endpoint, so
 * its last-seen credits (recorded by enrichment calls) are read from Setting and
 * only re-probed live on explicit ?refresh=unwrangle (costs 1 credit).
 *
 * PUT updates the monthly budget ceiling (Setting: paid_monthly_budget_usd).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Svc = {
  key: string; name: string; group: "Data & sourcing" | "AI" | "Infrastructure";
  configured: boolean; status: "ok" | "error" | "unknown"; plan?: string | null;
  used?: number | null; remaining?: number | null; limit?: number | null; unit?: string;
  resetAt?: string | null; balanceUsd?: number | null; detail?: string; asOf?: string | null;
};

async function getJson(url: string, init?: RequestInit, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let j: any = null; try { j = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, j, text };
  } finally { clearTimeout(t); }
}

async function probeBluecart(): Promise<Svc> {
  const s: Svc = { key: "bluecart", name: "BlueCart (Walmart data)", group: "Data & sourcing", configured: !!process.env.BLUECART_API_KEY, status: "unknown", unit: "credits" };
  if (!s.configured) return s;
  try {
    const { ok, j } = await getJson(`https://api.bluecartapi.com/account?api_key=${process.env.BLUECART_API_KEY}`);
    const a = j?.account_info;
    if (ok && a) {
      s.status = "ok"; s.plan = a.plan ?? null;
      s.used = a.credits_used ?? null; s.remaining = a.credits_remaining ?? null; s.limit = a.credits_limit ?? null;
      s.resetAt = a.credits_reset_at ?? null; s.balanceUsd = a.account_balance_usd ?? null;
    } else { s.status = "error"; s.detail = j?.request_info?.message || "account lookup failed"; }
  } catch (e: any) { s.status = "error"; s.detail = e?.message?.slice(0, 100); }
  return s;
}

async function probeUnwrangle(refresh: boolean): Promise<Svc> {
  const s: Svc = { key: "unwrangle", name: "Unwrangle (Target/Sam's/Costco)", group: "Data & sourcing", configured: !!process.env.UNWRANGLE_API_KEY, status: "unknown", unit: "credits" };
  if (!s.configured) return s;
  // Cached last-seen credits (recorded by enrichment), unless an explicit live refresh.
  const cached = await prisma.setting.findUnique({ where: { key: "svc_unwrangle_credits" } }).catch(() => null);
  if (cached?.value) { try { const c = JSON.parse(cached.value); s.remaining = c.remaining ?? null; s.asOf = c.at ?? null; s.status = "ok"; } catch {} }
  if (refresh) {
    try {
      const { ok, j } = await getJson(`https://data.unwrangle.com/api/getter/?platform=target_search&search=water&api_key=${process.env.UNWRANGLE_API_KEY}`);
      if (ok || j?.remaining_credits != null) {
        s.remaining = j?.remaining_credits ?? s.remaining; s.status = "ok"; s.asOf = new Date().toISOString();
        await prisma.setting.upsert({ where: { key: "svc_unwrangle_credits" }, create: { key: "svc_unwrangle_credits", value: JSON.stringify({ remaining: s.remaining, at: s.asOf }) }, update: { value: JSON.stringify({ remaining: s.remaining, at: s.asOf }) } });
      } else { s.detail = "live check failed"; }
    } catch (e: any) { s.detail = e?.message?.slice(0, 100); }
  } else if (!cached) { s.detail = "balance shown after first enrichment call (or click Check)"; }
  return s;
}

async function probeAnthropic(): Promise<Svc> {
  const s: Svc = { key: "anthropic", name: "Anthropic Claude", group: "AI", configured: !!process.env.ANTHROPIC_API_KEY, status: "unknown", unit: "pay-as-you-go" };
  if (!s.configured) return s;
  try {
    const { ok, status } = await getJson("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" } });
    s.status = ok ? "ok" : "error"; if (!ok) s.detail = `HTTP ${status}`;
  } catch (e: any) { s.status = "error"; s.detail = e?.message?.slice(0, 100); }
  return s;
}

async function probeOpenai(): Promise<Svc> {
  const s: Svc = { key: "openai", name: "OpenAI (fallback)", group: "AI", configured: !!process.env.OPENAI_API_KEY, status: "unknown", unit: "pay-as-you-go" };
  if (!s.configured) return s;
  try {
    const { ok, status } = await getJson("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    s.status = ok ? "ok" : "error"; if (!ok) s.detail = `HTTP ${status}`;
  } catch (e: any) { s.status = "error"; s.detail = e?.message?.slice(0, 100); }
  return s;
}

function infra(): Svc[] {
  const r2 = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
  const turso = !!process.env.TURSO_AUTH_TOKEN;
  return [
    { key: "r2", name: "Cloudflare R2 (images)", group: "Infrastructure", configured: r2, status: r2 ? "ok" : "unknown", detail: r2 ? "credentials present" : "not configured" },
    { key: "turso", name: "Turso (database)", group: "Infrastructure", configured: turso, status: turso ? "ok" : "unknown", detail: turso ? "credentials present" : "not configured" },
  ];
}

export async function GET(request: NextRequest) {
  const refresh = new URL(request.url).searchParams.get("refresh");
  const [bc, uw, an, oa] = await Promise.all([probeBluecart(), probeUnwrangle(refresh === "unwrangle" || refresh === "all"), probeAnthropic(), probeOpenai()]);
  const services = [bc, uw, an, oa, ...infra()];
  const budgetRow = await prisma.setting.findUnique({ where: { key: "paid_monthly_budget_usd" } }).catch(() => null);
  const monthlyBudgetUsd = budgetRow?.value ? Number(budgetRow.value) : 100;
  return NextResponse.json({ services, monthlyBudgetUsd, checkedAt: new Date().toISOString() });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const v = Number(body?.monthlyBudgetUsd);
  if (!Number.isFinite(v) || v < 0) return NextResponse.json({ error: "invalid budget" }, { status: 400 });
  await prisma.setting.upsert({ where: { key: "paid_monthly_budget_usd" }, create: { key: "paid_monthly_budget_usd", value: String(v) }, update: { value: String(v) } });
  return NextResponse.json({ ok: true, monthlyBudgetUsd: v });
}
