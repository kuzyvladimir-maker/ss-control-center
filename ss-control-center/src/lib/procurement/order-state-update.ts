import { veeqoFetch } from "@/lib/veeqo/client";
import {
  getOrderTags,
  PROCUREMENT_TAGS,
  bulkTagOrders,
  bulkUntagOrders,
  getTagId,
} from "@/lib/veeqo/tags";
import { getInternalNotes } from "@/lib/veeqo/notes";
import {
  parseProcurementBlock,
  serializeProcurementBlock,
  type LineItemStatus,
  type ProcurementBlock,
} from "@/lib/veeqo/procurement-notes-parser";
import { decideOrderTags } from "./multi-item-status";

export type ProcurementAction =
  | { kind: "bought" }
  | { kind: "partial"; remaining: number }
  | { kind: "undo" };

interface VeeqoOrder {
  id?: string | number;
  tags?: unknown;
  line_items?: Array<{
    id?: string | number;
    sellable?: { title?: string; product?: { title?: string; name?: string } };
  }>;
  [k: string]: unknown;
}

const MANAGED_TAGS: ReadonlyArray<string> = [
  PROCUREMENT_TAGS.PLACED,
  PROCUREMENT_TAGS.NEED_MORE,
];

/** Short, human-readable name to put inside the [PROCUREMENT] block line. */
function shortNameFor(li: NonNullable<VeeqoOrder["line_items"]>[number]): string {
  const sellable = li.sellable ?? {};
  const product = sellable.product ?? {};
  const raw =
    product.title ?? product.name ?? sellable.title ?? `li-${li.id ?? "?"}`;
  return raw.length > 40 ? raw.slice(0, 37).trimEnd() + "…" : raw;
}

/**
 * Apply a procurement action to an order and persist it back to Veeqo.
 *
 * Two side effects, sent as separate API calls because Veeqo handles them
 * via different endpoints:
 *
 *   1. employee_notes — appended via PUT /orders/{id} with the Rails
 *      nested-attributes shape:
 *        { order: { employee_notes_attributes: [{ text: "[PROCUREMENT]…" }] } }
 *      Notes are append-only; the parser picks the LAST [PROCUREMENT] block.
 *
 *   2. tags — POST/DELETE /bulk_tagging with { order_ids, tag_ids }.
 *      tags_attributes / tag_list / etc. on /orders/{id} return 200 but
 *      silently no-op (verified empirically — see docs/wiki/veeqo-quirks.md).
 *      The /bulk_tagging endpoint is the only working path for adding /
 *      removing tags on existing orders.
 */
export async function applyProcurementAction(
  orderId: string,
  lineItemId: string,
  action: ProcurementAction
): Promise<{
  lineItemId: string;
  newStatus: LineItemStatus | null;
  managedTags: string[];
  tagsVerified: boolean;
  veeqoResponse?: unknown;
}> {
  // --- 1. Fetch current order state ---------------------------------------
  const order = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrder;
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const allLineItemIds = lineItems
    .map((li) => String(li.id ?? ""))
    .filter(Boolean);

  if (!allLineItemIds.includes(lineItemId)) {
    throw new Error(
      `Line item ${lineItemId} not found on order ${orderId}`
    );
  }

  const currentNotes = getInternalNotes(order as Record<string, unknown>);
  const block = parseProcurementBlock(currentNotes);

  // --- 2. Mutate the [PROCUREMENT] block for this line --------------------
  const newStatuses = new Map(block.items);
  let newStatusForLine: LineItemStatus | null;

  if (action.kind === "bought") {
    newStatusForLine = { kind: "bought" };
    newStatuses.set(lineItemId, newStatusForLine);
  } else if (action.kind === "partial") {
    if (
      !Number.isFinite(action.remaining) ||
      action.remaining <= 0 ||
      !Number.isInteger(action.remaining)
    ) {
      throw new Error("partial.remaining must be a positive integer");
    }
    newStatusForLine = { kind: "remain", remaining: action.remaining };
    newStatuses.set(lineItemId, newStatusForLine);
  } else {
    newStatuses.delete(lineItemId);
    newStatusForLine = null;
  }

  const newBlock: ProcurementBlock = { items: newStatuses };

  const shortNames = new Map<string, string>();
  for (const li of lineItems) {
    const id = String(li.id ?? "");
    if (!id) continue;
    shortNames.set(id, shortNameFor(li));
  }

  const newBlockText = serializeProcurementBlock(newBlock, shortNames);

  // --- 3. Decide the order-level managed tags -----------------------------
  const { addPlaced, addNeedMore } = decideOrderTags(
    allLineItemIds,
    newStatuses
  );
  const desiredManagedTags = new Set<string>();
  if (addPlaced) desiredManagedTags.add(PROCUREMENT_TAGS.PLACED);
  if (addNeedMore) desiredManagedTags.add(PROCUREMENT_TAGS.NEED_MORE);

  const currentTags = getOrderTags(order as never);
  const currentManaged = new Set(
    currentTags
      .filter((t) => MANAGED_TAGS.includes(t.name))
      .map((t) => t.name)
  );
  const tagsToAdd: string[] = [];
  const tagsToRemove: string[] = [];
  for (const name of desiredManagedTags) {
    if (!currentManaged.has(name)) tagsToAdd.push(name);
  }
  for (const name of currentManaged) {
    if (!desiredManagedTags.has(name)) tagsToRemove.push(name);
  }

  // --- 4. Persist notes (PUT /orders/{id}) --------------------------------
  const notesPayload: Record<string, unknown> = {};
  if (newBlockText) {
    // APPEND a new note containing the latest [PROCUREMENT] state. The parser
    // picks the LAST block found in concatenated notes, so older blocks
    // become inert.
    notesPayload.employee_notes_attributes = [{ text: newBlockText }];
  } else if (currentNotes.includes("[PROCUREMENT]")) {
    // Undo to empty state — just append an empty marker so the latest block
    // is empty (parser returns no items).
    notesPayload.employee_notes_attributes = [
      { text: "[PROCUREMENT]\n[/PROCUREMENT]" },
    ];
  }

  let veeqoResponse: unknown = undefined;
  if (Object.keys(notesPayload).length > 0) {
    veeqoResponse = await veeqoFetch(`/orders/${orderId}`, {
      method: "PUT",
      body: JSON.stringify({ order: notesPayload }),
    });
  }

  // --- 5. Persist managed tags via /bulk_tagging --------------------------
  // Resolve names to ids. If a tag doesn't exist in Veeqo yet we silently
  // skip (rather than fail the whole action) — the notes block is the
  // source of truth, the tag is just visual sugar.
  if (tagsToAdd.length > 0) {
    const ids: number[] = [];
    for (const name of tagsToAdd) {
      const id = await getTagId(name);
      if (id != null) ids.push(id);
    }
    if (ids.length > 0) await bulkTagOrders([orderId], ids);
  }
  if (tagsToRemove.length > 0) {
    const ids: number[] = [];
    for (const name of tagsToRemove) {
      const id = await getTagId(name);
      if (id != null) ids.push(id);
    }
    if (ids.length > 0) await bulkUntagOrders([orderId], ids);
  }

  // --- 6. Verify the tags actually landed --------------------------------
  // Veeqo has answered /bulk_tagging with 200 while the tag never appeared
  // (2026-10-19: four orders vanished from Procurement yet sat at "Waiting
  // for procurement" on Shipping). Re-read, re-apply the missing part once,
  // and report. Shipping no longer depends on the tag alone — it reads the
  // notes too (src/lib/procurement/placed.ts) — so a residual mismatch is
  // logged, not thrown.
  let tagsVerified = true;
  if (tagsToAdd.length > 0 || tagsToRemove.length > 0) {
    tagsVerified = await verifyManagedTags(orderId, desiredManagedTags);
  }

  return {
    lineItemId,
    newStatus: newStatusForLine,
    managedTags: Array.from(desiredManagedTags),
    tagsVerified,
    veeqoResponse,
  };
}

function managedDiff(
  order: VeeqoOrder,
  desired: ReadonlySet<string>,
): { add: string[]; remove: string[] } {
  const present = new Set(
    getOrderTags(order as never)
      .map((t) => t.name)
      .filter((n) => MANAGED_TAGS.includes(n)),
  );
  return {
    add: [...desired].filter((n) => !present.has(n)),
    remove: [...present].filter((n) => !desired.has(n)),
  };
}

async function tagIdsFor(names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const id = await getTagId(name);
    if (id != null) ids.push(id);
  }
  return ids;
}

/** Re-read the order; if the managed tags differ from `desired`, re-apply
 *  the difference once and re-check. Never throws — returns whether the
 *  order ended up with exactly the desired managed tags. */
async function verifyManagedTags(
  orderId: string,
  desired: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const first = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrder;
    const diff = managedDiff(first, desired);
    if (diff.add.length === 0 && diff.remove.length === 0) return true;

    console.warn("[procurement] tag did not land, re-applying", {
      orderId,
      ...diff,
    });
    const addIds = await tagIdsFor(diff.add);
    if (addIds.length > 0) await bulkTagOrders([orderId], addIds);
    const removeIds = await tagIdsFor(diff.remove);
    if (removeIds.length > 0) await bulkUntagOrders([orderId], removeIds);

    await new Promise((r) => setTimeout(r, 1000));
    const second = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrder;
    const left = managedDiff(second, desired);
    const ok = left.add.length === 0 && left.remove.length === 0;
    if (!ok) {
      console.error("[procurement] tag still missing after retry", {
        orderId,
        ...left,
      });
    }
    return ok;
  } catch (e) {
    console.error("[procurement] tag verification failed", {
      orderId,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
