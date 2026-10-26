/**
 * Rate snapshots read from a marketplace admin UI (NAN Health / Shopify).
 *
 * Shopify's shippingLabelPurchase API neither lists the rates nor buys FedEx,
 * so a browser session reads the admin "Buy shipping label" page (no purchase)
 * and posts the list here. Accepts Jackie's compact format —
 *   rates: [["FedEx Ground Economy", 6.98, "4-5d"], …]
 * — or objects {carrier?, service, price, transit?}. Pure: no DB, no network.
 */

export interface SnapshotRate {
  carrier: string;
  service: string;
  price: number;
  transit: string;
}

const CARRIERS = ["FedEx", "UPS", "USPS", "DHL"] as const;

/** "FedEx Ground Economy" → carrier "FedEx", service "Ground Economy". */
function splitService(full: string): { carrier: string; service: string } {
  const t = full.trim();
  for (const c of CARRIERS) {
    if (t.toLowerCase().startsWith(c.toLowerCase() + " ")) {
      return { carrier: c, service: t.slice(c.length).trim() };
    }
  }
  return { carrier: "", service: t };
}

/** Normalise one order number to the Veeqo form without "#". */
export function normOrderNumber(n: unknown): string {
  return String(n ?? "").trim().replace(/^#/, "");
}

export function normalizeSnapshotRates(raw: unknown): SnapshotRate[] {
  if (!Array.isArray(raw)) return [];
  const out: SnapshotRate[] = [];
  for (const r of raw) {
    let full = "";
    let carrier = "";
    let price = NaN;
    let transit = "";
    if (Array.isArray(r)) {
      full = String(r[0] ?? "");
      price = Number(r[1]);
      transit = String(r[2] ?? "");
    } else if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      full = String(o.service ?? o.name ?? "");
      carrier = String(o.carrier ?? "");
      price = Number(o.price ?? o.amount);
      transit = String(o.transit ?? o.days ?? "");
    }
    if (!full || !Number.isFinite(price) || price <= 0) continue;
    const split = splitService(full);
    out.push({
      carrier: carrier || split.carrier,
      service: carrier ? full : split.service,
      price: Math.round(price * 100) / 100,
      transit: transit.trim(),
    });
  }
  // Cheapest first; media-only rates (USPS Media Mail) last — not for food.
  const mediaOnly = (r: SnapshotRate) => /media/i.test(`${r.service} ${r.transit}`);
  return out.sort((a, b) => Number(mediaOnly(a)) - Number(mediaOnly(b)) || a.price - b.price);
}
