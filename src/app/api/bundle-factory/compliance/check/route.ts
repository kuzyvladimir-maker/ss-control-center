/**
 * POST /api/bundle-factory/compliance/check
 *
 * Body: ComplianceInput-shaped JSON + optional `autoFix: boolean`.
 *
 * Runs the 8 hard-rule gate and returns the ComplianceDecision. If the
 * body includes `bundle_draft_id`, the decision is persisted (a new
 * ComplianceCheck row is written and the parent BundleDraft's
 * compliance_status is updated). Without a bundle_draft_id the run is
 * stateless — useful for the UI "test" widget and smoke runs.
 *
 * This endpoint is the single entry point Phase 2.1+ will call after
 * Stage 4 (content gen) and Stage 5 (image gen).
 */

import { NextResponse } from "next/server";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { runComplianceGate } from "@/lib/bundle-factory/compliance/gate";
import type {
  ComplianceInput,
  BundleComponentInput,
} from "@/lib/bundle-factory/compliance/types";

interface RequestBody extends Partial<ComplianceInput> {
  autoFix?: boolean;
  actor?: string;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string");
}

function asComponents(v: unknown): BundleComponentInput[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((row): BundleComponentInput[] => {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;
    const brand = asString(r.brand);
    if (!brand) return [];
    return [
      {
        brand,
        product_name:
          typeof r.product_name === "string" ? r.product_name : undefined,
      },
    ];
  });
}

export const POST = withErrorHandler(
  "compliance/check",
  async (request: Request) => {
    const body = await readJson<RequestBody>(request);
    if (!body) return badRequest("Invalid JSON body");

    const title = asString(body.title).trim();
    const brand = asString(body.brand).trim();
    const bullets = asStringArray(body.bullets);
    const description = asString(body.description);

    if (!title) return badRequest("title is required");
    if (!brand) return badRequest("brand is required");

    const input: ComplianceInput = {
      bundle_draft_id:
        typeof body.bundle_draft_id === "string"
          ? body.bundle_draft_id
          : undefined,
      channel_sku_id:
        typeof body.channel_sku_id === "string"
          ? body.channel_sku_id
          : undefined,
      title,
      brand,
      bullets,
      description,
      browse_node:
        typeof body.browse_node === "string" ? body.browse_node : null,
      main_image_url:
        typeof body.main_image_url === "string" ? body.main_image_url : null,
      bundle_components: asComponents(body.bundle_components),
      skip_image_check: Boolean(body.skip_image_check),
    };

    const decision = await runComplianceGate(input, {
      autoFix: Boolean(body.autoFix),
      actor: typeof body.actor === "string" ? body.actor : "system",
    });

    return NextResponse.json(decision);
  },
);
