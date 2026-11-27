/**
 * Merge an operator's manual rate pick (PickRateDialog / inline picker) into
 * the plan item before /api/shipping/buy re-quotes and buys it.
 *
 * Why this lives here: the merge used to be inline in the route and forgot
 * `price` and `edd`. The requote matcher then compared the live price of the
 * operator's service against the ALGORITHM's planned price — e.g. the
 * operator picked "UPS 2nd Day Air®" at $11.40 over a $6.74 plan, the live
 * rate came back at $11.40, and the price guard ($6.74 + max($1, 5%)) refused
 * it with "now costs $11.40 — more than the planned $6.74" (2026-11-20). The
 * planned EDD leaked the same way into the "base" tier and alternatives.
 *
 * Pure: no Veeqo, no Prisma.
 */

export interface BuyOverride {
  carrierId?: string | null;
  remoteShipmentId?: string | null;
  serviceType?: string | null;
  subCarrierId?: string | null;
  serviceCarrier?: string | null;
  totalNetCharge?: string | null;
  baseRate?: string | null;
  carrier?: string | null;
  service?: string | null;
  // Price (USD) and EDD (YYYY-MM-DD) of the rate the operator picked. They
  // become the planned price/EDD the live requote is checked against.
  price?: number | null;
  edd?: string | null;
  // Physical ship day the operator forced via the inline picker / rate modal.
  // When present it becomes the dispatch date the label is bought against
  // (the dispatch-date dance in the route keys off item.physicalShipDate).
  physicalShipDate?: string | null;
}

export interface OverridableItem {
  carrierId: string | null;
  remoteShipmentId: string | null;
  serviceType: string | null;
  subCarrierId: string | null;
  serviceCarrier: string | null;
  totalNetCharge: string | null;
  baseRate: string | null;
  carrier: string | null;
  service: string | null;
  price: number | null;
  edd: string | null;
  physicalShipDate: string | null;
  actualShipDay: string | null;
}

/**
 * Override fields take precedence; the rest fall back to the plan. The price
 * comes from the override's `price`, else its `totalNetCharge` (the same
 * rate's charge as a string), and only then the plan — an override that
 * changes the service must never inherit the algorithm's price.
 */
export function applyBuyOverride<T extends OverridableItem>(
  rawItem: T,
  ov: BuyOverride | null | undefined,
): T {
  if (!ov) return rawItem;
  const ovCharge = parseFloat(ov.totalNetCharge ?? "");
  const ovPrice =
    typeof ov.price === "number" && Number.isFinite(ov.price)
      ? ov.price
      : Number.isFinite(ovCharge)
        ? ovCharge
        : null;
  return {
    ...rawItem,
    carrierId: ov.carrierId ?? rawItem.carrierId,
    remoteShipmentId: ov.remoteShipmentId ?? rawItem.remoteShipmentId,
    serviceType: ov.serviceType ?? rawItem.serviceType,
    subCarrierId: ov.subCarrierId ?? rawItem.subCarrierId,
    serviceCarrier: ov.serviceCarrier ?? rawItem.serviceCarrier,
    totalNetCharge: ov.totalNetCharge ?? rawItem.totalNetCharge,
    baseRate: ov.baseRate ?? rawItem.baseRate,
    carrier: ov.carrier ?? rawItem.carrier,
    service: ov.service ?? rawItem.service,
    price: ovPrice ?? rawItem.price,
    edd: ov.edd ?? rawItem.edd,
    // A forced ship date overrides BOTH date columns so the dispatch-date
    // dance (keyed on physicalShipDate) buys against the chosen day, and the
    // warehouse note reflects it.
    physicalShipDate: ov.physicalShipDate ?? rawItem.physicalShipDate,
    actualShipDay: ov.physicalShipDate ?? rawItem.actualShipDay,
  };
}

/** Clear manual rate picks only for orders confirmed bought in this batch. */
export function retainFailedOverrides<T>(
  prev: Record<string, T>,
  boughtOrderNumbers: ReadonlySet<string>,
  orderNumberByOrderId: ReadonlyMap<string, string>,
): Record<string, T> {
  if (boughtOrderNumbers.size === 0) return prev;
  const next = { ...prev };
  for (const orderId of Object.keys(prev)) {
    const orderNumber = orderNumberByOrderId.get(orderId);
    if (orderNumber !== undefined && boughtOrderNumbers.has(orderNumber)) {
      delete next[orderId];
    }
  }
  return next;
}
