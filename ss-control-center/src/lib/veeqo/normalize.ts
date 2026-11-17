/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Keep Veeqo order bodies in the shape every reader assumes — WITHOUT guessing
 * what a broken field meant.
 *
 * 2026-11-17 06:58 ET: /procurement, /shipping, the dashboard summary and the
 * archive search all failed at once with "object is not iterable". Veeqo had
 * sent order 113-4365835-6488256 (order A) with `line_items` set to a whole
 * ORDER object — by every sign another customer's order (order B,
 * 114-8255419-4685824, Taquitos ×2, line 2625865649) — instead of a list.
 *
 * The first fix (37894195b) "recovered" a list from that object by taking the
 * nested order's own `line_items`. That made order A show order B's
 * Taquitos, gave both Procurement cards the same line 2625865649 (one "Bought"
 * struck out both), and — because Veeqo flapped between the broken and the
 * normal body for the single-order GET — one "Bought" wrote a [PROCUREMENT]
 * note + Placed tag onto order A for order B's line, while order A's real
 * item (Uncrustables 714671746159) was never bought.
 *
 * Rule now: a non-array list field is UNREADABLE. It becomes an empty array
 * (so nothing crashes) and the order is marked with `_veeqoMalformed`; readers
 * re-read the order (veeqoFetch does it once) and, if it is still broken,
 * refuse to act on it and show a warning instead of a guessed product.
 */

// Array-valued fields of an order that readers iterate.
const ORDER_ARRAY_FIELDS = ["line_items", "allocations", "tags"] as const;

/** Marker field set on an order whose list fields Veeqo sent broken. */
export const MALFORMED_FIELD = "_veeqoMalformed";

const warned = new Set<string>();

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Short description of what Veeqo actually sent, for the log. */
function describe(v: unknown): string {
  if (!isObj(v)) return typeof v;
  const nested =
    "number" in v || "line_items" in v
      ? ` (looks like order id=${String(v.id ?? "?")} number=${String(v.number ?? "?")})`
      : "";
  return `object keys=[${Object.keys(v).slice(0, 12).join(",")}]${nested}`;
}

function markMalformed(o: Record<string, any>, field: string, v: unknown): void {
  const list: string[] = Array.isArray(o[MALFORMED_FIELD]) ? o[MALFORMED_FIELD] : [];
  if (!list.includes(field)) list.push(field);
  o[MALFORMED_FIELD] = list;
  const id = String(o.number ?? o.id ?? "?");
  const key = `${id}:${field}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(
      `[veeqo] order ${id} (id=${String(o.id ?? "?")}): ${field} is ${describe(v)} — unreadable, treated as empty`,
    );
  }
}

/** True when Veeqo sent this order with a broken list field. */
export function isMalformedVeeqoOrder(order: unknown): boolean {
  return (
    isObj(order) &&
    Array.isArray(order[MALFORMED_FIELD]) &&
    (order[MALFORMED_FIELD] as unknown[]).length > 0
  );
}

/** The broken field names (empty for a healthy order). */
export function malformedFields(order: unknown): string[] {
  return isMalformedVeeqoOrder(order)
    ? [...((order as Record<string, unknown>)[MALFORMED_FIELD] as string[])]
    : [];
}

/** Normalise one order in place; returns it. */
export function normalizeVeeqoOrder<T>(order: T): T {
  if (!isObj(order)) return order;
  const o = order as Record<string, any>;
  for (const field of ORDER_ARRAY_FIELDS) {
    const v = o[field];
    if (v == null || Array.isArray(v)) continue;
    markMalformed(o, field, v);
    o[field] = [];
  }
  // Each allocation carries its own line_items.
  if (Array.isArray(o.allocations)) {
    for (const a of o.allocations) {
      if (isObj(a) && a.line_items != null && !Array.isArray(a.line_items)) {
        markMalformed(o, "allocations.line_items", a.line_items);
        a.line_items = [];
      }
    }
  }
  return order;
}

/** veeqoFetch hook: normalise the orders in an /orders response. */
// Returns `any` on purpose: veeqoFetch's callers have always received the
// untyped JSON.parse result.
export function normalizeVeeqoResponse(path: string, body: unknown): any {
  if (!/^\/orders(\/|\?|$)/.test(path)) return body;
  if (Array.isArray(body)) {
    for (const o of body) normalizeVeeqoOrder(o);
    return body;
  }
  return normalizeVeeqoOrder(body);
}

/**
 * Re-read broken orders once. `refetch(id)` must return the normalised single
 * order. For a list, each broken order (up to `max`) is replaced in place when
 * the re-read comes back healthy and with the same id; for a single order the
 * healthy re-read is returned. Anything still broken stays marked.
 */
export async function repairMalformedOrders(
  body: unknown,
  refetch: (id: string) => Promise<unknown>,
  max = 5,
): Promise<unknown> {
  const tryOne = async (o: unknown): Promise<unknown> => {
    if (!isMalformedVeeqoOrder(o)) return o;
    const id = String((o as Record<string, unknown>).id ?? "");
    if (!/^\d+$/.test(id)) return o;
    try {
      const fresh = await refetch(id);
      if (
        isObj(fresh) &&
        !isMalformedVeeqoOrder(fresh) &&
        String(fresh.id ?? "") === id
      ) {
        console.warn(`[veeqo] order id=${id}: re-read came back healthy — using it`);
        return fresh;
      }
    } catch (e) {
      console.warn(
        `[veeqo] order id=${id}: re-read failed — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return o;
  };

  if (Array.isArray(body)) {
    let budget = max;
    for (let i = 0; i < body.length && budget > 0; i++) {
      if (!isMalformedVeeqoOrder(body[i])) continue;
      budget--;
      body[i] = await tryOne(body[i]);
    }
    return body;
  }
  return tryOne(body);
}
