/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Coerce whatever Veeqo put in a tracking field into a tracking number.
 *
 * `tracking_number` is NOT always a string: for Amazon "Buy Shipping"
 * shipments it comes back as an object (and sometimes an array of them),
 * which a naive String() turned into the literal "[object Object]" —
 * rendered as a tracking chip on the archive row, seen in production
 * 2026-08-04. Walk the plausible shapes and accept only something that
 * actually looks like a tracking number: no spaces, no punctuation beyond
 * dot/dash/underscore, at least 6 characters. That last rule is what makes
 * "[object Object]" unrepresentable here rather than merely unlikely.
 */
export function trackingString(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const item of v) {
      const found = trackingString(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") {
    const s = v.trim();
    return /^[A-Za-z0-9._-]{6,}$/.test(s) ? s : null;
  }
  if (v && typeof v === "object") {
    for (const key of [
      "tracking_number",
      "number",
      "tracking_no",
      "code",
      "value",
    ]) {
      const found = trackingString((v as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return null;
}

export interface VeeqoShipmentRef {
  shipmentId: string;
  tracking: string | null;
  carrier: string | null;
  service: string | null;
  createdAt: string | null;
}

/** Every shipment on a Veeqo order (label bought through Veeqo), with the
 *  tracking number it carries. Shipment shape varies by carrier. */
export function veeqoShipments(order: any): VeeqoShipmentRef[] {
  const out: VeeqoShipmentRef[] = [];
  const seen = new Set<string>();
  for (const alloc of order?.allocations ?? []) {
    const shipments = [
      alloc?.shipment,
      ...(Array.isArray(alloc?.shipments) ? alloc.shipments : []),
    ].filter(Boolean);
    for (const sh of shipments) {
      if (sh?.id == null || seen.has(String(sh.id))) continue;
      seen.add(String(sh.id));
      const text = (v: unknown) =>
        typeof v === "string" && v.trim() ? v.trim() : null;
      out.push({
        shipmentId: String(sh.id),
        tracking: trackingString(
          sh?.tracking_number ?? sh?.tracking_number_string ?? sh?.tracking,
        ),
        carrier: text(sh?.carrier?.name ?? sh?.carrier_name),
        service: text(sh?.service_carrier ?? sh?.shipping_method),
        createdAt: text(sh?.created_at),
      });
    }
  }
  return out;
}
