import { veeqoFetch } from "@/lib/veeqo/client";
import { getOrderTagNames, PROCUREMENT_TAGS } from "@/lib/veeqo/tags";
import { getInternalNotes } from "@/lib/veeqo/notes";
import {
  parseProcurementBlock,
  serializeProcurementBlock,
  replaceProcurementBlockInNotes,
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

/** Short, human-readable name to put inside the [PROCUREMENT] block line. */
function shortNameFor(li: NonNullable<VeeqoOrder["line_items"]>[number]): string {
  const sellable = li.sellable ?? {};
  const product = sellable.product ?? {};
  const raw =
    product.title ?? product.name ?? sellable.title ?? `li-${li.id ?? "?"}`;
  // Trim long titles so the block stays readable in Veeqo.
  return raw.length > 40 ? raw.slice(0, 37).trimEnd() + "…" : raw;
}

/**
 * Apply a procurement action to an order and persist it back to Veeqo
 * in a SINGLE PUT (notes + tag_list together). Returns the new in-app
 * status of the line item so the UI can reconcile optimistic state.
 *
 * The caller (an API route) is expected to authenticate the request.
 */
export async function applyProcurementAction(
  orderId: string,
  lineItemId: string,
  action: ProcurementAction
): Promise<{
  lineItemId: string;
  newStatus: LineItemStatus | null;
  orderTags: string[];
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
    // undo
    newStatuses.delete(lineItemId);
    newStatusForLine = null;
  }

  const newBlock: ProcurementBlock = { items: newStatuses };

  // Build a short-name lookup so the serialized block stays readable.
  const shortNames = new Map<string, string>();
  for (const li of lineItems) {
    const id = String(li.id ?? "");
    if (!id) continue;
    shortNames.set(id, shortNameFor(li));
  }

  const newBlockText = serializeProcurementBlock(newBlock, shortNames);
  const newNotes = replaceProcurementBlockInNotes(currentNotes, newBlockText);

  // --- 3. Decide the order-level tags -------------------------------------
  const { addPlaced, addNeedMore } = decideOrderTags(
    allLineItemIds,
    newStatuses
  );

  const currentTags = getOrderTagNames(order as never);
  // Strip our managed tags, then re-add based on the decision. Tags that
  // aren't ours (e.g. Заказано у Майка, canceled, channel-specific tags
  // Vladimir set manually) are preserved.
  const preserved = currentTags.filter(
    (t) => t !== PROCUREMENT_TAGS.PLACED && t !== PROCUREMENT_TAGS.NEED_MORE
  );
  const newTags = [...preserved];
  if (addPlaced) newTags.push(PROCUREMENT_TAGS.PLACED);
  if (addNeedMore) newTags.push(PROCUREMENT_TAGS.NEED_MORE);

  // --- 4. Persist to Veeqo (single PUT) -----------------------------------
  // We send notes + tag_list in one call so the order can't be left half-
  // updated. If Veeqo rejects one of the fields, the whole update fails
  // and the caller sees the underlying error.
  await veeqoFetch(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      order: {
        tag_list: newTags,
        employee_notes: newNotes,
      },
    }),
  });

  return {
    lineItemId,
    newStatus: newStatusForLine,
    orderTags: newTags,
  };
}
