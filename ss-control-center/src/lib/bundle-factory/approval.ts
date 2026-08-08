/** Explicit human approval gate for real marketplace distribution. */

import { prisma } from "@/lib/prisma";
import { TURSO_TRANSACTION_OPTIONS } from "./turso-transaction";
import { logLifecycle } from "./lifecycle-log";
import { INVENTORY_MAX_AGE_MS } from "./inventory-policy";
import {
  assertValidWalmartDistributionApproval,
  sealWalmartDistributionApproval,
} from "./walmart-listing-contract";
import { buildWalmartPayload } from "./distribution/walmart-publish";
import { hashWalmartPayload } from "./distribution/walmart-publish-lifecycle";
import { parseVerifiedPhysicalPackageSpecs } from "./physical-package-specs";

export async function approveDraftForDistribution(input: {
  draftId: string;
  actor: string;
  note?: string;
}): Promise<void> {
  const actor = input.actor.trim();
  if (!actor) throw new Error("Approval actor is required");
  const approvedAt = new Date();
  const inventoryCutoff = new Date(approvedAt.getTime() - INVENTORY_MAX_AGE_MS);
  const result = await prisma.$transaction(async (tx) => {
    // Re-read every approval input inside the same transaction that persists
    // the seal. Counts taken before this point are vulnerable to validation,
    // inventory, content, or approval drift.
    const draft = await tx.bundleDraft.findUnique({
      where: { id: input.draftId },
      select: {
        id: true,
        status: true,
        approved_at: true,
        generation_job_id: true,
        master_bundle_id: true,
      },
    });
    if (!draft) throw new Error(`BundleDraft ${input.draftId} not found`);
    if (!draft.master_bundle_id) {
      throw new Error("Draft has no promoted MasterBundle");
    }
    const hasReusableApproval =
      draft.approved_at != null &&
      ["APPROVED", "PUBLISHING", "PUBLISHED", "ERROR"].includes(draft.status);
    if (draft.status !== "VALIDATED" && !hasReusableApproval) {
      throw new Error(
        `Draft must be VALIDATED before approval (current=${draft.status})`,
      );
    }

    const skus = await tx.channelSKU.findMany({
      where: { master_bundle_id: draft.master_bundle_id },
    });
    const masterBundle = await tx.masterBundle.findUnique({
      where: { id: draft.master_bundle_id },
      select: { brand: true, pack_count: true, packaging_spec: true },
    });
    if (!masterBundle) throw new Error("Draft MasterBundle does not exist");
    const physicalPackageSpecs = parseVerifiedPhysicalPackageSpecs(
      masterBundle.packaging_spec,
    );
    if (!physicalPackageSpecs) {
      throw new Error("Verified physical package proof is missing");
    }
    const passed = skus.filter(
      (sku) =>
        sku.validation_status === "PASSED" &&
        (sku.available_quantity ?? 0) > 0 &&
        sku.inventory_checked_at != null &&
        sku.inventory_checked_at >= inventoryCutoff,
    ).length;
    if (skus.length === 0 || passed !== skus.length) {
      throw new Error(
        `Approval blocked: ${passed}/${skus.length} ChannelSKUs are PASSED with positive inventory verified within the last ${INVENTORY_MAX_AGE_MS / 60_000} minutes`,
      );
    }

    if (hasReusableApproval) {
      // Reuse is permitted only while every Walmart approval still binds the
      // current payload, Product Truth/prepublication evidence, and validation
      // run. Preserve the original approver and timestamp.
      //
      // A listing that was RE-PROMOTED since it was approved has no seal at
      // all: promotion rewrites the attributes and the seal lives in them.
      // Treating that as "already approved" left an approved draft whose
      // listing could never be published — every publish refused with
      // "distribution approval is missing or unsupported", and re-approving
      // changed nothing because this branch skipped sealing (found on the first
      // live batch, 2026-08-08). A missing seal is re-sealed here against the
      // current payload and validation run; a seal that exists must still match.
      for (const sku of skus) {
        if (sku.channel !== "WALMART") continue;
        const payloadHash = hashWalmartPayload(
          buildWalmartPayload(sku, {
            brand: masterBundle.brand,
            packCount: masterBundle.pack_count,
            physicalPackageSpecs,
          }),
        );
        let approval: ReturnType<typeof assertValidWalmartDistributionApproval> | null = null;
        try {
          approval = assertValidWalmartDistributionApproval(sku);
        } catch {
          approval = null;
        }
        if (approval) {
          if (payloadHash !== approval.marketplace_payload_sha256) {
            throw new Error("Walmart marketplace payload changed after approval");
          }
          continue;
        }
        const resealed = sealWalmartDistributionApproval({
          sku,
          approvedAt,
          approvedBy: actor,
          validationRunId: sku.validation_check_id ?? "",
          marketplacePayloadSha256: payloadHash,
        });
        await tx.channelSKU.update({
          where: { id: sku.id },
          data: { attributes: resealed.attributes },
        });
      }
      await tx.bundleDraft.update({
        where: { id: draft.id },
        data:
          input.note === undefined
            ? {}
            : { approval_notes: input.note.trim() || null },
      });
      return {
        draftId: draft.id,
        fromStatus: draft.status,
        firstApproval: false,
        passed,
      };
    }

    // Persist every Walmart payload/current-validation-bound seal before any
    // entity is allowed to enter APPROVED. A failure rolls back the transaction.
    for (const sku of skus) {
      if (sku.channel !== "WALMART") continue;
      const sealed = sealWalmartDistributionApproval({
        sku,
        approvedAt,
        approvedBy: actor,
        validationRunId: sku.validation_check_id ?? "",
        marketplacePayloadSha256: hashWalmartPayload(
          buildWalmartPayload(sku, {
            brand: masterBundle.brand,
            packCount: masterBundle.pack_count,
            physicalPackageSpecs,
          }),
        ),
      });
      await tx.channelSKU.update({
        where: { id: sku.id },
        data: { attributes: sealed.attributes },
      });
    }

    await tx.generationJob.update({
      where: { id: draft.generation_job_id },
      data: { bundles_approved: { increment: 1 } },
    });
    await tx.masterBundle.update({
      where: { id: draft.master_bundle_id },
      data: { lifecycle_status: "APPROVED" },
    });
    await tx.channelSKU.updateMany({
      where: { master_bundle_id: draft.master_bundle_id },
      data: { lifecycle_status: "APPROVED" },
    });
    const claimed = await tx.bundleDraft.updateMany({
      where: { id: draft.id, status: "VALIDATED", approved_at: null },
      data: {
        status: "APPROVED",
        approved_at: approvedAt,
        approved_by: actor,
        approval_notes: input.note?.trim() || null,
      },
    });
    if (claimed.count !== 1) {
      throw new Error("Draft approval changed concurrently; retry from fresh state");
    }
    return {
      draftId: draft.id,
      fromStatus: draft.status,
      firstApproval: true,
      passed,
    };
  }, TURSO_TRANSACTION_OPTIONS);

  await logLifecycle({
    entity_type: "BundleDraft",
    entity_id: result.draftId,
    from_status: result.fromStatus,
    to_status: result.firstApproval ? "APPROVED" : result.fromStatus,
    reason: result.firstApproval
      ? `Operator approved ${result.passed} fully-passed ChannelSKU(s) for distribution`
      : `Operator reconfirmed the existing approval for ${result.passed} unchanged ChannelSKU(s)`,
    actor,
  });
}
