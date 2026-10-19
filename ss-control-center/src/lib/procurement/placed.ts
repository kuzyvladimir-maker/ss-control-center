import { getInternalNotes } from "@/lib/veeqo/notes";
import { parseProcurementBlock } from "@/lib/veeqo/procurement-notes-parser";
import { PROCUREMENT_TAGS } from "@/lib/veeqo/tags";
import { decideOrderTags } from "./multi-item-status";

/**
 * Single definition of "procurement is done for this order", shared by
 * Procurement and Shipping Labels.
 *
 * Two signals, either one is enough:
 *   - "tag"   — the Veeqo `Placed` tag (set by Procurement, by the Mark as
 *               Placed button, or by hand in the Veeqo UI);
 *   - "notes" — the [PROCUREMENT] block in employee_notes marks EVERY line
 *               item `bought`.
 *
 * Why both: Procurement hides a line as soon as the notes say `bought`
 * (the notes are its source of truth), while Shipping used to look at the
 * tag only. Veeqo sometimes answers the tag call 200 yet the tag never
 * lands, so the order dropped into a blind spot — gone from Procurement,
 * stuck at "Waiting for procurement" on Shipping (owner report 2026-10-19,
 * four orders at once). Reading the same notes here closes that gap.
 */
export type PlacedSource = "tag" | "notes" | null;

interface OrderLike {
  tags?: unknown;
  line_items?: Array<{ id?: string | number | null }> | null;
  employee_notes?: unknown;
  internal_notes?: unknown;
  notes?: unknown;
}

function hasPlacedTag(order: OrderLike): boolean {
  const tags = Array.isArray(order.tags) ? order.tags : [];
  return tags.some((t) => {
    const name = typeof t === "string" ? t : (t as { name?: unknown })?.name;
    return (
      String(name ?? "").toLowerCase() === PROCUREMENT_TAGS.PLACED.toLowerCase()
    );
  });
}

/** True when the [PROCUREMENT] notes block marks every line item bought. */
export function allLinesBoughtInNotes(order: OrderLike): boolean {
  const ids = (order.line_items ?? [])
    .map((li) => String(li?.id ?? ""))
    .filter(Boolean);
  if (ids.length === 0) return false;
  const block = parseProcurementBlock(
    getInternalNotes(order as Record<string, unknown>),
  );
  return decideOrderTags(ids, block.items).addPlaced;
}

export function procurementPlacedSource(
  order: OrderLike | null | undefined,
): PlacedSource {
  if (!order) return null;
  if (hasPlacedTag(order)) return "tag";
  if (allLinesBoughtInNotes(order)) return "notes";
  return null;
}

export function isProcurementPlaced(
  order: OrderLike | null | undefined,
): boolean {
  return procurementPlacedSource(order) !== null;
}
