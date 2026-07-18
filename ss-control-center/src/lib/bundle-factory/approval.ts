/** Explicit human approval gate for real marketplace distribution. */

import { prisma } from "@/lib/prisma";
import { logLifecycle } from "./lifecycle-log";
import { INVENTORY_MAX_AGE_MS } from "./inventory-policy";

export async function approveDraftForDistribution(input: {
  draftId: string;
  actor: string;
  note?: string;
}): Promise<void> {
  const draft = await prisma.bundleDraft.findUnique({
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
  if (!draft.master_bundle_id) throw new Error("Draft has no promoted MasterBundle");
  const hasReusableApproval =
    draft.approved_at != null &&
    ["APPROVED", "PUBLISHING", "PUBLISHED", "ERROR"].includes(draft.status);
  if (draft.status !== "VALIDATED" && !hasReusableApproval) {
    throw new Error(
      `Draft must be VALIDATED before approval (current=${draft.status})`,
    );
  }
  const [total, passed] = await Promise.all([
    prisma.channelSKU.count({
      where: { master_bundle_id: draft.master_bundle_id },
    }),
    prisma.channelSKU.count({
      where: {
        master_bundle_id: draft.master_bundle_id,
        validation_status: "PASSED",
        available_quantity: { gt: 0 },
        inventory_checked_at: {
          gte: new Date(Date.now() - INVENTORY_MAX_AGE_MS),
        },
      },
    }),
  ]);
  if (total === 0 || passed !== total) {
    throw new Error(
      `Approval blocked: ${passed}/${total} ChannelSKUs are PASSED with positive inventory verified within the last ${INVENTORY_MAX_AGE_MS / 60_000} minutes`,
    );
  }

  const approvedAt = new Date();
  let firstApproval = false;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.bundleDraft.updateMany({
      where: { id: draft.id, approved_at: null },
      data: {
        status: "APPROVED",
        approved_at: approvedAt,
        approved_by: input.actor,
        approval_notes: input.note?.trim() || null,
      },
    });
    firstApproval = claimed.count > 0;
    if (!firstApproval) {
      // Reusing an approval is allowed only for an unchanged draft. Update the
      // operator note without touching the original approval timestamp.
      await tx.bundleDraft.update({
        where: { id: draft.id },
        data: {
          approved_by: input.actor,
          approval_notes: input.note?.trim() || null,
        },
      });
    } else {
      await tx.generationJob.update({
        where: { id: draft.generation_job_id },
        data: { bundles_approved: { increment: 1 } },
      });
      await tx.masterBundle.update({
        where: { id: draft.master_bundle_id! },
        data: { lifecycle_status: "APPROVED" },
      });
      await tx.channelSKU.updateMany({
        where: { master_bundle_id: draft.master_bundle_id! },
        data: { lifecycle_status: "APPROVED" },
      });
    }
  });

  await logLifecycle({
    entity_type: "BundleDraft",
    entity_id: draft.id,
    from_status: draft.status,
    to_status: firstApproval ? "APPROVED" : draft.status,
    reason: firstApproval
      ? `Operator approved ${passed} fully-passed ChannelSKU(s) for distribution`
      : `Operator reconfirmed the existing approval for ${passed} unchanged ChannelSKU(s)`,
    actor: input.actor,
  });
}
