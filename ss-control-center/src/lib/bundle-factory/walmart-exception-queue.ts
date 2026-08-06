/**
 * What went wrong, and nothing else.
 *
 * At eight listings the operator can read every row. At a thousand he cannot,
 * and a list that shows everything shows nothing: the two broken listings are
 * indistinguishable from the nine hundred and ninety-eight that are fine.
 *
 * So this computes exceptions — listings that need a person — from data the
 * platform already holds. No provider calls, no cost, no guessing: every case
 * below is a state we recorded ourselves.
 *
 * Deliberately NOT an exception: a listing Walmart is still processing. New
 * items take 60–90 minutes (measured), so "not live yet" is normal until it
 * isn't, and the threshold below is what separates the two.
 */

import { prisma } from "@/lib/prisma";

/** Past this, "still processing" stops being a reasonable explanation. */
export const WALMART_STUCK_AFTER_HOURS = 6;

export type WalmartExceptionKind =
  /** Walmart published it, but a buyer cannot buy it. */
  | "PUBLISHED_NOT_BUYABLE"
  /** Sent long ago and still not live. */
  | "STUCK_IN_PROCESSING"
  /** Walmart refused it. */
  | "REJECTED"
  /** Its product ID is dead; publishing again repeats the same refusal. */
  | "PRODUCT_ID_QUARANTINED"
  /** The POST left and its outcome is unknown — never retried, only read. */
  | "SUBMISSION_UNKNOWN";

export interface WalmartException {
  kind: WalmartExceptionKind;
  channelSkuId: string;
  sku: string;
  title: string;
  listingStatus: string;
  liveUrl: string | null;
  /** One sentence an operator can act on. */
  detail: string;
  /** Newest relevant timestamp, for ordering oldest-hurt-first. */
  since: Date;
}

export interface WalmartExceptionQueue {
  exceptions: WalmartException[];
  /** How many live listings were checked and found healthy. */
  healthy: number;
  /** Listings still inside the normal processing window. */
  processing: number;
  generatedAt: Date;
}

export async function buildWalmartExceptionQueue(
  now: Date = new Date(),
): Promise<WalmartExceptionQueue> {
  const stuckBefore = new Date(
    now.getTime() - WALMART_STUCK_AFTER_HOURS * 60 * 60 * 1000,
  );

  const skus = await prisma.channelSKU.findMany({
    where: { channel: "WALMART", lifecycle_status: { not: "DRAFT" } },
    select: {
      id: true,
      sku: true,
      upc: true,
      title: true,
      listing_status: true,
      live_url: true,
      submitted_at: true,
      published_at: true,
      updated_at: true,
      distribution_errors: true,
    },
  });
  if (skus.length === 0) {
    return { exceptions: [], healthy: 0, processing: 0, generatedAt: now };
  }

  // A product ID Walmart already gave to someone else can never publish.
  const quarantined = await prisma.uPCPool.findMany({
    where: { status: "QUARANTINED", upc: { in: skus.map((row) => row.upc) } },
    select: { upc: true, notes: true },
  });
  const quarantineByUpc = new Map(
    quarantined.map((row) => [row.upc, row.notes ?? ""]),
  );

  // The newest buyer-facing observation per listing.
  const evidence = await prisma.walmartBuyerPublicationEvidence.findMany({
    where: { channel_sku_id: { in: skus.map((row) => row.id) } },
    orderBy: { captured_at: "desc" },
    select: {
      channel_sku_id: true,
      captured_at: true,
      published: true,
      buyable: true,
    },
  });
  const latestEvidence = new Map<string, (typeof evidence)[number]>();
  for (const row of evidence) {
    if (!latestEvidence.has(row.channel_sku_id)) {
      latestEvidence.set(row.channel_sku_id, row);
    }
  }

  const exceptions: WalmartException[] = [];
  let healthy = 0;
  let processing = 0;

  for (const sku of skus) {
    const base = {
      channelSkuId: sku.id,
      sku: sku.sku,
      title: sku.title,
      listingStatus: sku.listing_status,
      liveUrl: sku.live_url,
    };

    const quarantineNote = quarantineByUpc.get(sku.upc);
    if (quarantineNote && !sku.live_url) {
      exceptions.push({
        ...base,
        kind: "PRODUCT_ID_QUARANTINED",
        detail:
          `Product ID ${sku.upc} is dead — ${quarantineNote.split("\n").at(-1) ?? "quarantined"}. `
          + "Replace it from the row; publishing again repeats the same refusal.",
        since: sku.updated_at,
      });
      continue;
    }

    if (sku.listing_status === "SUBMISSION_UNKNOWN") {
      exceptions.push({
        ...base,
        kind: "SUBMISSION_UNKNOWN",
        detail:
          "The submission left and its outcome is unknown. This is resolved by "
          + "reading Walmart, never by sending again.",
        since: sku.submitted_at ?? sku.updated_at,
      });
      continue;
    }

    if (sku.listing_status === "FAILED") {
      const first = firstDistributionError(sku.distribution_errors);
      exceptions.push({
        ...base,
        kind: "REJECTED",
        detail: first ?? "Walmart refused this listing.",
        since: sku.updated_at,
      });
      continue;
    }

    const observation = latestEvidence.get(sku.id);
    if (observation?.published && !observation.buyable) {
      // The worst kind: it looks live and cannot be bought, so it earns no
      // sales and nothing complains.
      exceptions.push({
        ...base,
        kind: "PUBLISHED_NOT_BUYABLE",
        detail:
          "Walmart shows the page but a buyer cannot add it to a cart. "
          + "Usually inventory or the shipping template.",
        since: observation.captured_at,
      });
      continue;
    }

    if (sku.live_url) {
      healthy += 1;
      continue;
    }

    const sentAt = sku.submitted_at ?? sku.updated_at;
    if (sentAt < stuckBefore) {
      exceptions.push({
        ...base,
        kind: "STUCK_IN_PROCESSING",
        detail:
          `Sent ${Math.round((now.getTime() - sentAt.getTime()) / 3_600_000)} h ago `
          + `and still not live; new items normally take under ${WALMART_STUCK_AFTER_HOURS} h.`,
        since: sentAt,
      });
      continue;
    }
    processing += 1;
  }

  // Oldest hurt first: a listing that has been broken for two days matters more
  // than one that broke ten minutes ago.
  exceptions.sort((left, right) => left.since.getTime() - right.since.getTime());
  return { exceptions, healthy, processing, generatedAt: now };
}

function firstDistributionError(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of list) {
      if (entry && typeof entry === "object") {
        const record = entry as { code?: unknown; message?: unknown };
        const message = typeof record.message === "string" ? record.message : null;
        if (message) {
          const code = typeof record.code === "string" ? `${record.code}: ` : "";
          return `${code}${message}`.slice(0, 300);
        }
      }
    }
    return null;
  } catch {
    return raw.slice(0, 300);
  }
}
