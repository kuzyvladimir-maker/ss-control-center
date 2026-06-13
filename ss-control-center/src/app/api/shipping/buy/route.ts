import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buyShippingLabel,
  addEmployeeNote,
  updateOrderDispatchDate,
  getShippingRates,
  extractVasFromRate,
  updateAllocationPackage,
} from "@/lib/veeqo";
import { sendTelegramMessage } from "@/lib/telegram";
import { uploadLabelPdf } from "@/lib/google-drive";
import { buildFolderPath, buildPdfFilename } from "@/lib/shipping-label-files";
import { todayNY } from "@/lib/shipping/dates";
import { resolveBoxDimensions } from "@/lib/shipping/box-presets";
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

// Append a single JSON line per /api/shipping/buy call. The file lives
// outside `public/` so it's never served to the browser. Used as a
// last-resort audit trail in case the post-buy modal is dismissed
// before the operator screenshots it. Non-fatal on write error — the
// API response and Telegram message are still authoritative.
function appendBuyLog(entry: Record<string, unknown>) {
  try {
    const dir = join(process.cwd(), "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(join(dir, "shipping-buy.jsonl"), line + "\n");
  } catch (e) {
    console.error("[buy] audit log write failed:", e);
  }
}

// Walk a Veeqo shipment response looking for the tracking string.
// Handles every shape seen so far: top-level `tracking_number`, nested
// `shipment.tracking_number`, camelCase fallback, and the object form
// `{value: "1Z...", carrier: "UPS"}` returned by some carriers.
function pickTrackingString(shipment: unknown): string | null {
  if (!shipment || typeof shipment !== "object") return null;
  const s = shipment as Record<string, unknown>;
  const candidates: unknown[] = [
    s.tracking_number,
    s.trackingNumber,
    (s.shipment as Record<string, unknown> | undefined)?.tracking_number,
    (s.shipment as Record<string, unknown> | undefined)?.trackingNumber,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      const inner =
        (typeof obj.value === "string" && obj.value) ||
        (typeof obj.number === "string" && obj.number) ||
        (typeof obj.tracking_number === "string" && obj.tracking_number);
      if (inner) return inner;
    }
  }
  return null;
}

// FedEx One Rate declared-weight multiplier. One Rate labels carry a
// heavier weight than the catalog figure (Vladimir 2026-06-09: +20%).
// Applied only to the weight pushed to Veeqo for FedEx One Rate labels.
const FEDEX_ONE_RATE_WEIGHT_MULT = 1.2;

// Parse the plan item's boxSize into numbers. Handles BOTH "LxWxH"
// (e.g. "12x12x10") AND named presets ("XL", "M", …) via resolveBoxDimensions —
// a named box previously returned null here, so the dim-push was skipped and the
// label bought against Veeqo's stale package (wrong weight/size). Returns null
// only when the string is missing or genuinely unresolvable.
function parseBoxSize(
  boxSize: string | null | undefined,
): { l: number; w: number; h: number } | null {
  const d = resolveBoxDimensions(boxSize);
  return d ? { l: d.length, w: d.width, h: d.height } : null;
}

// Per-itemId override: operator picked a different carrier/service through
// /shipping's PickRateDialog. When present we substitute these fields into
// the item before the buy call hits Veeqo, instead of using the
// algorithmically-picked rate.
interface BuyOverride {
  carrierId?: string | null;
  remoteShipmentId?: string | null;
  serviceType?: string | null;
  subCarrierId?: string | null;
  serviceCarrier?: string | null;
  totalNetCharge?: string | null;
  baseRate?: string | null;
  carrier?: string | null;
  service?: string | null;
  // Physical ship day the operator forced via the inline picker / rate modal.
  // When present it becomes the dispatch date the label is bought against
  // (the dispatch-date dance below keys off item.physicalShipDate).
  physicalShipDate?: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { planId, itemIds } = body;
    const overrides: Record<string, BuyOverride> = body.overrides ?? {};
    // Walmart orders are bought through Walmart's own Ship-with-Walmart API
    // (/api/shipping/walmart/buy), NOT through Veeqo. This generic Veeqo buy
    // route must REFUSE Walmart-channel items unless the caller explicitly
    // opts in — which the UI does only when the operator has flipped the
    // Walmart buy-source toggle to "veeqo" (the deliberate fallback for when
    // Walmart's API is down). Without this, a Walmart order that slipped into
    // a Veeqo buy would get a SECOND label on top of its Walmart one.
    // (Vladimir 2026-06-10: never buy Walmart labels via Veeqo unless I set
    // the toggle myself.)
    const allowWalmartViaVeeqo = body.allowWalmartViaVeeqo === true;

    if (!planId) {
      return NextResponse.json(
        { error: "planId is required" },
        { status: 400 }
      );
    }

    const plan = await prisma.shippingPlan.findUnique({
      where: { id: planId },
      include: { items: true },
    });

    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    // Normally only "pending" items are buyable. But an item the algorithm
    // stopped (status "stop" — e.g. "no rate delivers by the deadline") can
    // still be bought when the operator supplies a full manual rate override
    // for it: that's the operator explicitly choosing to ship a late/other
    // rate, taking responsibility for the deadline miss. The per-item
    // override merge + required-fields check below already guard against an
    // incomplete override, so including stopped-but-overridden items here is
    // safe — they fail the required-fields check if the override is partial.
    let itemsToBuy = plan.items.filter(
      (i) => i.status === "pending" || !!overrides[i.id],
    );
    if (itemIds && itemIds.length > 0) {
      itemsToBuy = itemsToBuy.filter((i) => itemIds.includes(i.id));
    }

    const results = {
      bought: [] as {
        orderNumber: string;
        tracking: string;
        itemId: string;
        labelPath: string | null;
        // Explicit so the post-buy modal can flag "label bought but PDF
        // not saved locally" — Veeqo has the label, our disk doesn't.
        pdfSaved: boolean;
        // Which persistence path actually placed the file. "drive"
        // means the operator can find it on the shared Drive; "proxy"
        // means it's only retrievable via our `/api/shipping/label-pdf`
        // pass-through (nothing was persisted on our side or on Drive).
        // Surfaced in the post-buy modal so silent Drive failures stop
        // looking like successes.
        pdfSource: "drive" | "disk" | "proxy" | "none";
        // Reason Drive upload didn't happen, if it didn't. Useful for
        // diagnosing without spelunking Vercel logs.
        driveError: string | null;
        carrier: string | null;
        service: string | null;
        price: number | null;
        // Auto-print fields (Print-mode toggle on shipping page). Client
        // ships pdfBase64 → DYMO Connect → on success calls
        // /api/shipping/mark-label-printed with driveFileId to move the
        // Drive file into the Printed/ subfolder.
        pdfBase64: string | null;
        driveFileId: string | null;
      }[],
      errors: [] as { orderNumber: string; error: string; itemId: string }[],
      total: itemsToBuy.length,
    };

    // Look up Frozen Analytics v2 alerts for every order we're about to buy
    // a label for. Used downstream to prepend a risk tag to the PDF filename
    // so warehouse / Drive listings surface the recommendation. One batch
    // query, indexed by orderNumber for O(1) lookup in the loop below.
    const orderNumbersToBuy = itemsToBuy
      .map((i) => i.orderNumber)
      .filter((n): n is string => !!n);
    const frozenAlerts =
      orderNumbersToBuy.length > 0
        ? await prisma.frozenRiskAlert.findMany({
            where: { orderId: { in: orderNumbersToBuy } },
            orderBy: { createdAt: "desc" },
          })
        : [];
    const frozenByOrder = new Map<
      string,
      { level: string; shortAdvice: string | null }
    >();
    for (const a of frozenAlerts) {
      if (frozenByOrder.has(a.orderId)) continue; // take the freshest only
      let firstRec: string | null = null;
      try {
        const arr = JSON.parse(a.recommendations) as string[];
        firstRec = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
      } catch {
        firstRec = null;
      }
      frozenByOrder.set(a.orderId, {
        level: a.riskLevel,
        shortAdvice: firstRec,
      });
    }

    for (const rawItem of itemsToBuy) {
      // Hard guard: never buy a Walmart-channel order through Veeqo unless the
      // operator explicitly opted in via the Walmart buy-source toggle. The UI
      // already routes Walmart→Walmart by default; this is the server-side
      // enforcement so it can't happen by accident (a stale toggle, a direct
      // API call, a future code path) and double-buy on top of the Walmart
      // label.
      if (
        (rawItem.channelKind ?? "").toLowerCase() === "walmart" &&
        !allowWalmartViaVeeqo
      ) {
        results.errors.push({
          orderNumber: rawItem.orderNumber,
          error:
            "Walmart order — labels are bought via Walmart, not Veeqo. Switch the Walmart buy source to Veeqo if you intend to buy this one through Veeqo.",
          itemId: rawItem.id,
        });
        continue;
      }
      // Apply per-item override BEFORE the required-fields check so an
      // override carrying every needed identifier can rescue an item the
      // algorithm picked nothing for. Override fields take precedence; the
      // rest fall back to whatever the plan stored.
      const ov = overrides[rawItem.id];
      const item = ov
        ? {
            ...rawItem,
            carrierId: ov.carrierId ?? rawItem.carrierId,
            remoteShipmentId:
              ov.remoteShipmentId ?? rawItem.remoteShipmentId,
            serviceType: ov.serviceType ?? rawItem.serviceType,
            subCarrierId: ov.subCarrierId ?? rawItem.subCarrierId,
            serviceCarrier: ov.serviceCarrier ?? rawItem.serviceCarrier,
            totalNetCharge: ov.totalNetCharge ?? rawItem.totalNetCharge,
            baseRate: ov.baseRate ?? rawItem.baseRate,
            carrier: ov.carrier ?? rawItem.carrier,
            service: ov.service ?? rawItem.service,
            // A forced ship date overrides BOTH date columns so the
            // dispatch-date dance (keyed on physicalShipDate) buys against the
            // chosen day, and the warehouse note reflects it.
            physicalShipDate:
              ov.physicalShipDate ?? rawItem.physicalShipDate,
            actualShipDay: ov.physicalShipDate ?? rawItem.actualShipDay,
          }
        : rawItem;
      try {
        if (
          !item.allocationId || !item.carrierId || !item.remoteShipmentId ||
          !item.serviceType || !item.subCarrierId || !item.serviceCarrier ||
          !item.totalNetCharge || !item.baseRate
        ) {
          results.errors.push({ orderNumber: item.orderNumber, error: "Missing shipping data", itemId: item.id });
          continue;
        }

        // ── Set OUR package dims in Veeqo BEFORE quoting/buying ─────────
        // The label is bought against the allocation_package currently on
        // the Veeqo allocation — NOT against any weight/dims in the buy
        // POST (Veeqo's /shipping/shipments ignores those). So set the
        // package from the operator's catalog dims (stored on the plan
        // item) here, immediately before the live re-quote below, leaving
        // no window for Veeqo to fall back to a default/Amazon-supplied
        // package. This is the fix for labels printing at the wrong
        // weight/box (card said 10lbs/12×12×10, label came out 7lbs/
        // 10×8×6). Done first, before the dispatch-date dance, so a push
        // failure aborts cleanly without leaving dispatch_date shifted.
        //
        // If we have dims but the push fails, ABORT this label — a
        // wrong-dimension label costs real money and can't be un-bought;
        // a refused buy the operator can retry is strictly safer.
        // FedEx One Rate weight bump (+20%, Vladimir 2026-06-09; MASTER_PROMPT
        // §4). One Rate labels must carry a heavier declared weight than the
        // catalog figure. The bump is applied ONLY to the weight pushed to
        // Veeqo for the label — the catalog/card weight stays as entered
        // (e.g. card shows 10lbs, the FedEx One Rate label prints 12lbs).
        // Detected from the chosen service title containing "one rate"
        // (operator confirmed Veeqo names One Rate services that way). Other
        // FedEx services (Ground/Home/Economy) and all UPS/USPS use the
        // catalog weight unchanged.
        const isFedexOneRate =
          String(item.service ?? "").toLowerCase().includes("one rate");
        const pushWeightLbs =
          item.weight != null && isFedexOneRate
            ? Math.round(item.weight * FEDEX_ONE_RATE_WEIGHT_MULT * 100) / 100
            : item.weight;

        const boxDims = parseBoxSize(item.boxSize);
        if (pushWeightLbs != null && boxDims) {
          try {
            await updateAllocationPackage(item.allocationId, {
              weightLbs: pushWeightLbs,
              lengthIn: boxDims.l,
              widthIn: boxDims.w,
              heightIn: boxDims.h,
            });
          } catch (pkgErr) {
            const reason =
              pkgErr instanceof Error ? pkgErr.message : String(pkgErr);
            throw new Error(
              `Could not set package size in Veeqo ` +
                `(${pushWeightLbs}lbs ${boxDims.l}x${boxDims.w}x${boxDims.h}) — ` +
                `label NOT bought to avoid wrong dimensions. ${reason}`,
            );
          }
        }

        // v3.3 §13 — dual-date dance. The two dates on the plan item:
        //
        //   labelDate         — what Amazon sees on the printed label.
        //                       Drives Late Shipment Rate, so it must
        //                       stay as today (or as computed by §0.1
        //                       cutoff logic).
        //   physicalShipDate  — when the warehouse actually hands the
        //                       package to the carrier. May be pushed
        //                       to next Monday by the Frozen Ship Date
        //                       Trick.
        //
        // The trick: if the two diverge, we PUT dispatch_date to
        // physicalShipDate first so Veeqo regenerates the right rate
        // pool, THEN PUT it back to labelDate so the actual label
        // prints with today's date. The rate identifier (`name` /
        // `service_type`) we feed into buyShippingLabel below was
        // selected against the physicalShipDate rate pool but stays
        // valid across the second PUT.
        //
        // Falls back to `actualShipDay` (legacy column) when the new
        // labelDate / physicalShipDate columns aren't yet populated —
        // the dual-date migration was deployed alongside this code,
        // so rows planned before the Turso migration ran will still
        // have only the legacy field set.
        // Anchor today in Eastern (Miami). UTC slice would land in the
        // wrong day for late-evening NY buys and break the Ship Date Trick
        // pre-shift (we'd PUT dispatch_date = "tomorrow + 06:59 UTC" instead
        // of today).
        const todayIso = todayNY();
        const physicalShipDate =
          item.physicalShipDate || item.actualShipDay || todayIso;
        const labelDate = item.labelDate || todayIso;
        const trickApplies = physicalShipDate !== labelDate;

        if (trickApplies) {
          try {
            // Step 1 — temporarily move dispatch_date to physicalShipDate
            // so the rates we re-fetch below match what the plan stored.
            await updateOrderDispatchDate(
              item.orderId,
              `${physicalShipDate}T06:59:59.000Z`
            );
          } catch (shiftErr) {
            console.warn(
              `[buy] Could not pre-shift dispatch_date for order ${item.orderId} to ${physicalShipDate}:`,
              shiftErr instanceof Error ? shiftErr.message : shiftErr
            );
          }
        }

        // Re-fetch live rates so we can read the actual Value-Added-
        // Service requirements from the matching rate. Veeqo's Amazon
        // Shipping V2 errors with INVALID_VALUE_ADDED_SERVICES if the
        // request VAS doesn't match what the rate offers — the only
        // reliable source is GetRates at purchase time, not what was
        // stored on the plan when rates were originally pulled.
        let liveVas: Record<string, string> = {};
        // The matched live rate. We buy against THIS (its remote_shipment_id
        // / total_net_charge / base_rate / name), not the identifiers stored
        // on the plan at plan-time, because those were quoted against an
        // older package. Re-quoting after the package push above guarantees
        // the purchased label matches the dims we just set.
        let freshRate: Record<string, unknown> | null = null;
        // Captured here so we can splice it into the error message when
        // Veeqo rejects the purchase — Vercel logs aren't visible to the
        // operator, but the modal is, so we surface the diagnostic
        // straight through the UI for one-shot debugging.
        let rateDiagnostic = "";
        try {
          const liveResp = await getShippingRates(item.allocationId);
          const liveRates: Record<string, unknown>[] =
            (liveResp?.available as Record<string, unknown>[]) || [];
          // CRITICAL: match by `name` (= the per-service UUID), NOT by
          // `remote_shipment_id`. The latter is the same value for ALL
          // rates within one allocation (Veeqo verified 2026-05-15:
          // 16 different rates on one allocation, all rsi=prb1fd6e1be),
          // so find() by rsi returns whichever rate is FIRST in the
          // array — almost always FedEx Ground Economy (SmartPost) —
          // regardless of which carrier we actually picked. This caused
          // every buy to send the SmartPost VAS contract (or lack
          // thereof) to Veeqo, hitting INVALID_VALUE_ADDED_SERVICES on
          // every UPS Ground Saver, FedEx Home Delivery, etc.
          // Frozen orders are now SELECTED via the new Rate Shopping API
          // (getRatesForShipDate), whose per-quote `rate_id` is stored in
          // item.serviceType. That id will NOT exist in this OLD allocation-
          // rates pool, so the name match fails and we fall back to matching
          // the SERVICE (carrier + title). The label we buy is the correct
          // service — the new API was only used to pick which service + which
          // physical ship day; the physical label itself is bought through the
          // allocation flow. Title is compared case-insensitively because the
          // two endpoints differ in casing (new: "Fedex 2Day® One Rate", old:
          // "FedEx 2Day® One Rate") — an exact compare would wrongly refuse
          // every FedEx frozen buy.
          const svcTitleLow = (item.service ?? "").trim().toLowerCase();
          const match =
            liveRates.find((r) => String(r.name) === item.serviceType) ??
            liveRates.find(
              (r) =>
                String(r.sub_carrier_id) === item.subCarrierId &&
                String(r.title).trim().toLowerCase() === svcTitleLow
            );
          if (match) {
            freshRate = match;
            liveVas = extractVasFromRate(match);
            // Capture every field whose name might hint at VAS or rate
            // requirements — the extractor uses `value_added_service*`
            // by convention, but Veeqo may have moved/renamed it.
            // Lightweight diagnostic kept ONLY for the error messages below
            // (spliced into the thrown error when Veeqo rejects the buy). The
            // old code also built a full `suspiciousFields` scan of every rate
            // key and logged it on EVERY successful buy — pure happy-path
            // noise/CPU, removed.
            rateDiagnostic =
              `rateKeys=[${Object.keys(match).join(",")}] · ` +
              `extracted=${JSON.stringify(liveVas)}`;
          } else {
            rateDiagnostic =
              `no rate match for remote_shipment_id=${item.remoteShipmentId}, ` +
              `service=${item.serviceType}, ` +
              `liveRatesCount=${liveRates.length}`;
            console.warn(
              `[buy] no live rate match for ${item.orderNumber} (${rateDiagnostic})`
            );
          }
        } catch (rateErr) {
          rateDiagnostic = `rate re-fetch failed: ${
            rateErr instanceof Error ? rateErr.message : String(rateErr)
          }`;
          console.warn(
            `[buy] live rate re-fetch failed for ${item.orderNumber}:`,
            rateErr instanceof Error ? rateErr.message : rateErr
          );
        }

        // v3.3 §13 step 4 — restore dispatch_date to labelDate BEFORE
        // POST /shipping/shipments. If we leave it at physicalShipDate
        // (Monday), Veeqo writes the label with that ship date and
        // Amazon sees a late shipment → Late Shipment Rate +1. The
        // rate selected on the physicalShipDate pool is still valid
        // for the POST — we tested 2026-05-15 that buy accepts a
        // service_type chosen against Monday rates even after the
        // dispatch_date flips back to today.
        if (trickApplies) {
          try {
            await updateOrderDispatchDate(
              item.orderId,
              `${labelDate}T06:59:59.000Z`
            );
          } catch (restoreErr) {
            // Continue with the buy — the label might still print with
            // the Monday date, in which case the warehouse note + Drive
            // folder will still be correct. Amazon stats take the hit.
            console.warn(
              `[buy] Could not restore dispatch_date to labelDate ${labelDate} for ${item.orderId}:`,
              restoreErr instanceof Error ? restoreErr.message : restoreErr
            );
          }
        }

        // Refuse to buy if we couldn't re-quote the chosen service against
        // the package we just set. Buying with the plan-time identifiers
        // here is exactly what produced wrong-dimension labels — the stored
        // remote_shipment_id / total_net_charge were quoted against an older
        // package. A refused buy is recoverable (operator hits Refresh and
        // retries); a wrong label isn't.
        if (!freshRate) {
          throw new Error(
            `Could not re-quote "${item.service ?? item.serviceType}" at the ` +
              `current package size — label NOT bought to avoid wrong ` +
              `dimensions/price. Refresh the list and try again. ` +
              `DIAG: ${rateDiagnostic}`,
          );
        }

        // Buy against the FRESH rate (quoted after the package push), not
        // the plan-time identifiers. Each field falls back to the stored
        // value only if absent on the live rate (shouldn't happen).
        const fr = freshRate;
        const str = (v: unknown, fallback: string): string =>
          v != null ? String(v) : fallback;
        const buyCarrierId = str(fr.carrier, item.carrierId);
        const buyRemoteShipmentId = str(
          fr.remote_shipment_id,
          item.remoteShipmentId,
        );
        const buyServiceType = str(fr.name, item.serviceType);
        const buySubCarrierId = str(fr.sub_carrier_id, item.subCarrierId);
        const buyServiceCarrier = str(fr.service_carrier, item.serviceCarrier);
        const buyTotalNetCharge = str(fr.total_net_charge, item.totalNetCharge);
        const buyBaseRate = str(fr.base_rate, item.baseRate);
        // Human-facing carrier/service/price actually purchased — persisted
        // on the item and echoed to the UI so bought rows show what was
        // really bought, not a later re-quote.
        const boughtService = str(fr.title, item.service ?? "");
        const boughtPrice =
          fr.total_net_charge != null
            ? parseFloat(String(fr.total_net_charge))
            : item.price;

        // Single-shot buy. Veeqo's contract:
        //   • shipping_service_options=null  → don't send any VAS keys.
        //     extractVasFromRate returns {} in this case.
        //   • shipping_service_options=array → send the extracted keys.
        // Both paths are handled inside extractVasFromRate, so we don't
        // need any per-carrier branching or retry-with-alternates here.
        let shipment: Awaited<ReturnType<typeof buyShippingLabel>>;
        try {
          shipment = await buyShippingLabel({
            allocationId: item.allocationId,
            carrierId: buyCarrierId,
            remoteShipmentId: buyRemoteShipmentId,
            serviceType: buyServiceType,
            subCarrierId: buySubCarrierId,
            serviceCarrier: buyServiceCarrier,
            totalNetCharge: buyTotalNetCharge,
            baseRate: buyBaseRate,
            vas: liveVas,
          });
        } catch (buyErr) {
          const baseMsg =
            buyErr instanceof Error ? buyErr.message : String(buyErr);
          throw new Error(`${baseMsg} || DIAG: ${rateDiagnostic}`);
        }

        // Extract tracking — Veeqo's shape is inconsistent across
        // carriers. tracking_number can be a string OR an object with
        // {value, carrier, …}; sometimes it lives on shipment.shipment.
        // Previous String(...) coercion of an object produced
        // "[object Object]" in the employee note and Telegram summary.
        const tracking = pickTrackingString(shipment) ?? "N/A";

        // Persist the PDF, with three escalating layers so a single
        // failure never loses the label:
        //   1. Google Drive (real persistent storage; matches the
        //      operator's expected folder structure on shared Drive).
        //   2. Local disk in public/labels/… (only useful for dev/
        //      self-hosted; on Vercel the file system is ephemeral).
        //   3. Veeqo's own hosted label_url (always available because
        //      we just got it back in the buy response; saved verbatim
        //      so the operator can always click "Open PDF" in the modal
        //      even if Drive and disk both failed).
        let labelPath: string | null = null;
        let pdfSource: "drive" | "disk" | "proxy" | "none" = "none";
        let driveError: string | null = null;
        // Surface to the client for auto-print: pdfBase64 → DYMO Connect,
        // driveFileId → /api/shipping/mark-label-printed after success.
        let pdfBase64: string | null = null;
        let driveFileId: string | null = null;
        const shipmentId =
          shipment?.id ?? shipment?.shipment?.id ?? null;

        // Build the Veeqo PDF URL from `shipment.id` directly rather
        // than trusting `shipment.label_url`. Empirically, Veeqo
        // sometimes omits `label_url` from the `POST /shipping/shipments`
        // response (observed 2026-05-14 on order 114-8515802-0978666 —
        // buy succeeded, but `label_url` was absent → Drive upload was
        // skipped entirely and the PDF never made it to Drive). The
        // `/shipping/labels?shipment_ids[]=X&format=pdf` endpoint is
        // identical to what `label_url` would point to, so deriving it
        // from `shipment.id` is more reliable and matches what the
        // `/api/shipping/label-pdf` proxy does anyway.
        let veeqoLabelUrl: string | null = null;
        let veeqoLabelFetchOpts: RequestInit | undefined;
        if (shipmentId) {
          const base = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
          veeqoLabelUrl =
            `${base}/shipping/labels?shipment_ids%5B%5D=${shipmentId}&format=pdf`;
          veeqoLabelFetchOpts = {
            headers: {
              "x-api-key": process.env.VEEQO_API_KEY || "",
              Accept: "application/pdf",
            },
          };
        }

        if (veeqoLabelUrl) {
          try {
            const pdfRes = await fetch(veeqoLabelUrl, veeqoLabelFetchOpts);
            if (!pdfRes.ok) {
              console.error(
                `[buy] PDF download from Veeqo failed: HTTP ${pdfRes.status}`
              );
            } else {
              const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
              // Magic-byte guard. Same endpoint without format=pdf
              // returns the JSON counter `{"labels_count": 1}` (~18
              // bytes). If we somehow got that back, skip persistence
              // rather than pollute Drive with junk masquerading as PDF.
              const isPdf =
                pdfBuf.length >= 1000 &&
                pdfBuf.slice(0, 5).toString("ascii") === "%PDF-";
              if (!isPdf) {
                console.error(
                  `[buy] Veeqo returned non-PDF (${pdfBuf.length} bytes): ${pdfBuf
                    .slice(0, 80)
                    .toString("utf-8")}`
                );
              } else {
              const frozenHint = frozenByOrder.get(item.orderNumber) ?? null;
              const filename = buildPdfFilename(item, frozenHint);
              const folderPath = buildFolderPath(item);
              // Hold the PDF bytes for the auto-print path. The same
              // buffer also feeds the Drive upload below.
              pdfBase64 = pdfBuf.toString("base64");

              // ── Drive upload (preferred) ────────────────────────────
              const drive = await uploadLabelPdf({
                folderSegments: folderPath.split("/"),
                filename,
                pdf: pdfBuf,
              });
              if (drive.ok) {
                labelPath = drive.result.webViewLink;
                driveFileId = drive.result.fileId;
                pdfSource = "drive";
              } else {
                driveError = drive.reason;
                console.warn(
                  `[buy] Drive upload failed for ${item.orderNumber}: ${drive.reason}`
                );
              }

              // ── Local disk (dev only — on Vercel this writes to an
              //    ephemeral /tmp-style mount that's gone after the
              //    response). Skip if Drive succeeded so we don't waste
              //    invocation time on a write that won't outlive the
              //    request. ─────────────────────────────────────────
              if (!drive.ok) {
                try {
                  const folderRel = `labels/${folderPath}`;
                  const folderAbs = join(process.cwd(), "public", folderRel);
                  if (!existsSync(folderAbs)) {
                    mkdirSync(folderAbs, { recursive: true });
                  }
                  const filePath = join(folderAbs, filename);
                  writeFileSync(filePath, pdfBuf);
                  labelPath = `/${folderRel}/${encodeURIComponent(filename)}`;
                  pdfSource = "disk";
                } catch (diskErr) {
                  console.warn(
                    "[buy] local disk save failed (expected on Vercel):",
                    diskErr instanceof Error ? diskErr.message : diskErr
                  );
                }
              }
              }
            }
          } catch (pdfErr) {
            console.error("[buy] PDF persistence error:", pdfErr);
          }
        }

        // Always fall back to OUR proxy endpoint. We can't link the
        // operator directly to Veeqo's URL because it needs the
        // x-api-key header — `/api/shipping/label-pdf?shipmentId=X`
        // fetches the PDF on the server (with auth) and streams it
        // back. Same-origin, no auth issues, always works as long as
        // the shipment exists in Veeqo.
        if (!labelPath && shipmentId) {
          labelPath = `/api/shipping/label-pdf?shipmentId=${shipmentId}`;
          pdfSource = "proxy";
        }

        // Employee note. v3.3 §10 — when labelDate and
        // physicalShipDate diverge, surface BOTH so the warehouse
        // worker can't confuse the printed label date for the actual
        // ship-out date.
        const shipDayNote = trickApplies
          ? ` | Label: ${labelDate} · 📅 SHIP ON ${physicalShipDate}`
          : ` | Ship: ${labelDate}`;
        await addEmployeeNote(
          parseInt(item.orderId),
          `✅ Label Purchased: ${item.carrier} ${boughtService} $${boughtPrice ?? "?"} | Tracking: ${tracking}${shipDayNote}`
        );

        // Update DB. Persist the carrier/service/price ACTUALLY bought (from
        // the fresh rate) so the row keeps showing the purchased service —
        // bought rows that re-quote later must not drift to a different rate.
        await prisma.shippingPlanItem.update({
          where: { id: item.id },
          data: {
            status: "bought",
            trackingNumber: tracking,
            labelPdfUrl: labelPath,
            service: boughtService,
            price: boughtPrice,
          },
        });

        results.bought.push({
          orderNumber: item.orderNumber,
          tracking,
          itemId: item.id,
          labelPath,
          pdfSaved: labelPath != null,
          pdfSource,
          driveError,
          carrier: item.carrier,
          service: boughtService,
          price: boughtPrice,
          pdfBase64,
          driveFileId,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Buy error for ${item.orderNumber}:`, error);
        results.errors.push({ orderNumber: item.orderNumber, error: msg, itemId: item.id });

        try {
          await prisma.shippingPlanItem.update({
            where: { id: item.id },
            data: { status: "error", notes: msg.substring(0, 500) },
          });
        } catch (dbErr) {
          console.error("DB update error:", dbErr);
        }
      }
    }

    // Update plan status if all bought
    const remaining = await prisma.shippingPlanItem.count({
      where: { planId, status: "pending" },
    });
    if (remaining === 0) {
      await prisma.shippingPlan.update({
        where: { id: planId },
        data: { status: "completed" },
      });
    }

    // Telegram summary OFF by default (Vladimir 2026-06-08 — redundant with the
    // Shipping UI, which already shows bought labels + errors). Flip
    // TELEGRAM_SHIPPING_BUY_ENABLED=true on Vercel to restore the DM summary.
    if (process.env.TELEGRAM_SHIPPING_BUY_ENABLED === "true") {
      const summary = [
        `📦 Shipping Labels — ${plan.date}`,
        `✅ Bought: ${results.bought.length}`,
        results.errors.length > 0
          ? `❌ Errors: ${results.errors.length}\n${results.errors.map((e) => `  ${e.orderNumber}: ${e.error}`).join("\n")}`
          : null,
      ].filter(Boolean).join("\n");
      await sendTelegramMessage(summary);
    }

    appendBuyLog({
      planId,
      planDate: plan.date,
      requested: itemsToBuy.length,
      bought: results.bought.map((b) => ({
        orderNumber: b.orderNumber,
        tracking: b.tracking,
        pdfSaved: b.pdfSaved,
        labelPath: b.labelPath,
        carrier: b.carrier,
        service: b.service,
        price: b.price,
        // Diagnostic — distinguishes Drive success from the silent proxy
        // fallback that made the 2026-05-15 outage look like success in
        // the UI. Audit trail needed for post-incident reviews.
        pdfSource: b.pdfSource,
        driveError: b.driveError,
      })),
      errors: results.errors.map((e) => ({
        orderNumber: e.orderNumber,
        error: e.error,
      })),
    });

    return NextResponse.json(results);
  } catch (error) {
    console.error("Buy labels error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to buy labels" },
      { status: 500 }
    );
  }
}
