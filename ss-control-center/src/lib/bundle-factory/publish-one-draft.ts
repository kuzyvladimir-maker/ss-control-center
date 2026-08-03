/**
 * Publishing one draft to a marketplace — the single implementation.
 *
 * Both callers use this: the Publish button on a draft row, and the server-side
 * publish queue that drains a selected batch. They MUST NOT drift apart. A
 * queue that reimplements the sequence is a queue that quietly skips a gate,
 * and the gates here are the ones that keep a wrong product off a live shelf.
 *
 * The sequence and the reason each step exists:
 *
 *   1. PROMOTE   — mint the ChannelSKU and reserve a pool UPC. Idempotent.
 *   2. VALIDATE  — promotion re-syncs content onto the SKU and resets its
 *                  validation, so what ships is exactly what just passed.
 *   3. APPROVE   — records the operator decision the distribution step demands.
 *   4. DISTRIBUTE— the marketplace POST, behind MarketplaceSubmissionAttempt.
 *
 * Steps 1-3 are local database work: a locked database is a write that did not
 * happen, so they are retried on SQLITE_BUSY. Step 4 is never retried here —
 * an unknown POST result is resolved by reading, never by sending again
 * (AGENTS.md §7).
 */

import { runDistribution } from "@/lib/bundle-factory/distribution/distribution-pipeline";
import { approveDraftForDistribution } from "@/lib/bundle-factory/approval";
import { promoteDraftToChannelSkus } from "@/lib/bundle-factory/validation/promote-draft";
import { runValidationForDraft } from "@/lib/bundle-factory/validation/validation-pipeline";
import { withSqliteBusyRetry } from "@/lib/bundle-factory/sqlite-busy-retry";
import { WALMART_STUDIO_LISTING_ATTRIBUTE_KEY } from "@/lib/bundle-factory/walmart-studio-listing";
import type {
  WalmartShippingAssociationExpectation,
} from "@/lib/bundle-factory/walmart-shipping-template-association";
import { prisma } from "@/lib/prisma";

/**
 * The exact shipping-template association this draft's Walmart listing sells
 * under, read from the listing's own sealed evidence.
 *
 * Returns null when the draft has no Walmart listing at all — an Amazon-only
 * draft must not be given a Walmart association. A Walmart listing that is
 * missing the fields fails loudly instead: publishing it would either be
 * refused at the marketplace fence anyway, or worse, go out under a template
 * the price was never computed against.
 */
async function resolveWalmartShippingAssociation(
  draftId: string,
): Promise<WalmartShippingAssociationExpectation | null> {
  const draft = await prisma.bundleDraft.findUnique({
    where: { id: draftId },
    select: { master_bundle_id: true },
  });
  if (!draft?.master_bundle_id) return null;

  const sku = await prisma.channelSKU.findFirst({
    where: { master_bundle_id: draft.master_bundle_id, channel: "WALMART" },
    select: { sku: true, attributes: true },
  });
  if (!sku) return null;

  const evidence = (() => {
    try {
      const parsed = JSON.parse(sku.attributes ?? "{}") as Record<string, unknown>;
      const listing = parsed[WALMART_STUDIO_LISTING_ATTRIBUTE_KEY] as
        | { offer?: { shipping_template_id?: unknown; fulfillment_center_id?: unknown } }
        | undefined;
      return listing?.offer ?? null;
    } catch {
      return null;
    }
  })();

  const templateId = typeof evidence?.shipping_template_id === "string"
    ? evidence.shipping_template_id.trim()
    : "";
  const fulfillmentCenterId = typeof evidence?.fulfillment_center_id === "string"
    ? evidence.fulfillment_center_id.trim()
    : "";

  if (!templateId || !fulfillmentCenterId) {
    throw new Error(
      `Walmart listing ${sku.sku} has no sealed shipping template or ship node, `
        + "so it cannot be published. Re-run its build so the template it was "
        + "priced against is recorded.",
    );
  }

  return {
    sku: sku.sku,
    shipping_template_id: templateId,
    fulfillment_center_id: fulfillmentCenterId,
  };
}

/** Which step refused. Callers map this onto an HTTP status or a queue state. */
export type PublishDraftStage =
  | "PROMOTE"
  | "VALIDATE"
  | "APPROVE"
  | "DISTRIBUTE";

export interface PublishOneDraftInput {
  draftId: string;
  /** Restrict to these channels; omitted means every channel on the draft. */
  channels?: string[];
  actor: string;
  /**
   * False performs no marketplace write at all — the dry run that proves the
   * payload is acceptable. Real publishing must pass true explicitly.
   */
  apply: boolean;
  approvalNote?: string;
  /**
   * Runs immediately before the marketplace write, and only on a real publish.
   *
   * The publish queue uses this to durably mark the item as posted BEFORE the
   * POST leaves. If the process dies mid-flight, that mark is what stops the
   * item from ever being sent a second time. Marking afterwards would be a
   * guess dressed up as a record.
   */
  beforeDistribute?: () => void | Promise<void>;
}

export type PublishOneDraftResult =
  | {
    ok: false;
    stage: "PROMOTE";
    error: string;
    skipped: unknown;
  }
  | {
    ok: false;
    stage: "VALIDATE";
    error: string;
    failures: Array<{ channel: string; status: string; failed: unknown }>;
    promotion: unknown;
  }
  | {
    ok: boolean;
    stage: "DISTRIBUTE";
    /** The feed/submission identifier, when the marketplace returned one. */
    submissionId: string | null;
    error: string | null;
    distribution: Awaited<ReturnType<typeof runDistribution>>;
    promotion: unknown;
    validation: unknown;
  };

/**
 * Run one draft through promote → validate → approve → distribute.
 *
 * Throws only on genuinely unexpected failures; an expected refusal (nothing to
 * promote, validation did not pass) comes back as `ok: false` with the stage
 * that refused, so the caller can report it precisely.
 */
export async function publishOneDraft(
  input: PublishOneDraftInput,
): Promise<PublishOneDraftResult> {
  const { draftId, channels, actor, apply } = input;

  const draftRow = await prisma.bundleDraft.findUnique({
    where: { id: draftId },
    select: { master_bundle_id: true },
  });
  if (!draftRow) {
    return {
      ok: false,
      stage: "PROMOTE",
      error: "Draft not found",
      skipped: [],
    };
  }

  // Always promote: the call is idempotent (it skips channels that already have
  // a SKU). Keying off master_bundle_id alone was wrong — a draft can hold a
  // MasterBundle from an earlier attempt whose content never passed compliance,
  // so no ChannelSKU was ever minted and publishing had nothing to act on.
  const promotion = await withSqliteBusyRetry(
    "publish:promote",
    () => promoteDraftToChannelSkus(draftId),
  );
  if (!promotion.master_bundle_id) {
    return {
      ok: false,
      stage: "PROMOTE",
      error: "This draft could not be promoted into a publishable SKU.",
      skipped: promotion.skipped,
    };
  }

  const validation = await withSqliteBusyRetry(
    "publish:validate",
    () => runValidationForDraft({
      bundle_draft_id: draftId,
      ...(channels ? { channels } : {}),
      actor,
    }),
  );
  const unvalidated = validation.per_sku.filter(
    (entry) => entry.status !== "PASSED",
  );
  if (apply && unvalidated.length > 0) {
    return {
      ok: false,
      stage: "VALIDATE",
      error: unvalidated.length === validation.per_sku.length
        ? "Validation did not pass, so nothing was published."
        : `${unvalidated.length} of ${validation.per_sku.length} listings did not pass validation; nothing was published.`,
      failures: unvalidated.map((entry) => ({
        channel: entry.channel,
        status: entry.status,
        failed: entry.failed,
      })),
      promotion,
    };
  }

  if (apply) {
    await withSqliteBusyRetry(
      "publish:approve",
      () => approveDraftForDistribution({
        draftId,
        actor,
        ...(input.approvalNote !== undefined
          ? { note: input.approvalNote }
          : {}),
      }),
    );
  }

  // Walmart refuses a real submission without the exact shipping-template
  // association, for the studio lane as much as the pilot. It is read from the
  // listing itself, where promotion recorded the template the build sealed and
  // priced against — asserting the same id the price was computed from is the
  // point, and inventing a default here would silently decouple the two.
  const shippingTemplateAssociation = apply
    ? await resolveWalmartShippingAssociation(draftId)
    : null;

  if (apply && input.beforeDistribute) {
    await input.beforeDistribute();
  }

  const distribution = await runDistribution({
    ...(shippingTemplateAssociation
      ? { walmartShippingTemplateAssociation: shippingTemplateAssociation }
      : {}),
    bundle_draft_id: draftId,
    ...(channels ? { channels } : {}),
    apply,
    // One listing at a time: each SKU is its own claim and its own feed POST,
    // so a failure stops at that SKU instead of poisoning a shared request.
    batchSize: 1,
    actor,
  });

  const submitted = distribution.per_sku.find((entry) => entry.submission_id);
  const failure = distribution.per_sku.find((entry) => entry.error);

  return {
    ok: distribution.ok,
    stage: "DISTRIBUTE",
    submissionId: submitted?.submission_id ?? null,
    error: failure?.error ?? null,
    distribution,
    promotion,
    validation,
  };
}
