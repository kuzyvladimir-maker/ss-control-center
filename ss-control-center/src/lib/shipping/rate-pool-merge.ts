/**
 * Complete a Rate Shopping API quote with the services Veeqo's allocation
 * pool offers but the quote left out.
 *
 * Why: the Pick-Rate dialog quotes "ship today" through the new API with
 * preferred_shipment_date = today 16:00Z (11:00 ET). Once that moment is past
 * — e.g. the operator opens the dialog in the evening — Veeqo drops every
 * FedEx service from the answer. Order 114-2900934-1081853 (2026-11-20,
 * 19:45 ET): the dialog showed 12 rates, no FedEx at all, while Veeqo's own
 * screen and its allocation pool (GET /shipping/rates/{allocation}) offered
 * 22, including "FedEx 2Day® One Rate" $17.52. The buy re-quotes against that
 * same allocation pool, so a service taken from it is exactly what Buy can
 * purchase.
 *
 * The quote stays primary: when both have a service, the quote's row wins
 * (it carries the date-anchored EDD). Pool rows are only appended, tagged
 * `source: "allocation"`. Pure.
 */

import { normTitle } from "./requote-match";

export interface PoolRate {
  title?: unknown;
  sub_carrier_id?: unknown;
  [key: string]: unknown;
}

const serviceKey = (r: PoolRate) =>
  `${String(r.sub_carrier_id ?? "").toUpperCase()}|${normTitle(r.title)}`;

export function mergeMissingRates<R extends PoolRate>(
  quoted: R[],
  pool: R[],
): R[] {
  const have = new Set(quoted.map(serviceKey));
  const added: R[] = [];
  for (const r of pool) {
    const k = serviceKey(r);
    if (have.has(k)) continue;
    have.add(k);
    added.push({ ...r, source: "allocation" });
  }
  return [...quoted, ...added];
}
