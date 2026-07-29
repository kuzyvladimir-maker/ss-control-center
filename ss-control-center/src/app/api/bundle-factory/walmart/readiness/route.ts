import { createClient, type Client } from "@libsql/client";
import { NextResponse } from "next/server";

import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { resolveWalmartStudioRequestIntent } from
  "@/lib/bundle-factory/walmart-studio-request";
import {
  diagnoseProductTruthWalmartPilotRequest,
  type ProductTruthWalmartRequestCandidateDiagnostic,
} from "@/lib/sourcing/product-truth-read-contract";
import { readTargetedWalmartDonorSnapshot } from
  "@/lib/sourcing/product-truth-targeted-walmart-evidence";
import {
  loadProductTruthWebControlRuntime,
  productTruthWebControlPublicStatus,
} from "@/lib/sourcing/product-truth-web-control-runtime";

export const dynamic = "force-dynamic";

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^['"]|['"]$/g, "") || undefined;
}

function productTruthDb(): Client {
  const tursoUrl = cleanEnv(process.env.TURSO_DATABASE_URL);
  const tursoToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);
  const url = tursoUrl && tursoToken ? tursoUrl : databaseUrl;
  if (!url) {
    throw new Error("Product Truth database is not configured");
  }
  return createClient({
    url,
    ...(tursoUrl && tursoToken ? { authToken: tursoToken } : {}),
  });
}

function optionalPositiveInteger(value: string | null): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 500
    ? parsed
    : null;
}

async function collectionSupport(
  db: Client,
  candidate: ProductTruthWalmartRequestCandidateDiagnostic,
): Promise<{
  donor_product_id: string;
  supported: boolean;
  reason: string;
}> {
  if (candidate.ready) {
    return {
      donor_product_id: candidate.donor_product_id,
      supported: false,
      reason: "ALREADY_READY",
    };
  }
  try {
    await readTargetedWalmartDonorSnapshot(db, candidate.donor_product_id);
    return {
      donor_product_id: candidate.donor_product_id,
      supported: true,
      reason: "TARGETED_WALMART_EVIDENCE_SUPPORTED",
    };
  } catch {
    return {
      donor_product_id: candidate.donor_product_id,
      supported: false,
      reason: "GENERAL_PRODUCT_TRUTH_DISCOVERY_REQUIRED",
    };
  }
}

export const GET = withErrorHandler(
  "bundle-factory-walmart-readiness",
  async (request: Request) => {
    const url = new URL(request.url);
    const prompt = (url.searchParams.get("prompt") ?? "").trim();
    if (prompt.length < 3 || prompt.length > 1_000) {
      return NextResponse.json(
        { error: "Pass a Walmart request of 3-1000 characters." },
        { status: 400 },
      );
    }
    const listingCount = optionalPositiveInteger(
      url.searchParams.get("listing_count"),
    );
    const packCount = optionalPositiveInteger(
      url.searchParams.get("pack_count"),
    );
    const requestIntent = resolveWalmartStudioRequestIntent({
      prompt,
      listingCount,
      packCount,
    });
    const db = productTruthDb();
    try {
      const diagnostic = await diagnoseProductTruthWalmartPilotRequest(db, {
        query: prompt,
        asOf: new Date().toISOString(),
        requireIngredients: true,
        requireNutrition: true,
        requireAllergens: true,
        limit: Math.max(20, Math.min(50, requestIntent.listing_count * 4)),
      });
      const collection = await Promise.all(
        diagnostic.candidates.map((candidate) =>
          collectionSupport(db, candidate)),
      );
      const collectionByDonor = new Map(
        collection.map((entry) => [entry.donor_product_id, entry]),
      );
      const candidates = diagnostic.candidates.map((candidate) => ({
        ...candidate,
        data_collection:
          collectionByDonor.get(candidate.donor_product_id) ?? null,
      }));
      const capabilityGaps = requestIntent.blockers.filter(
        (blocker) => blocker.kind === "ENGINE_CAPABILITY_GAP",
      );
      const inputConflicts = requestIntent.blockers.filter(
        (blocker) => blocker.kind === "INPUT_CONFLICT",
      );
      const collectionTargets = candidates.filter(
        (candidate) => candidate.data_collection?.supported === true,
      );
      const enoughReady =
        diagnostic.ready_variants >= requestIntent.listing_count;
      const needsDataCollection =
        !enoughReady && diagnostic.matched_variants > 0;
      const noExactMatches = diagnostic.matched_variants === 0;
      let webControl;
      try {
        webControl = productTruthWebControlPublicStatus(
          loadProductTruthWebControlRuntime(),
        );
      } catch {
        webControl = {
          status: "OFF" as const,
          stage: "OFF" as const,
          command_admission: false,
          worker_claims: false,
          metered_execution: false as const,
          provider_calls_from_web: false as const,
          marketplace_mutations: false as const,
        };
      }

      return NextResponse.json({
        ok: true,
        request: requestIntent,
        catalog: {
          ...diagnostic,
          candidates,
          enough_ready: enoughReady,
        },
        diagnosis: {
          input_conflicts: inputConflicts,
          capability_gaps: capabilityGaps,
          data_gap:
            needsDataCollection
              ? {
                  requested_variants: requestIntent.listing_count,
                  ready_variants: diagnostic.ready_variants,
                  missing_ready_variants:
                    requestIntent.listing_count - diagnostic.ready_variants,
                }
              : null,
          no_exact_matches: noExactMatches,
        },
        fallback: {
          required: needsDataCollection || noExactMatches,
          engine:
            collectionTargets.length > 0
              ? "TARGETED_WALMART_EVIDENCE"
              : noExactMatches
                ? "PRODUCT_TRUTH_DEMAND_DISCOVERY"
                : null,
          collector_release_status:
            collectionTargets.length > 0
              ? "SOURCE_READY_REQUIRES_VERIFIED_FROZEN_RELEASE"
              : "NOT_APPLICABLE",
          target_donor_product_ids: collectionTargets.map(
            (candidate) => candidate.donor_product_id,
          ),
          web_control: webControl,
          automatic_web_execution:
            webControl.command_admission && webControl.worker_claims,
          automatic_web_execution_reason:
            webControl.command_admission && webControl.worker_claims
              ? webControl.metered_execution
                ? "The Product Truth worker can prepare exact one-donor plans and run the displayed enrichment quote after one-click owner approval."
                : "The no-spend Product Truth worker can prepare exact one-donor plans, but owner-gated metered execution is not activated."
              : "The Product Truth Web Operations worker is not activated; the Command Center must not pretend that a provider run started.",
          recommendation:
            collectionTargets.length > 0
              ? "Prepare the exact one-product plans now. Review the displayed actions and maximum provider-credit cost, then approve or decline the exact quote. After success, Bundle Factory rechecks Product Truth and continues Generate automatically."
              : noExactMatches
                ? "Run a bounded Product Truth demand-discovery campaign for this request, then repeat this readiness check."
                : needsDataCollection
                  ? "The matched variants need Product Truth enrichment, but they are not eligible for the current one-donor targeted collector."
                  : null,
        },
      });
    } finally {
      db.close();
    }
  },
);
