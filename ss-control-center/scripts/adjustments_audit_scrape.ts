/**
 * Carrier-audit scraper for Amazon "Shipping services purchased through Amazon /
 * Adjustment" charges (Salutem Solutions).
 *
 * Seller Central renders the payments pages on the client, so the HTML is empty:
 * the data lives behind two internal JSON endpoints, same-origin and cookie-authed.
 *
 *   /payments/api/events-view?limit=50&offset=1&accountType=ALL
 *       &fiqlFiltersString=(orderId==<ORDER_ID>)&sortType=DESC
 *   /payments/api/event-details?financialEventId=<ID>
 *
 * The row's `rowIdentifier` IS the financialEventId, so no page click is needed.
 * `limit` is capped at 50 — 100 returns HTTP 400.
 *
 * Seller Central may only be opened from this account's own VPS, so the fetches
 * run inside the logged-in Chrome there: `emit` prints a harvester to paste into
 * the DevTools console, and `parse` turns the harvested raw JSON into the report.
 *
 * Usage:
 *   tsx scripts/adjustments_audit_scrape.ts emit  [big|rest|all] > harvest.js
 *   tsx scripts/adjustments_audit_scrape.ts parse <raw.json> [<raw2.json> ...] <out.json>
 */
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";
import { pickUnambiguous } from "@/lib/adjustments/audit-import";

const STORE_ID = "store1"; // Salutem Solutions

type Node = Record<string, any> | null | undefined;

function textOf(n: Node): string {
  if (!n) return "";
  switch (n.type) {
    case "PlainText":
      return n.textContent ?? "";
    case "Emphasized":
      return textOf(n.emphasizedContent);
    case "HoverTooltip":
      return textOf(n.anchorContent);
    case "Link":
      return textOf(n.linkBody);
    case "LocalizedCurrency":
      return String(n.currency?.amount ?? "");
    case "LocalizedDate":
      return new Date(n.dateEpochMillis).toISOString();
    case "TemplateText": {
      let s: string = n.textContent ?? "";
      for (const [k, v] of Object.entries(n.substitutions ?? {})) s = s.replace(`{${k}}`, textOf(v as Node));
      return s.replace(/\s+/g, " ").trim();
    }
    default:
      return n.textContent ?? "";
  }
}

function amountOf(n: Node): number | null {
  if (!n) return null;
  if (n.type === "LocalizedCurrency") return n.currency?.amount ?? null;
  if (n.type === "Link") return amountOf(n.linkBody);
  return null;
}

/** substitutions.content of a "{text} {content}" template, e.g. "25.0 X 14.0 X 17.0 IN" */
function contentOf(n: Node): string {
  if (!n) return "";
  if (n.type === "TemplateText") return textOf(n.substitutions?.content);
  return textOf(n);
}

function firstDateMs(n: any): number | null {
  if (!n || typeof n !== "object") return null;
  if (n.type === "LocalizedDate" && typeof n.dateEpochMillis === "number") return n.dateEpochMillis;
  for (const v of Object.values(n)) {
    const hit = firstDateMs(v);
    if (hit !== null) return hit;
  }
  return null;
}

type Entry = { label: string; values: Node[] };

function flatten(sections: any[], acc: Entry[] = []): Entry[] {
  for (const s of sections ?? []) {
    if (s?.sectionName) acc.push({ label: textOf(s.sectionName), values: s.sectionValues ?? [] });
    if (s?.childrenSections) flatten(s.childrenSections, acc);
  }
  return acc;
}

function parseDims(raw: string) {
  const m = raw.match(/([\d.]+)\s*X\s*([\d.]+)\s*X\s*([\d.]+)\s*([A-Z]+)?/i);
  if (!m) return null;
  return { l: Number(m[1]), w: Number(m[2]), h: Number(m[3]), unit: (m[4] ?? "IN").toUpperCase() };
}

function parseWeight(raw: string) {
  const m = raw.match(/([\d.]+)\s*([A-Z]+)/i);
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2].toUpperCase() };
}

/** Labels that are totals or dimension lines rather than carrier charge line items. */
const NOT_A_CHARGE =
  /^(Amount already paid|Total Charge from Carrier|Transaction Total|Customer Entered Dimensions|Carrier Audited Dimensions|Transaction date|The shipping services purchased)/i;

function parseDetails(orderId: string, eventId: string, doc: any, rowDateMs: number | null) {
  const entries = flatten(doc.eventSections ?? []);
  const pick = (re: RegExp) => entries.find((e) => re.test(e.label));

  const entered = pick(/^Customer Entered Dimensions/i);
  const audited = pick(/^Carrier Audited Dimensions/i);
  const dimText = (e?: Entry) => (e ? e.label.replace(/^[^:]*:\s*/, "") : "");
  const weightText = (e?: Entry) => (e && e.values[0] ? contentOf(e.values[0]) : "");

  const money = (re: RegExp) => {
    const e = pick(re);
    if (!e) return null;
    for (const v of e.values) {
      const a = amountOf(v);
      if (a !== null) return a;
    }
    return null;
  };

  const charges: { label: string; amount: number }[] = [];
  for (const e of entries) {
    if (!e.label || NOT_A_CHARGE.test(e.label)) continue;
    for (const v of e.values) {
      const a = amountOf(v);
      if (a !== null) charges.push({ label: e.label, amount: a });
    }
  }

  const dateMs = firstDateMs(doc) ?? rowDateMs;

  return {
    orderId,
    financialEventId: eventId,
    date: dateMs ? new Date(dateMs).toISOString().slice(0, 10) : null,
    enteredDims: parseDims(dimText(entered)),
    enteredWeight: parseWeight(weightText(entered)),
    auditedDims: parseDims(dimText(audited)),
    auditedWeight: parseWeight(weightText(audited)),
    charges,
    amountAlreadyPaid: money(/^Amount already paid/i),
    totalChargeFromCarrier: money(/^Total Charge from Carrier/i),
    transactionTotal: money(/^Transaction Total/i),
    detailsUrl: `https://sellercentral.amazon.com/payments/event/details?financialEventId=${eventId}`,
  };
}

/** Browser-side harvester: paste into the DevTools console of the VPS Chrome. */
function emitHarvester(orders: string[]): string {
  return `
window.__RES = {}; window.__ERR = []; window.__STOP = false; window.__P = 'init';
window.__harvest = async function (orders) {
  let n = 0;
  for (const oid of orders) {
    if (window.__STOP) break;
    n++;
    if (window.__RES[oid]) continue;
    try {
      const vr = await fetch('/payments/api/events-view?limit=50&offset=1&accountType=ALL&fiqlFiltersString=(orderId%3D%3D' + oid + ')&sortType=DESC', { credentials: 'include', headers: { accept: 'application/json' } });
      if (vr.status !== 200) { window.__ERR.push([oid, 'view', vr.status]); continue; }
      const vj = await vr.json();
      const rows = (vj.tableRows || []).map(function (tr) { const o = { id: tr.rowIdentifier }; (tr.tableCells || []).forEach(function (c) { o[c.columnIdentifier] = c.value; }); return o; });
      const amt = function (v) { if (!v) return null; if (v.currency) return v.currency.amount; if (v.linkBody && v.linkBody.currency) return v.linkBody.currency.amount; return null; };
      const summary = rows.map(function (o) { return { id: o.id, dateMs: o.POSTED_DATE ? o.POSTED_DATE.dateEpochMillis : null, type: o.TRANSACTION_TYPE ? o.TRANSACTION_TYPE.textContent : null, desc: o.DESCRIPTION ? o.DESCRIPTION.textContent : null, total: amt(o.TOTAL) }; });
      const picks = summary.filter(function (o) { return /Shipping services/i.test(o.type || '') && /Adjustment/i.test(o.desc || ''); });
      const det = {};
      for (const p of picks) {
        await new Promise(function (r) { setTimeout(r, 400); });
        const dr = await fetch('/payments/api/event-details?financialEventId=' + encodeURIComponent(p.id), { credentials: 'include', headers: { accept: 'application/json' } });
        det[p.id] = dr.status === 200 ? await dr.json() : { __status: dr.status };
      }
      window.__RES[oid] = { rows: summary, details: det };
    } catch (e) { window.__ERR.push([oid, '' + e]); }
    window.__P = n + '/' + orders.length + ' ok=' + Object.keys(window.__RES).length + ' err=' + window.__ERR.length;
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  window.__P = 'DONE ' + Object.keys(window.__RES).length + '/' + orders.length + ' err=' + window.__ERR.length;
};
window.__ORDERS = ${JSON.stringify(orders)};
window.__harvest(window.__ORDERS);
`.replace(/\n/g, " ");
}

async function loadOrders(which: string) {
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.shippingAdjustment.findMany({
    where: { channel: "Amazon", storeId: STORE_ID, orderId: { not: null } },
    select: { orderId: true, adjustmentAmount: true },
    orderBy: { adjustmentAmount: "asc" },
  });
  await prisma.$disconnect();
  const seen = new Set<string>();
  const big: string[] = [];
  const rest: string[] = [];
  for (const r of rows) {
    const id = r.orderId!;
    if (seen.has(id)) continue;
    seen.add(id);
    (Math.abs(r.adjustmentAmount) >= 10 ? big : rest).push(id);
  }
  return which === "big" ? big : which === "rest" ? rest : [...big, ...rest];
}

/** tracking numbers we already know per order, from the adjustments module */
async function loadTracking() {
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.shippingAdjustment.findMany({
    where: { channel: "Amazon", storeId: STORE_ID, orderId: { not: null } },
    select: { orderId: true, trackingNumber: true, carrier: true, adjustmentAmount: true },
  });
  await prisma.$disconnect();
  const map = new Map<string, { trackingNumber: string | null; carrier: string | null; amount: number }[]>();
  for (const r of rows) {
    const list = map.get(r.orderId!) ?? [];
    list.push({ trackingNumber: r.trackingNumber, carrier: r.carrier, amount: r.adjustmentAmount });
    map.set(r.orderId!, list);
  }
  return map;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  if (mode === "emit") {
    const orders = await loadOrders(rest[0] ?? "all");
    process.stdout.write(emitHarvester(orders));
    return;
  }

  if (mode === "parse") {
    const out = rest.pop()!;
    const raw: Record<string, any> = {};
    for (const f of rest) Object.assign(raw, JSON.parse(readFileSync(f, "utf8")));
    const tracking = await loadTracking();

    const results: any[] = [];
    for (const [orderId, payload] of Object.entries(raw)) {
      const rowById = new Map((payload.rows ?? []).map((r: any) => [r.id, r]));
      for (const [eventId, doc] of Object.entries<any>(payload.details ?? {})) {
        if (doc?.__status) {
          results.push({ orderId, financialEventId: eventId, error: `details HTTP ${doc.__status}` });
          continue;
        }
        const row: any = rowById.get(eventId);
        const rec: any = parseDetails(orderId, eventId, doc, row?.dateMs ?? null);
        // Tracking number is not on the payments page; take it from the module,
        // but only when exactly one of the order's rows fits this transaction.
        // Falling back to the order's first row glued several adjustments of one
        // order onto the same tracking (and so the same registry row).
        const pick = pickUnambiguous(tracking.get(orderId) ?? [], rec.transactionTotal, (c) => c.amount);
        const hit = pick && "hit" in pick ? pick.hit : null;
        rec.trackingNumber = hit?.trackingNumber ?? null;
        rec.carrier = hit?.carrier ?? null;
        if (pick && "reason" in pick) rec.trackingNote = `tracking not attached: ${pick.reason} (${pick.count} rows)`;
        results.push(rec);
      }
    }
    results.sort((a, b) => (a.transactionTotal ?? 0) - (b.transactionTotal ?? 0));
    writeFileSync(out, JSON.stringify(results, null, 1));
    console.log(`orders=${Object.keys(raw).length} rows=${results.length} -> ${out}`);
    return;
  }

  console.error("usage: adjustments_audit_scrape.ts emit [big|rest|all] | parse <raw...> <out.json>");
  process.exit(1);
}

main();
