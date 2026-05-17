// Remediation pipeline skeleton.
//
// Phase 2.0a ships only the *manual_review* path — operator selects
// risky listings, the /remediate endpoint creates ListingRemediation
// rows with status='manual_review' and flips the audit result's
// remediation_status to MANUAL_REVIEW. Vladimir handles the actual
// rewrite by hand for now (using Bundle Factory once Phase 2.1 lands).
//
// The orchestrator + stubs below document the *intended* automated
// path so Phase 2.1 has a clear shape to fill in:
//
//   1. extractProductEssence(audit)         — text → {core_product, size, count, category}
//   2. generateCompliantTitle(essence)      — Claude prompt + title-policy.md constraints
//   3. generateCompliantBullets(essence)    — auto-inject curator disclaimer
//   4. generateCompliantDescription(essence) — same
//   5. regenerateMainImage(essence)         — gpt-image-1, no foreign logos
//   6. runComplianceGate(generated)         — Phase 2.0 gate from BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md
//   7. spApiPatchListing(account, sku, generated) — PATCH /listings/2021-08-01/items/{sellerId}/{sku}
//
// Each stub throws NotImplemented so accidental calls from a half-
// wired UI surface fail loudly instead of silently producing empty
// listings.

import { prisma } from "@/lib/prisma";

class NotImplementedError extends Error {
  constructor(stage: string) {
    super(
      `Remediation stage "${stage}" not implemented yet. ` +
        `Phase 2.0a only supports manual_review remediation. ` +
        `Full automation lands in Phase 2.1+ (Bundle Factory content/image generation).`,
    );
    this.name = "NotImplementedError";
  }
}

interface ProductEssence {
  core_product: string;
  size_label: string | null;
  count: number | null;
  category: string;
}

export async function extractProductEssence(
  _auditResultId: string,
): Promise<ProductEssence> {
  throw new NotImplementedError("extractProductEssence");
}

export async function generateCompliantTitle(
  _essence: ProductEssence,
  _brand: string,
): Promise<string> {
  throw new NotImplementedError("generateCompliantTitle");
}

export async function generateCompliantBullets(
  _essence: ProductEssence,
): Promise<string[]> {
  throw new NotImplementedError("generateCompliantBullets");
}

export async function generateCompliantDescription(
  _essence: ProductEssence,
): Promise<string> {
  throw new NotImplementedError("generateCompliantDescription");
}

export async function regenerateMainImage(
  _essence: ProductEssence,
): Promise<string> {
  throw new NotImplementedError("regenerateMainImage");
}

export async function runComplianceGate(_generated: {
  title: string;
  bullets: string[];
  description: string;
  main_image_url: string;
  brand: string;
  browse_node: string;
}): Promise<{ decision: "CAN_PUBLISH" | "BLOCKED"; reasons: string[] }> {
  throw new NotImplementedError("runComplianceGate");
}

export async function spApiPatchListing(
  _account: string,
  _sku: string,
  _generated: {
    title: string;
    bullets: string[];
    description: string;
    main_image_url: string;
  },
): Promise<unknown> {
  throw new NotImplementedError("spApiPatchListing");
}

/**
 * Phase 2.0a remediation orchestrator (skeleton).
 *
 * Today: creates a ListingRemediation row with status='manual_review',
 * flips ListingAuditResult.remediation_status = MANUAL_REVIEW, returns
 * the id. The /api/bundle-factory/audit/remediate POST endpoint calls
 * directly into prisma for the bulk path; this function exists for the
 * Phase 2.1+ automated path where additional stages will be wired in
 * sequentially below the manual-review branch.
 */
export async function remediateListing(
  auditResultId: string,
  mode: "manual_review" | "auto" = "manual_review",
): Promise<{ id: string; status: string }> {
  const audit = await prisma.listingAuditResult.findUniqueOrThrow({
    where: { id: auditResultId },
    include: { remediation: true },
  });
  if (audit.remediation) {
    return { id: audit.remediation.id, status: audit.remediation.status };
  }

  if (mode === "manual_review") {
    const rem = await prisma.listingRemediation.create({
      data: {
        audit_result_id: audit.id,
        status: "manual_review",
        original_title: audit.title,
        original_bullets: audit.original_bullets,
        original_description: audit.original_description,
        original_image_url: audit.main_image_url,
      },
    });
    await prisma.listingAuditResult.update({
      where: { id: audit.id },
      data: { remediation_status: "MANUAL_REVIEW" },
    });
    return { id: rem.id, status: rem.status };
  }

  // Phase 2.1+ auto path. The stubs above will be implemented as each
  // Bundle Factory stage comes online; the orchestration order is
  // already settled (see file header).
  throw new NotImplementedError("auto remediation");
}
