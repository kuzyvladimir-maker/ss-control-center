/**
 * Uncrustables pricing + shipping reality check (Veeqo, all channels).
 *
 * Pulls SHIPPED orders for the last N days and produces:
 *   A) Uncrustables sold prices by TOTAL unit count — item price, shipping
 *      charged to customer, and the sum (the real revenue per sale).
 *   B) Average label cost we actually PAID, bucketed by cooler size (S/M/L/XL),
 *      where cooler is derived from the order's total unit count (same qty→box
 *      rule as the pricing formula). Plus avg weight + avg shipping charged vs paid.
 *
 * Run: npx tsx scripts/uncrustables-pricing-analysis.ts [days=90]
 */
import "dotenv/config";
import { veeqoFetch } from "../src/lib/veeqo/client";

// Usage: npx tsx scripts/uncrustables-pricing-analysis.ts [days] [fromISO] [toISO]
// If fromISO/toISO given, they override the rolling-days window.
const days = Number(process.argv[2] ?? 90);
const TODAY = new Date("2026-06-15T23:59:59Z").getTime();
const minDate =
  process.argv[3] ?? new Date(TODAY - days * 86400_000).toISOString();
const maxDate = process.argv[4] ?? new Date(TODAY).toISOString();

function cooler(total: number): "S" | "M" | "L" | "XL" | "?" {
  if (total <= 0) return "?";
  if (total <= 30) return "S";
  if (total <= 60) return "M";
  if (total <= 72) return "L";
  return "XL";
}

function parseTotal(title: string): number {
  const t = title.toLowerCase();
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  const kw = /(\d{1,3})\s*(?:total|count|ct\b|pieces|pcs|pack|sandwich|units)/g;
  while ((m = kw.exec(t))) hits.push(Number(m[1]));
  const alt = /(?:total|count|pack of|qty)[:of\s]*?(\d{1,3})/g;
  while ((m = alt.exec(t))) hits.push(Number(m[1]));
  const plausible = hits.filter((n) => n >= 2 && n <= 200);
  if (plausible.length) return Math.max(...plausible);
  const all = [...t.matchAll(/\b(\d{1,3})\b/g)]
    .map((x) => Number(x[1]))
    .filter((n) => n >= 4 && n <= 200);
  return all.length ? Math.max(...all) : -1;
}

function labelCost(order: any): number | null {
  let sum = 0;
  let found = false;
  for (const a of order.allocations ?? []) {
    const sh = a.shipment;
    if (Array.isArray(sh?.charges) && sh.charges.length) {
      for (const c of sh.charges) {
        if (c?.value != null) {
          sum += Number(c.value);
          found = true;
        }
      }
    } else if (sh?.outbound_label_charges?.value != null) {
      sum += Number(sh.outbound_label_charges.value);
      found = true;
    }
  }
  return found ? sum : null;
}

function weightLbs(order: any): number | null {
  let oz = 0;
  let found = false;
  for (const a of order.allocations ?? []) {
    if (a.total_weight != null) {
      oz += Number(a.total_weight);
      found = true;
    }
  }
  return found ? oz / 16 : null;
}

async function fetchShipped(): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= 90; page++) {
    const r = (await veeqoFetch(
      `/orders?status=shipped&created_at_min=${encodeURIComponent(minDate)}&created_at_max=${encodeURIComponent(maxDate)}&page_size=100&page=${page}`,
    )) as any[];
    const chunk = Array.isArray(r) ? r : [];
    all.push(...chunk);
    if (chunk.length < 100) break;
  }
  return all;
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
const f = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");

async function main() {
  console.log(`Fetching SHIPPED orders ${minDate} … ${maxDate} (${days}d)`);
  const orders = await fetchShipped();
  console.log(`Shipped orders: ${orders.length}\n`);

  // ---- A) Uncrustables sales by total ----
  type Sale = { total: number; item: number; ship: number; sum: number };
  const sales: Sale[] = [];
  for (const o of orders) {
    const lis = (o.line_items ?? []).filter((li: any) =>
      /uncrustable/i.test(
        li.sellable?.product_title ?? li.sellable?.title ?? li.title ?? "",
      ),
    );
    if (lis.length !== 1) continue; // keep clean single-listing orders
    const li = lis[0];
    const qty = Number(li.quantity ?? 1);
    if (qty !== 1) continue; // simple: 1 listing per order
    const title = li.sellable?.product_title ?? li.title ?? "";
    const item = Number(li.price_per_unit ?? li.sellable?.price ?? 0);
    const ship = Number(o.delivery_cost ?? 0); // shipping charged to customer
    sales.push({ total: parseTotal(title), item, ship, sum: item + ship });
  }

  const byTotal = new Map<number, Sale[]>();
  for (const s of sales) {
    const g = byTotal.get(s.total) ?? [];
    g.push(s);
    byTotal.set(s.total, g);
  }
  console.log(`=== A) UNCRUSTABLES SOLD (single-listing orders) — last ${days}d ===`);
  console.log(
    "total | cooler | n | avg item | avg ship charged | AVG ITEM+SHIP | min sum | max sum",
  );
  for (const [total, g] of [...byTotal.entries()].sort((a, b) => a[0] - b[0])) {
    const sums = g.map((x) => x.sum);
    console.log(
      `${total} | ${cooler(total)} | ${g.length} | ${f(avg(g.map((x) => x.item)))} | ${f(avg(g.map((x) => x.ship)))} | ${f(avg(sums))} | ${f(Math.min(...sums))} | ${f(Math.max(...sums))}`,
    );
  }

  // ---- B) Label cost we PAID, by cooler (all single-listing frozen bundles) ----
  type Ship = { cooler: string; label: number; charged: number; wt: number | null };
  const ships: Ship[] = [];
  for (const o of orders) {
    const lc = labelCost(o);
    if (lc == null) continue;
    // derive cooler from the order's parsed total (single listing only)
    if ((o.line_items ?? []).length !== 1) continue;
    const li = o.line_items[0];
    const title = li.sellable?.product_title ?? li.title ?? "";
    const totalUnits = parseTotal(title) * Number(li.quantity ?? 1);
    const cz = cooler(totalUnits);
    if (cz === "?") continue;
    ships.push({
      cooler: cz,
      label: lc,
      charged: Number(o.delivery_cost ?? 0),
      wt: weightLbs(o),
    });
  }
  console.log(
    `\n=== B) LABEL COST PAID by cooler (single-listing orders) — last ${days}d ===`,
  );
  console.log(
    "cooler | n | AVG LABEL PAID | min | max | avg wt lbs | avg charged to cust | paid−charged gap",
  );
  for (const cz of ["S", "M", "L", "XL"]) {
    const g = ships.filter((s) => s.cooler === cz);
    if (!g.length) {
      console.log(`${cz} | 0`);
      continue;
    }
    const paid = avg(g.map((s) => s.label));
    const charged = avg(g.map((s) => s.charged));
    const wts = g.map((s) => s.wt).filter((x): x is number => x != null);
    console.log(
      `${cz} | ${g.length} | ${f(paid)} | ${f(Math.min(...g.map((s) => s.label)))} | ${f(Math.max(...g.map((s) => s.label)))} | ${wts.length ? avg(wts).toFixed(1) : "—"} | ${f(charged)} | ${f(paid - charged)}`,
    );
  }

  // channel sanity
  const chans = new Map<string, number>();
  for (const o of orders)
    chans.set(o.channel?.name ?? "?", (chans.get(o.channel?.name ?? "?") ?? 0) + 1);
  console.log(`\nchannels:`, [...chans.entries()].map(([c, n]) => `${c}:${n}`).join("  "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
