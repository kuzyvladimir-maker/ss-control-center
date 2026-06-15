/**
 * POST /api/amazon/growth/advisor/apply
 *
 * Execute one advisor action against the live listing via the Amazon Listings
 * API (PATCH) — the agent opens the listing's edit and writes the fix.
 *
 * Modes:
 *  - optimizer    : run our deterministic auto-fixes (dedupe duplicate attribute
 *                   + brand-voice title scrub) for this SKU.
 *  - set-attribute: set ONE attribute (e.g. unit_count) to the confirmed value.
 *                   Amazon validates the PATCH; an INVALID result writes nothing.
 *
 * Body: { storeIndex?, sku, mode, attribute?, value?, dryRun? }
 * dryRun=true hits VALIDATION_PREVIEW (no write) so the operator can confirm.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing, type ListingPatch } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { buildPlan, applyPlan } from "@/lib/amazon/growth/optimizer";
import { scoreListing, type HealthIssue } from "@/lib/amazon/growth/listing-health";
import { getAttributeForm, buildAttributeEntry } from "@/lib/amazon/growth/product-type-definitions";
import { logChange, logOptimizerChanges } from "@/lib/amazon/growth/change-log";
import { listSkus } from "@/lib/amazon-sp-api/listings";

export const maxDuration = 120;

function parseIssues(s: string | null): HealthIssue[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function coerce(v: string): number | string {
  const t = v.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
}

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  let sku = "";
  let mode = "";
  let attribute = "";
  let value = "";
  let subValues: Record<string, string> = {};
  let dryRun = false;
  try {
    const body = await request.json();
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    sku = String(body?.sku ?? "");
    mode = String(body?.mode ?? "");
    attribute = String(body?.attribute ?? "");
    value = String(body?.value ?? "");
    if (body?.subValues && typeof body.subValues === "object") subValues = body.subValues;
    if (body?.dryRun === true) dryRun = true;
  } catch {
    /* fallthrough */
  }
  if (!sku || !mode) return NextResponse.json({ ok: false, error: "sku and mode required" }, { status: 400 });

  try {
    const sellerId = await getMerchantToken(storeIndex);

    // ── optimizer: deterministic dedupe + brand-voice scrub ──
    if (mode === "optimizer") {
      const item = await prisma.amazonListingHealthItem.findUnique({
        where: { amazon_health_item_dedup: { storeIndex, sku } },
      });
      const plan = await buildPlan(storeIndex, sellerId, sku, parseIssues(item?.issuesSummary ?? null));
      const result = await applyPlan(storeIndex, sellerId, plan, dryRun);
      if (!dryRun && result.applied) {
        await logOptimizerChanges(prisma, storeIndex, sku, plan, result, "advisor").catch(() => {});
        await rescore(storeIndex, sellerId, sku);
      }
      return NextResponse.json({ ok: true, sku, mode, changes: plan.changes, result });
    }

    // ── set-attribute: write ONE attribute to the confirmed value ──
    if (mode === "set-attribute") {
      if (!attribute || !value) {
        return NextResponse.json({ ok: false, error: "attribute and value required" }, { status: 400 });
      }
      const listing = await getListing(storeIndex, sellerId, sku);
      const summary = listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? listing.summaries?.[0];
      const productType = summary?.productType;
      if (!productType) return NextResponse.json({ ok: false, error: "no productType" }, { status: 422 });

      const attrs = (listing.attributes ?? {}) as Record<string, Array<Record<string, unknown>> | undefined>;

      // Amazon's JSON-Patch path can only address a TOP-LEVEL attribute, never a
      // sub-field. For a nested target like "unit_count.type" we patch the whole
      // parent ("unit_count"), keeping its existing value and setting only the
      // named sub-field (nested enums require { value, language_tag }).
      const dot = attribute.indexOf(".");
      const parentAttr = dot >= 0 ? attribute.slice(0, dot) : attribute;
      const subField = dot >= 0 ? attribute.slice(dot + 1) : null;
      const existing = attrs[parentAttr];

      // Build a SCHEMA-VALID entry from Product Type Definitions (required
      // sub-fields + valid enums); fall back to mirroring the existing shape.
      let entry: Record<string, unknown>;
      const form = await getAttributeForm(storeIndex, productType, parentAttr).catch(() => null);
      if (subField) {
        // Set just the named sub-field on a copy of the existing parent entry.
        const base: Record<string, unknown> = existing?.[0] ? { ...existing[0] } : { marketplace_id: MARKETPLACE_ID };
        const ef = form?.enumFields.find((e) => e.name === subField);
        base[subField] = ef?.nested ? { value: value.trim(), language_tag: "en_US" } : value.trim();
        entry = base;
      } else if (form) {
        entry = buildAttributeEntry(form, value, subValues);
        // keep any required sibling we didn't set from the existing entry
        if (existing?.[0]) entry = { ...existing[0], ...entry };
      } else {
        entry = existing && existing[0]
          ? { ...existing[0], value: coerce(value) }
          : { value: coerce(value), marketplace_id: MARKETPLACE_ID };
      }
      // Guard: an attribute that's neither in this product's schema nor already
      // on the listing has an invalid PATCH path. The advisor sometimes suggests
      // a field that doesn't exist for this product type (e.g. item_net_weight on
      // a MEAT listing) — reject cleanly instead of sending Amazon a 400.
      if (!form && !existing) {
        return NextResponse.json(
          { ok: false, error: `'${parentAttr}' is not a valid attribute for product type ${productType} — needs manual review` },
          { status: 422 },
        );
      }

      const patches: ListingPatch[] = [
        { op: existing ? "replace" : "add", path: `/attributes/${parentAttr}`, value: [entry] },
      ];

      // Validate first (even for a real write) so a bad value or path comes back
      // as a clean "rejected", never a raw SP-API 400.
      const preview = await patchListing(storeIndex, sellerId, sku, productType, patches, { validationPreview: true });
      if (preview?.status !== "VALID" || dryRun) {
        return NextResponse.json({
          ok: true,
          sku,
          mode,
          change: { attribute, value: coerce(value) },
          result: { applied: false, dryRun, status: preview?.status ?? "INVALID", issues: preview?.issues },
        });
      }

      const resp = await patchListing(storeIndex, sellerId, sku, productType, patches, {});
      const applied = resp?.status === "ACCEPTED";
      if (applied) {
        await logChange(prisma, {
          storeIndex,
          sku,
          source: "advisor",
          changeType: "attribute-set",
          field: attribute,
          beforeValue: existing?.[0] ?? null,
          afterValue: entry,
          patch: patches,
          submissionId: resp?.submissionId,
          amazonStatus: resp?.status,
        }).catch(() => {});
        await rescore(storeIndex, sellerId, sku);
      }
      return NextResponse.json({
        ok: true,
        sku,
        mode,
        change: { attribute, value: coerce(value) },
        result: { applied, dryRun, status: resp?.status, submissionId: resp?.submissionId, issues: resp?.issues },
      });
    }

    return NextResponse.json({ ok: false, error: `unsupported mode ${mode}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}

/** Re-read + re-score the SKU after a real write so the worklist updates now. */
async function rescore(storeIndex: number, sellerId: string, sku: string): Promise<void> {
  const page = await listSkus(storeIndex, sellerId, { pageSize: 1, includedData: ["summaries", "issues"] });
  const raw = page.items.find((i) => i.sku === sku);
  if (!raw) return;
  const s = scoreListing(raw as unknown as Record<string, unknown>);
  const existing = await prisma.amazonListingHealthItem.findUnique({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
  });
  if (!existing) return;
  const { computeHealthScore, pickTopFix } = await import("@/lib/amazon/growth/listing-health");
  const components = {
    buyability: s.components.buyability,
    issues: s.components.issues,
    content: existing.contentScore,
    compliance: s.components.compliance,
    buyBox: existing.buyBoxScore,
    conversion: existing.conversionScore,
  };
  await prisma.amazonListingHealthItem.update({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
    data: {
      itemName: s.itemName,
      buyabilityScore: s.components.buyability,
      issuesScore: s.components.issues,
      complianceScore: s.components.compliance,
      errorIssueCount: s.errorIssueCount,
      warningIssueCount: s.warningIssueCount,
      issuesSummary: JSON.stringify(s.issues),
      isSuppressed: s.isSuppressed,
      isDiscoverable: s.isDiscoverable,
      healthScore: computeHealthScore(components),
      topFixComponent: pickTopFix(components),
    },
  });
}
