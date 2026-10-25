/**
 * Collects the minimum case data set (case-data-gate.ts) for one buyer
 * message, walking each item's source chain and recording every attempt.
 * Read-only towards marketplaces: SP-API GETs, Veeqo GETs, carrier GETs.
 */
import { prisma } from "@/lib/prisma";
import { spApiGet } from "@/lib/amazon-sp-api/client";
import { getOrderFinancialEvents } from "@/lib/amazon-sp-api/finances";
import { veeqoFetch, getProduct } from "@/lib/veeqo/client";
import { parseTempClass } from "@/lib/shipping/temp-class/classes";
import { getUpsTracking } from "@/lib/carriers/ups-tracking";
import { getFedexTracking } from "@/lib/carriers/fedex-tracking";
import { getUspsTracking } from "@/lib/carriers/usps-tracking";
import { transitFacts, type TransitEvent } from "./transit";
import {
  type CaseDataItem,
  type CaseDataKey,
  type CaseDataSnapshot,
  type SourceAttempt,
} from "./case-data-gate";

type Msg = NonNullable<Awaited<ReturnType<typeof prisma.buyerMessage.findUnique>>>;

export interface ThreadEntry {
  at: string;
  who: "buyer" | "us" | "amazon";
  text: string;
}

export interface CollectResult {
  snapshot: CaseDataSnapshot;
  thread: ThreadEntry[];
  /** Fields worth persisting on the message (fresh tracking, product type). */
  patch: { trackingEvents?: string; productType?: string };
}

// Minimal shape of a Veeqo order line, enough to resolve product id + SKU for
// the M7 Frozen/Dry tag lookup. Veeqo returns far more; we only read these.
type VeeqoLine = {
  sellable?: {
    sku_code?: string;
    sku?: string;
    id?: number;
    product_id?: number;
    product?: { id?: number };
  };
};
type VeeqoOrder = { number?: string; line_items?: VeeqoLine[] };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);
const UNSHIPPED = /unshipped|pending|partiallyshipped/i;

function item(
  key: CaseDataKey,
  present: boolean,
  fact: string,
  factRu: string,
  tried: SourceAttempt[]
): CaseDataItem {
  return { key, present, fact: present ? fact : "", factRu: present ? factRu : "", tried };
}

/**
 * Guess the carrier from the tracking number when the stored carrier is
 * ambiguous ("Buy Shipping" is a billing label, not a carrier). USPS numbers
 * are 20–22 digits starting 91/92/93/94 (or the "9400…" IMpb form); UPS starts
 * "1Z"; FedEx is 12/15 digits. Diana's 9334610990150220712718 is USPS — without
 * this it would fall through to the UPS endpoint and return nothing.
 */
function inferCarrier(carrier: string | null, tracking: string): "usps" | "fedex" | "ups" {
  const c = (carrier || "").toLowerCase();
  if (c.includes("usps")) return "usps";
  if (c.includes("fedex")) return "fedex";
  if (c.includes("ups")) return "ups";
  const t = (tracking || "").replace(/\s+/g, "");
  if (/^1Z/i.test(t)) return "ups";
  if (/^9[1-5]\d{18,20}$/.test(t) || /^9400\d{18,}$/.test(t)) return "usps";
  if (/^\d{12}$|^\d{15}$|^\d{20,22}$/.test(t)) return "fedex";
  return "ups";
}

async function carrierEvents(carrier: string | null, tracking: string): Promise<TransitEvent[] | null> {
  const which = inferCarrier(carrier, tracking);
  const info =
    which === "fedex"
      ? await getFedexTracking(tracking)
      : which === "usps"
        ? await getUspsTracking(tracking)
        : await getUpsTracking(tracking);
  return info?.events?.length ? info.events : null;
}

export async function collectCaseData(
  m: Msg,
  prev?: CaseDataSnapshot | null
): Promise<CollectResult> {
  const storeId = `store${m.storeIndex}`;
  const orderId = m.amazonOrderId;
  const patch: CollectResult["patch"] = {};
  const items: CaseDataItem[] = [];

  // ── M1 buyer text ───────────────────────────────────────────────────
  const text = (m.customerMessage || "").replace(/\s*View Message\s*$/i, "").trim();
  items.push(
    item("M1", text.length > 0, `Buyer wrote: "${text.slice(0, 300)}"`, "текст покупателя есть", [
      { source: "Gmail (уведомление Amazon)", ok: text.length > 0, note: text ? undefined : "пустое письмо" },
    ])
  );

  // ── M2 thread ───────────────────────────────────────────────────────
  const thread: ThreadEntry[] = [];
  const m2tried: SourceAttempt[] = [];
  try {
    const rows = orderId
      ? await prisma.buyerMessage.findMany({
          where: { amazonOrderId: orderId, id: { not: m.id } },
          orderBy: { createdAt: "asc" },
        })
      : [];
    for (const r of rows) {
      const amazonCs = /This is Amazon.s Customer Service/i.test(r.customerMessage || "");
      thread.push({
        at: (r.receivedAt || r.createdAt).toISOString(),
        who: r.direction === "outgoing" ? "us" : amazonCs ? "amazon" : "buyer",
        text: (r.customerMessage || "").replace(/\s*View Message\s*$/i, "").trim(),
      });
    }
    m2tried.push({ source: "база хаба", ok: true, note: `${rows.length} сообщ.` });
    const ownerReplies = orderId
      ? await prisma.knowledgeBaseEntry.findMany({
          where: { source: "owner_edit", tags: { contains: `orderId:${orderId}` } },
        })
      : [];
    for (const k of ownerReplies) {
      const date = /date:(\d{4}-\d{2}-\d{2})/.exec(k.tags || "")?.[1] || "";
      if (!thread.some((t) => t.who === "us" && t.text.slice(0, 80) === k.correctResponse.slice(0, 80)))
        thread.push({ at: date ? `${date}T12:00:00.000Z` : "", who: "us", text: k.correctResponse });
    }
    m2tried.push({ source: "ваши ответы из писем-подтверждений Amazon", ok: true, note: `${ownerReplies.length}` });
    thread.sort((a, b) => a.at.localeCompare(b.at));
  } catch (e) {
    m2tried.push({ source: "база хаба", ok: false, note: errText(e) });
  }
  const m2ok = m2tried.some((t) => t.ok);
  items.push(
    item(
      "M2",
      m2ok,
      thread.length
        ? `Earlier on this order: ${thread.length} message(s) — ${thread
            .map((t) => `[${t.at.slice(0, 10)}] ${t.who.toUpperCase()}: ${t.text.replace(/\s+/g, " ").slice(0, 160)}`)
            .join(" | ")}`
        : "No earlier messages on this order.",
      thread.length ? `по заказу уже было ${thread.length} сообщ.` : "раньше по заказу не переписывались",
      m2tried
    )
  );

  // ── M3 order + M4 dates ─────────────────────────────────────────────
  const m3tried: SourceAttempt[] = [];
  let status: string | null = null;
  let total: string | null = null;
  let purchased: string | null = null;
  let shipBy: string | null = null;
  let deliverBy: string | null = null;
  let itemsLine: string | null = null;
  if (orderId) {
    try {
      const o = (await spApiGet(`/orders/v0/orders/${orderId}`, { storeId }))?.payload;
      status = o?.OrderStatus ?? null;
      total = o?.OrderTotal?.Amount ? `$${o.OrderTotal.Amount}` : null;
      purchased = o?.PurchaseDate?.slice(0, 10) ?? null;
      shipBy = o?.LatestShipDate?.slice(0, 10) ?? null;
      deliverBy = o?.LatestDeliveryDate?.slice(0, 10) ?? null;
      m3tried.push({ source: "SP-API Orders", ok: Boolean(status) });
      const its = (await spApiGet(`/orders/v0/orders/${orderId}/orderItems`, { storeId }))?.payload?.OrderItems || [];
      if (its.length)
        itemsLine = its
          .map((i: { QuantityOrdered?: number; Title?: string; ASIN?: string }) => `${i.QuantityOrdered ?? "?"}× ${(i.Title || "").slice(0, 70)} (${i.ASIN})`)
          .join("; ");
    } catch (e) {
      m3tried.push({ source: "SP-API Orders", ok: false, note: errText(e) });
    }
    if (!status || !shipBy) {
      try {
        const db = await prisma.amazonOrder.findFirst({ where: { amazonOrderId: orderId } });
        if (db) {
          status = status || db.status;
          total = total || (db.orderTotal ? `$${db.orderTotal}` : null);
          purchased = purchased || db.purchaseDate?.toISOString().slice(0, 10) || null;
          shipBy = shipBy || db.latestShipDate?.toISOString().slice(0, 10) || null;
          deliverBy = deliverBy || db.latestDeliveryDate?.toISOString().slice(0, 10) || null;
        }
        m3tried.push({ source: "копия заказа в базе", ok: Boolean(db) });
      } catch (e) {
        m3tried.push({ source: "копия заказа в базе", ok: false, note: errText(e) });
      }
    }
    if (!itemsLine && m.product) itemsLine = `${m.quantity ?? "?"}× ${m.product.slice(0, 70)}${m.asin ? ` (${m.asin})` : ""}`;
    deliverBy = deliverBy || m.promisedEdd || null;
  } else {
    m3tried.push({ source: "номер заказа", ok: false, note: "в письме нет номера заказа" });
  }
  const m3ok = Boolean(status && itemsLine && total);
  items.push(
    item(
      "M3",
      m3ok,
      `Order ${orderId}: status ${status}; items: ${itemsLine}; total ${total}; purchased ${purchased}`,
      `заказ ${status}, ${itemsLine}, ${total}`,
      m3tried
    )
  );
  items.push(
    item(
      "M4",
      Boolean(shipBy && deliverBy),
      `Ship by ${shipBy}; Deliver by (Amazon window end) ${deliverBy}`,
      `Ship by ${shipBy}, Deliver by ${deliverBy}`,
      m3tried
    )
  );

  const unshipped = Boolean(status && UNSHIPPED.test(status));

  // ── M5 shipment ─────────────────────────────────────────────────────
  if (unshipped) {
    items.push(item("M5", true, "Not shipped yet (order status).", "ещё не отгружен", [{ source: "SP-API Orders", ok: true }]));
  } else {
    const ok = Boolean(m.carrier && m.trackingNumber);
    items.push(
      item(
        "M5",
        ok,
        `Shipment: ${m.carrier} ${m.service || ""}, tracking ${m.trackingNumber}, label ${m.shipDate}, Amazon Buy Shipping: ${m.boughtThroughVeeqo ? "yes" : "no"}`,
        `${m.carrier} ${m.service || ""}, трек \`${m.trackingNumber}\`, этикетка ${m.shipDate}${m.boughtThroughVeeqo ? ", Buy Shipping" : ""}`,
        [{ source: "Veeqo", ok, note: ok ? undefined : "отгрузка не найдена" }]
      )
    );
  }

  // ── M6 carrier tracking ─────────────────────────────────────────────
  const m6tried: SourceAttempt[] = [];
  let events: TransitEvent[] | null = null;
  if (unshipped) {
    items.push(item("M6", true, "No tracking: not shipped yet.", "трекинга нет — не отгружен", [{ source: "SP-API Orders", ok: true }]));
  } else {
    // Fresh carrier data first — the stored events can be days old (a
    // reprinted label may have been scanned since the buyer wrote).
    if (m.trackingNumber) {
      try {
        events = await carrierEvents(m.carrier, m.trackingNumber);
        if (events?.length) patch.trackingEvents = JSON.stringify(events);
        m6tried.push({ source: "API перевозчика (UPS/FedEx/USPS)", ok: Boolean(events?.length) });
      } catch (e) {
        m6tried.push({ source: "API перевозчика (UPS/FedEx/USPS)", ok: false, note: errText(e) });
      }
    }
    if (!events?.length) {
      try {
        events = m.trackingEvents ? (JSON.parse(m.trackingEvents) as TransitEvent[]) : null;
      } catch {
        events = null;
      }
      m6tried.push({ source: "сохранённый трекинг", ok: Boolean(events?.length) });
    }
    const tf = transitFacts(events);
    const ok = Boolean(events?.length);
    // Owner rule (2026-10-25, topic 42, Diana): the card's tracking fact must
    // ALWAYS state the delivery verdict (delivered or NOT), the last scan date
    // + location, and whether the carrier flagged a delay — this is the
    // mandatory minimum a decision is built on. A circling, undelivered,
    // past-window package is a carrier delay, never a reason to offer a cancel.
    const carrierEn = m.carrier || "carrier";
    const carrierRu = m.carrier || "перевозчик";
    const last = tf.lastScan
      ? `; last scan ${tf.lastScan}${tf.lastLocation ? ` at ${tf.lastLocation}` : ""}${tf.lastStatus ? ` ("${tf.lastStatus}")` : ""}`
      : "";
    const lastRu = tf.lastScan
      ? `; последний скан ${tf.lastScan}${tf.lastLocation ? `, ${tf.lastLocation}` : ""}${tf.lastStatus ? ` («${tf.lastStatus}»)` : ""}`
      : "";
    const delayedEn = tf.delayed ? "; DELAYED in transit" : "";
    const delayedRu = tf.delayed ? "; задержка в пути" : "";
    let factEn: string;
    let factRu: string;
    if (!tf.firstCarrierScan) {
      factEn = "Carrier tracking: NO carrier acceptance scan — label only, the carrier never received the package.";
      factRu = "скана приёмки нет — посылку перевозчику не передали";
    } else if (tf.delivered) {
      factEn = `Carrier tracking (${carrierEn}): DELIVERED ${tf.delivered}${tf.deliveryDetail ? ` (${tf.deliveryDetail})` : ""}; accepted ${tf.firstCarrierScan}${tf.transitHours !== null ? `; ~${tf.transitHours} h in transit` : ""}.`;
      factRu = `${carrierRu}: ДОСТАВЛЕНО ${tf.delivered}${tf.deliveryDetail ? ` (${tf.deliveryDetail})` : ""}; принят ${tf.firstCarrierScan}.`;
    } else {
      const routeEn = tf.route ? `; route: ${tf.route}` : "";
      const routeRu = tf.route ? `; маршрут: ${tf.route}` : "";
      factEn = `Carrier tracking (${carrierEn}): NOT delivered${tf.daysInTransit !== null ? ` — ${tf.daysInTransit} days in transit` : ""}${delayedEn}; accepted ${tf.firstCarrierScan}${last}${routeEn}.`;
      factRu = `${carrierRu}: НЕ доставлен${tf.daysInTransit !== null ? `, ${tf.daysInTransit} дн. в пути` : ""}${delayedRu}; принят ${tf.firstCarrierScan}${lastRu}${routeRu}.`;
    }
    items.push(item("M6", ok, factEn, factRu, m6tried));
  }

  // ── M7 product type (Veeqo tags / owner's manual class — never guessed) ──
  // The Frozen/Dry tag lives on the PRODUCT, not on the /orders?query= payload,
  // so we resolve each line's product id and read /products/:id. The old code
  // read `li.sellable.product.tags` straight off the orders-list response —
  // that field is NEVER populated there, so the set was always empty and the
  // hub reported "no Frozen/Dry tag" even when the tag WAS set in Veeqo (the
  // Brenda bug). Precedence matches the shipping card (resolve-class.ts): the
  // owner's manual SkuTemperatureClass → legacy ProductTypeOverride → Veeqo
  // product tag, matched case-insensitively (frozen / chilled / refrigerated
  // all count as the cold chain → "Frozen"). We never guess: no signal → null.
  const m7tried: SourceAttempt[] = [{ source: "теги Veeqo первой позиции", ok: Boolean(m.productType) }];
  let productType = m.productType;
  if (!productType && orderId) {
    try {
      const orders = await veeqoFetch(`/orders?query=${encodeURIComponent(orderId)}&page_size=5`);
      const list: VeeqoOrder[] = Array.isArray(orders) ? (orders as VeeqoOrder[]) : [];
      // Prefer the order whose number matches exactly; otherwise the first hit.
      const order = list.find((o) => String(o?.number || "") === orderId) || list[0] || null;
      const lines: VeeqoLine[] = order?.line_items || [];
      const productIds = [
        ...new Set(
          lines
            .map((li) => li?.sellable?.product?.id ?? li?.sellable?.product_id ?? li?.sellable?.id)
            .filter((x): x is number => typeof x === "number")
        ),
      ];
      const skus = [
        ...new Set(
          lines.map((li) => String(li?.sellable?.sku_code ?? li?.sellable?.sku ?? "")).filter(Boolean)
        ),
      ];

      // Strictest class across all lines wins, so one frozen line classifies
      // the whole order as Frozen (FROZEN/CHILLED → "Frozen", DRY → "Dry").
      const RANK = { FROZEN: 3, CHILLED: 2, DRY: 1 } as const;
      const classes: Array<keyof typeof RANK> = [];
      const tagsSeen = new Set<string>();

      // 1. Owner's manual class (per SKU) — nothing reads a tag back over it.
      if (skus.length) {
        try {
          const manual = await prisma.skuTemperatureClass.findMany({
            where: { sku: { in: skus } },
            select: { class: true },
          });
          for (const r of manual) {
            const c = parseTempClass(r.class);
            if (c) classes.push(c);
          }
          if (manual.length) m7tried.push({ source: "ручной класс (SkuTemperatureClass)", ok: true });
        } catch {
          /* table missing / read error — fall through to legacy + tags */
        }
      }

      // 2. Legacy ProductTypeOverride, else the Veeqo product tag per product.
      for (const pid of productIds) {
        try {
          const override = await prisma.productTypeOverride.findUnique({ where: { productId: pid } });
          const legacy = parseTempClass(override?.type);
          if (legacy) {
            classes.push(legacy);
            continue;
          }
        } catch {
          /* ignore and try tags */
        }
        try {
          const product = (await getProduct(pid)) as { tags?: Array<string | { name?: string }> };
          for (const t of product?.tags || []) {
            const name = typeof t === "string" ? t : t?.name;
            if (!name) continue;
            tagsSeen.add(name);
            const c = parseTempClass(name);
            if (c) classes.push(c);
          }
        } catch (e) {
          m7tried.push({ source: `теги товара ${pid} (/products/:id)`, ok: false, note: errText(e) });
        }
      }

      const strictest = [...classes].sort((a, b) => RANK[b] - RANK[a])[0] || null;
      productType = strictest ? (strictest === "DRY" ? "Dry" : "Frozen") : null;
      if (productType) patch.productType = productType;
      m7tried.push({
        source: "теги товара Veeqo (/products/:id)",
        ok: Boolean(productType),
        note: productType
          ? undefined
          : tagsSeen.size
            ? `теги не содержат Frozen/Chilled/Dry (нашли: ${[...tagsSeen].join(", ")})`
            : "у товара нет тегов / заказ не найден в Veeqo",
      });
    } catch (e) {
      m7tried.push({ source: "теги Veeqo всех позиций", ok: false, note: errText(e) });
    }
  }
  items.push(item("M7", Boolean(productType), `Product type (Veeqo tag): ${productType}`, `тип ${productType}`, m7tried));

  // ── M8 what was already done ────────────────────────────────────────
  const m8tried: SourceAttempt[] = [];
  const done: string[] = [];
  let financesOk = false;
  if (orderId) {
    try {
      const fe = await getOrderFinancialEvents(orderId, storeId);
      financesOk = true;
      const refunds = fe?.RefundEventList || [];
      if (refunds.length) done.push(`${refunds.length} refund event(s)`);
      m8tried.push({ source: "SP-API Finances (возвраты)", ok: true });
    } catch (e) {
      m8tried.push({ source: "SP-API Finances (возвраты)", ok: false, note: errText(e) });
    }
    try {
      const claims = await prisma.atozzClaim.findMany({ where: { amazonOrderId: orderId } });
      for (const c of claims) done.push(`${c.claimType} claim (${c.claimReason || "reason n/a"})`);
      m8tried.push({ source: "A-to-Z / chargeback в базе", ok: true });
    } catch (e) {
      m8tried.push({ source: "A-to-Z / chargeback в базе", ok: false, note: errText(e) });
    }
    const ourReplies = thread.filter((t) => t.who === "us");
    if (ourReplies.length) done.push(`${ourReplies.length} earlier reply/replies from us`);
    m8tried.push({ source: "наши ответы по заказу", ok: true });
  }
  items.push(
    item(
      "M8",
      financesOk,
      `Already done on this order: ${done.length ? done.join("; ") : "nothing (no refunds, claims or replies)"}`,
      done.length ? `уже было: ${done.join("; ")}` : "возвратов, претензий и ответов не было",
      m8tried
    )
  );

  // ── Merge a finished VPS read-only lookup ───────────────────────────
  const vpsLookup = prev?.vpsLookup ?? null;
  const vr = (vpsLookup?.result || {}) as Record<string, unknown>;
  for (const it of items) {
    const v = vr[it.key];
    if (!it.present && typeof v === "string" && v.trim()) {
      it.present = true;
      it.fact = `${it.key} (Seller Central): ${v.trim().slice(0, 400)}`;
      it.factRu = v.trim().slice(0, 200);
      it.tried.push({ source: "Seller Central через VPS", ok: true });
    } else if (!it.present && vpsLookup) {
      it.tried.push({ source: "Seller Central через VPS", ok: false, note: vpsLookup.status === "DONE" ? "не нашли" : vpsLookup.status });
    }
  }

  return {
    snapshot: { collectedAt: new Date().toISOString(), items, vpsLookup },
    thread,
    patch,
  };
}
