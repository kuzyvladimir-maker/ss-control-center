/**
 * Audit-trail writer for Bundle Factory pipeline state transitions.
 *
 * Persists into the existing `ListingLifecycleLog` table (Phase 1). The
 * table was originally scoped to MasterBundle / ChannelSKU only, but the
 * `entity_type` column is a free-form String so we extend it here to
 * track `BundleDraft` and `GenerationJob` transitions too. The
 * master_bundle / channel_sku relations are left null for those rows.
 *
 * `trigger` is the column name on the table for what the spec calls
 * "reason"; we keep `reason` in the public API for readability and map it
 * over at insert time.
 */

import { prisma } from "@/lib/prisma";

export type LifecycleEntityType =
  | "BundleDraft"
  | "MasterBundle"
  | "ChannelSKU"
  | "GenerationJob";

export interface LifecycleLogInput {
  entity_type: LifecycleEntityType;
  entity_id: string;
  from_status?: string | null;
  to_status: string;
  reason: string;
  actor?: string;
  details?: Record<string, unknown>;
}

export async function logLifecycle(input: LifecycleLogInput): Promise<void> {
  await prisma.listingLifecycleLog.create({
    data: {
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      // master_bundle_id / channel_sku_id wired only when the entity is
      // actually one of those — leaves the row clean for BundleDraft /
      // GenerationJob entries.
      master_bundle_id:
        input.entity_type === "MasterBundle" ? input.entity_id : null,
      channel_sku_id:
        input.entity_type === "ChannelSKU" ? input.entity_id : null,
      from_status: input.from_status ?? null,
      to_status: input.to_status,
      trigger: input.reason,
      details: input.details ? JSON.stringify(input.details) : null,
      user_id: input.actor ?? "system",
    },
  });
}
