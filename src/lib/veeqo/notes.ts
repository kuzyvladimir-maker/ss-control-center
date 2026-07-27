import { veeqoFetch } from "./client";

/**
 * Read internal notes from an order, regardless of which field name Veeqo
 * happens to populate in the response.
 *
 * Veeqo also returns an array of note records under `employee_notes` in some
 * API versions (each `{ text }`). We join their text in that case.
 *
 * The parameter is intentionally typed wide because Veeqo orders pass through
 * several places in this codebase under slightly different ad-hoc types.
 */
export function getInternalNotes(
  order: Record<string, unknown> | null | undefined
): string {
  if (!order) return "";

  const candidates: unknown[] = [
    order.employee_notes,
    order.internal_notes,
    order.notes,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
    if (Array.isArray(c) && c.length > 0) {
      const joined = c
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object" && "text" in entry) {
            const t = (entry as { text?: unknown }).text;
            return typeof t === "string" ? t : "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (joined) return joined;
    }
  }

  return "";
}

/**
 * Overwrite the internal notes of an order. Phase 1 does not call this —
 * kept here so the Phase 3 "купил частично" action can persist the
 * [PROCUREMENT] block.
 *
 * TODO(phase-3): As with tags, confirm the actual Veeqo PUT shape. The
 * existing helper `addEmployeeNote` (in client.ts) uses
 * `{ order: { employee_notes_attributes: [{ text }] } }`, which APPENDS a
 * note. Replacing requires a different shape — likely sending the full
 * existing notes_attributes array with destroy flags, or using a different
 * field. Verify with one live order before relying on this in Phase 3.
 */
export async function setInternalNotes(
  orderId: string | number,
  notes: string
): Promise<void> {
  await veeqoFetch(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ order: { employee_notes: notes } }),
  });
}
