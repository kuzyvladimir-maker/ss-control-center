import { veeqoFetch } from "@/lib/veeqo/client";
import {
  getOrderTags,
  PROCUREMENT_TAGS,
  colourFor,
  type OrderTag,
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
 * Build the `tags_attributes` array for a Rails-style nested-attributes PUT.
 *
 * For each tag the order ENDS UP with:
 *   - if it was already on the order with a known id → we let it be (don't include)
 *   - if it's new → include `{ name, colour }` to add it
 * For each managed tag the order CURRENTLY has but should NOT have:
 *   - include `{ id, _destroy: true }` so Rails removes it
 *
 * Non-managed tags (canceled, Заказано у Майка, channel-set tags, etc.) are
 * left untouched.
 */
function buildTagsAttributes(
  current: ReadonlyArray<OrderTag>,
  desiredManagedSet: ReadonlySet<string>
): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];

  // Destroy managed tags that are present but not desired
  for (const t of current) {
    if (!MANAGED_TAGS.includes(t.name)) continue; // not managed by us
    if (desiredManagedSet.has(t.name)) continue; // keep it
    if (t.id == null) continue; // can't destroy without id
    ops.push({ id: t.id, _destroy: true });
  }

  // Add managed tags that aren't already on the order
  const currentNames = new Set(current.map((t) => t.name));
  for (const name of desiredManagedSet) {
    if (currentNames.has(name)) continue;
    ops.push({ name, colour: colourFor(name) });
  }

  return ops;
}

/**
 * Apply a procurement action to an order and persist it back to Veeqo.
 *
 * The Veeqo PUT format we use here mirrors what `setProductTag()` and
 * `addEmployeeNote()` already do successfully in this codebase — Rails
 * nested-attributes shape:
 *   {
 *     order: {
 *       tags_attributes: [
 *         { id: 123, _destroy: true },     // remove existing managed tag
 *         { name: "Need More", colour: "yellow" }  // add new
 *       ],
 *       employee_notes_attributes: [
 *         { text: "[PROCUREMENT]\n…\n[/PROCUREMENT]" }  // append a note
 *       ]
 *     }
 *   }
 *
 * Notes are append-only: each action adds a new employee_note record.
 * The parser later reads the LAST [PROCUREMENT] block found in the
 * combined notes (multiple blocks accumulate as Vladimir takes more
 * actions on the same order — most recent wins).
 */
export async function applyProcurementAction(
  orderId: string,
  lineItemId: string,
  action: ProcurementAction
): Promise<{
  lineItemId: string;
  newStatus: LineItemStatus | null;
  managedTags: string[];
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
  const tagsAttributes = buildTagsAttributes(currentTags, desiredManagedTags);

  // --- 4. Persist to Veeqo (single PUT, nested attributes) ----------------
  const orderPayload: Record<string, unknown> = {};
  if (tagsAttributes.length > 0) {
    orderPayload.tags_attributes = tagsAttributes;
  }
  if (newBlockText) {
    // APPEND a new note containing the latest [PROCUREMENT] state. The parser
    // picks the LAST block found in concatenated notes, so older blocks
    // become inert.
    orderPayload.employee_notes_attributes = [{ text: newBlockText }];
  } else if (currentNotes.includes("[PROCUREMENT]")) {
    // Undo to empty state — just append an empty marker so the latest block
    // is empty (parser returns no items).
    orderPayload.employee_notes_attributes = [
      { text: "[PROCUREMENT]\n[/PROCUREMENT]" },
    ];
  }

  let veeqoResponse: unknown = undefined;
  if (Object.keys(orderPayload).length > 0) {
    veeqoResponse = await veeqoFetch(`/orders/${orderId}`, {
      method: "PUT",
      body: JSON.stringify({ order: orderPayload }),
    });
  }

  return {
    lineItemId,
    newStatus: newStatusForLine,
    managedTags: Array.from(desiredManagedTags),
    veeqoResponse,
  };
}
