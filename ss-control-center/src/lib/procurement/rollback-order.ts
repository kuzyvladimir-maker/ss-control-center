// Roll an order's procurement state back to "no line items bought".
//
// Used by the Rollback button on Shipping Labels when the supplier
// didn't actually bring the product — the operator needs the order to
// reappear in Procurement so they can buy it again.
//
// We deliberately do NOT touch the already-purchased shipping label
// (FedEx / Walmart) or Veeqo's `Label Purchased` employee note. The
// operator's plan is to use the existing label once the product is
// re-bought; cancelling the label would force a fresh purchase and
// burn ~$15-30 per row.
//
// Mechanism: walk every line item that currently has a [PROCUREMENT]
// status in employee_notes and call `applyProcurementAction` with
// `{ kind: "undo" }`. After the last undo, `decideOrderTags` returns
// `addPlaced=false`, so the same helper strips the `Placed` tag from
// the Veeqo order — that's what makes it disappear from Shipping Labels
// and reappear in Procurement.

import { veeqoFetch } from "@/lib/veeqo/client";
import { getInternalNotes } from "@/lib/veeqo/notes";
import { parseProcurementBlock } from "@/lib/veeqo/procurement-notes-parser";
import {
  PROCUREMENT_TAGS,
  removeTagFromOrder,
} from "@/lib/veeqo/tags";
import { applyProcurementAction } from "./order-state-update";

export interface RollbackResult {
  orderId: string;
  undoneLineItems: string[];
  strippedTags: string[];
}

interface MinimalOrder {
  line_items?: Array<{ id?: string | number }>;
  employee_notes?: unknown;
}

export async function rollbackOrderProcurement(
  orderId: string,
): Promise<RollbackResult> {
  const order = (await veeqoFetch(`/orders/${orderId}`)) as MinimalOrder;
  const notes = getInternalNotes(order as Record<string, unknown>);
  const block = parseProcurementBlock(notes);

  const undone: string[] = [];
  // Sequential — applyProcurementAction rewrites the order's
  // employee_notes block on every call, so running these in parallel
  // would cause lost-update races.
  for (const lineItemId of block.items.keys()) {
    await applyProcurementAction(orderId, lineItemId, { kind: "undo" });
    undone.push(lineItemId);
  }

  // Belt-and-braces tag cleanup. The undo loop above already strips
  // Placed / Need More when the [PROCUREMENT] block had entries.
  // But some orders end up with `Placed` set WITHOUT a procurement
  // block (legacy rows, manual tagging in the Veeqo UI, partial migrations
  // — Vladimir hit this on order 200014759829821). In that case the loop
  // is a no-op and the tag stayed put, keeping the order stuck in
  // Shipping Labels. Strip both tags explicitly here so rollback is
  // idempotent regardless of how the order got tagged.
  const strippedTags: string[] = [];
  for (const tag of [PROCUREMENT_TAGS.PLACED, PROCUREMENT_TAGS.NEED_MORE]) {
    try {
      await removeTagFromOrder(orderId, tag);
      strippedTags.push(tag);
    } catch {
      /* tag wasn't on the order — fine, nothing to remove */
    }
  }

  return { orderId, undoneLineItems: undone, strippedTags };
}
