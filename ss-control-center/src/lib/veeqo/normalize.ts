/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Keep Veeqo order bodies in the shape every reader assumes.
 *
 * 2026-11-17 06:58 ET: /procurement, /shipping, the dashboard summary and the
 * archive search all failed at once with "object is not iterable" — the exact
 * V8 message of `for (const li of order.line_items ?? [])` when `line_items`
 * is an object instead of an array. The code hadn't changed in 10 days; one
 * order in Veeqo's awaiting list came back with a non-array `line_items`, and
 * a single such order took down every screen that lists orders.
 *
 * veeqoFetch passes every /orders response through here: arrays are left
 * alone, anything else becomes an array (or empty), and the order is logged
 * once with the shape Veeqo actually sent so it can be looked at.
 */

// Array-valued fields of an order that readers iterate.
const ORDER_ARRAY_FIELDS = ["line_items", "allocations", "tags"] as const;

const warned = new Set<string>();

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Turn a non-array list field into an array. */
export function coerceList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (!isObj(v)) return [];
  // Envelope: { data: [...] } / { items: [...] } / { line_items: [...] }.
  for (const k of ["data", "items", "line_items", "results"]) {
    if (Array.isArray(v[k])) return v[k] as unknown[];
  }
  // One bare record (a line item has `sellable`/`quantity`, an allocation
  // `line_items`/`shipment`, a tag `name`).
  if ("id" in v && ("sellable" in v || "quantity" in v || "shipment" in v || "name" in v)) {
    return [v];
  }
  // Keyed map { "123": {...}, "456": {...} }.
  return Object.values(v).filter(isObj);
}

/** Normalise one order in place; returns it. */
export function normalizeVeeqoOrder<T>(order: T): T {
  if (!isObj(order)) return order;
  const o = order as Record<string, any>;
  for (const field of ORDER_ARRAY_FIELDS) {
    const v = o[field];
    if (v == null || Array.isArray(v)) continue;
    const fixed = coerceList(v);
    const id = String(o.number ?? o.id ?? "?");
    const key = `${id}:${field}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(
        `[veeqo] order ${id}: ${field} is ${typeof v}${isObj(v) ? ` keys=[${Object.keys(v).slice(0, 12).join(",")}]` : ""} — read as ${fixed.length} item(s)`,
      );
    }
    o[field] = fixed;
  }
  // Each allocation carries its own line_items.
  if (Array.isArray(o.allocations)) {
    for (const a of o.allocations) {
      if (isObj(a) && a.line_items != null && !Array.isArray(a.line_items)) {
        a.line_items = coerceList(a.line_items);
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
