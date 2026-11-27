import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buyShippingLabel,
  addEmployeeNote,
  updateOrderDispatchDate,
  getShippingRates,
  extractVasFromRate,
  updateAllocationPackage,
  veeqoFetch,
} from "@/lib/veeqo";
import { sendTelegramMessage } from "@/lib/telegram";
import { uploadLabelPdf } from "@/lib/google-drive";
import { buildFolderPath, buildPdfFilename } from "@/lib/shipping-label-files";
import { todayNY, utcToPacificYMD } from "@/lib/shipping/dates";
import { matchLiveRate } from "@/lib/shipping/requote-match";
import {
  describeUnavailableRates,
  fetchLiveRatesWithRetry,
} from "@/lib/shipping/rate-requote-retry";
import { iceExtraFromNotes } from "@/lib/shipping/temp-class/ice";
import { resolveBoxDimensions } from "@/lib/shipping/box-presets";
import { applyBuyOverride, hasRateFields, type BuyOverride } from "@/lib/shipping/buy-override";
import { computeFedexWeight, isFedexOneRateService } from "@/lib/shipping/fedex-weight";
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

// A bulk buy runs one label purchase per selected order. Even parallelised
// each order is several seconds of carrier round-trip, so the invocation must
// be allowed to outlive the platform default — every other long route in this
// codebase sets this explicitly and buy was the one that never did. Without
// it a bulk buy can be killed AFTER labels are purchased and money spent,
// surfacing as a failure on a purchase that actually succeeded.
export const maxDuration = 300;

// How many orders we buy at once. Orders are independent (each mutates only
// its own allocation + dispatch date), so parallelising is safe — but Veeqo
// rate-limits bursts, and a 429 on the purchase POST is deliberately NOT
// retried, so a wide pool would trade wall-clock for spurious failures the
// operator has to redo. Four keeps the pool well inside the burst budget the
// plan route already proved workable at five for reads.
const BUY_CONCURRENCY = 4;

// Flipped by the first request this function instance serves. A cold start
// pays for runtime boot plus module init before any of the code below runs,
// which is what makes the same click feel instant one minute and slow the
// next — so we record which one it was instead of guessing.
let instanceWarm = false;

// Run `fn` over `items` with at most `poolSize` concurrent executions. Each
// worker pulls the next index until the list is drained. Mirrors the helper
// in /api/shipping/plan.
async function mapPool<T>(
  items: T[],
  poolSize: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(poolSize, 1), items.length) },
    async () => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
}

// Append a single JSON line per /api/shipping/buy call. The file lives
// outside `public/` so it's never served to the browser. Used as a
// last-resort audit trail in case the post-buy modal is dismissed
// before the operator screenshots it. Non-fatal on write error — the
// API response and Telegram message are still authoritative.
function appendBuyLog(entry: Record<string, unknown>) {
  // Vercel serverless filesystem (/var/task) is read-only — skip local file
  // writes there so every buy doesn't emit a noisy ENOENT error in Vercel logs.
  if (process.env.VERCEL) return;
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
// algorithmically-picked rate. Type + merge live in lib/shipping/buy-override.

// Wall-clock of one awaited stage, recorded into `into` under `key`. Stage
// timings are what tell us where a slow buy actually went — the operator can't
// read Vercel logs, and guessing from the outside is how we ended up
// optimising the wrong things.
async function stage<T>(
  into: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    into[key] = (into[key] ?? 0) + (Date.now() - t0);
  }
}

export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now();
  // True only on the first request an instance ever serves — i.e. the one that
  // paid the cold start. Reported so a "why was that click slow" question can
  // be answered with a fact instead of a theory.
  const wasColdStart = !instanceWarm;
  instanceWarm = true;
  // Summed across orders, so with a parallel pool these deliberately add up to
  // more than the wall clock — the ratio between them is exactly what tells us
  // whether the pool is doing its job.
  const stageTotals: Record<string, number> = {};
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
      (i) => i.status === "pending" || (i.status === "stop" && hasRateFields(overrides[i.id])),
    );
    if (itemIds && itemIds.length > 0) {
      itemsToBuy = itemsToBuy.filter((i) => itemIds.includes(i.id));
    }
    // An item id the caller asked for that isn't a buyable item of THIS plan
    // used to vanish silently: the response said total 0, bought 0, errors 0
    // and the operator saw a Buy that "did nothing" with zeros. Name it.
    const requestedIds: string[] = Array.isArray(itemIds) ? itemIds : [];
    const missingIds = requestedIds.filter(
      (id) => !itemsToBuy.some((i) => i.id === id),
    );

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
        labelDate: string;
        physicalShipDate: string;
      }[],
      errors: [] as { orderNumber: string; error: string; itemId: string }[],
      total: itemsToBuy.length + missingIds.length,
    };
    for (const id of missingIds) {
      const stale = plan.items.find((i) => i.id === id);
      results.errors.push({
        orderNumber: stale?.orderNumber ?? "",
        error: stale
          ? `This order's rate is no longer buyable (status: ${stale.status}). Press Refresh and try again.`
          : "This order's rate belongs to a different plan — press Refresh and try again. Nothing was bought.",
        itemId: id,
      });
    }

    // Buy the selected orders concurrently. This used to be a plain
    // sequential loop, so a five-label bulk buy cost the SUM of five ~10-15s
    // purchase chains; now it costs roughly the slowest one. Each order only
    // ever touches its own allocation and its own dispatch date, and the two
    // shared sinks below (`results.bought` / `results.errors`) are plain array
    // pushes on a single-threaded runtime, so there is no cross-order state to
    // race on. The one-POST-per-order, no-retry rule is untouched.
    // NAN Health (Shopify) labels are bought in Shopify by default — Veeqo's
    // rates for these orders don't match Shopify's (owner, 2026-10-26). The
    // Veeqo buy is allowed only when Settings → "Allow buying NAN Health
    // labels through Veeqo" is on.
    const nanViaVeeqo =
      (
        await prisma.setting.findUnique({ where: { key: "nan_buy_via_veeqo" } })
      )?.value === "true";

    await mapPool(itemsToBuy, BUY_CONCURRENCY, async (rawItem) => {
      if (/nan/i.test(rawItem.channel ?? "") && !nanViaVeeqo) {
        results.errors.push({
          orderNumber: rawItem.orderNumber,
          error:
            "NAN Health order — labels are bought in Shopify. Turn on Settings → \"Allow buying NAN Health labels through Veeqo\" to buy it through Veeqo.",
          itemId: rawItem.id,
        });
        return;
      }
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
        return;
      }
      // Apply per-item override BEFORE the required-fields check so an
      // override carrying every needed identifier can rescue an item the
      // algorithm picked nothing for. Override fields take precedence; the
      // rest fall back to whatever the plan stored.
      const ov = overrides[rawItem.id];
      const item = applyBuyOverride(rawItem, ov);
      try {
        // NOTE: remoteShipmentId is intentionally NOT required here. Frozen
        // orders are quoted through the new Rate Shopping API, whose response
        // has no remote_shipment_id — and we don't need it: the buy re-quotes
        // the allocation live below and uses that fresh rate's
        // remote_shipment_id (buyRemoteShipmentId = fr.remote_shipment_id).
        // Requiring it here failed EVERY frozen bulk-buy with "Missing shipping
        // data".
        if (
          !item.allocationId || !item.carrierId ||
          !item.serviceType || !item.subCarrierId || !item.serviceCarrier ||
          !item.totalNetCharge || !item.baseRate
        ) {
          results.errors.push({ orderNumber: item.orderNumber, error: "Missing shipping data", itemId: item.id });
          return;
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
        const isFedexOneRate = isFedexOneRateService(item.service);
        const pushWeightLbs =
          item.weight != null && isFedexOneRate
            ? computeFedexWeight(item.weight)
            : item.weight;

        const boxDims = parseBoxSize(item.boxSize);
        if (pushWeightLbs != null && boxDims) {
          try {
            await stage(stageTotals, "veeqoPackagePush", () =>
              updateAllocationPackage(item.allocationId!, {
                weightLbs: pushWeightLbs,
                lengthIn: boxDims.l,
                widthIn: boxDims.w,
                heightIn: boxDims.h,
              }),
            );
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
        // Operator-facing reason + alternatives when the planned service
        // isn't in the live pool.
        let rateNotFound = "";
        // Set when we moved Veeqo's dispatch_date to re-quote; put back if
        // nothing gets bought, so the order keeps its real ship-by.
        let dispatchToRestore: string | null = null;
        const restoreDispatch = async () => {
          if (!dispatchToRestore) return;
          try {
            await updateOrderDispatchDate(item.orderId, dispatchToRestore);
          } catch (e) {
            console.warn(
              `[buy] could not restore dispatch_date for ${item.orderId}:`,
              e instanceof Error ? e.message : e,
            );
          }
        };
        try {
          // Matching rules (quote id → carrier+title → carrier+base title with
          // an EDD and price guard) live in requote-match.ts — see there for
          // why an exact title compare refused "(Saturday)" variants.
          // CRITICAL: never match by remote_shipment_id — it is the same value
          // for ALL rates within one allocation (Veeqo verified 2026-05-15).
          const want = {
            serviceType: item.serviceType,
            service: item.service,
            subCarrierId: item.subCarrierId,
            price:
              item.price ??
              (Number.isFinite(parseFloat(item.totalNetCharge))
                ? parseFloat(item.totalNetCharge)
                : null),
            edd: item.edd,
          };
          const requote = () =>
            stage(stageTotals, "veeqoRateRequote", () =>
              fetchLiveRatesWithRetry(() => getShippingRates(item.allocationId!)),
            );
          let { rates: liveRates, emptyDiag } = await requote();
          let m = matchLiveRate(liveRates, want);
          // The allocation pool's EDDs (and date-bound variants such as
          // "(Saturday)") are anchored to the order's Veeqo dispatch_date —
          // the marketplace ship-by, often days later than the day we ship.
          // The plan quoted the PHYSICAL ship day. When the service isn't in
          // the pool, re-anchor dispatch_date to the physical ship day and
          // re-quote once. (The trick path above already did this.)
          if (!m.rate && !trickApplies) {
            const ord = (await veeqoFetch(`/orders/${item.orderId}`)) as {
              dispatch_date?: string | null;
            };
            const current = ord?.dispatch_date ?? null;
            if (current && utcToPacificYMD(current) !== physicalShipDate) {
              await updateOrderDispatchDate(
                item.orderId,
                `${physicalShipDate}T06:59:59.000Z`,
              );
              dispatchToRestore = current;
              ({ rates: liveRates, emptyDiag } = await requote());
              m = matchLiveRate(liveRates, want);
            }
          }
          // When the legacy allocation pool came back empty across all retries,
          // Veeqo omits carrier rejection reasons unless
          // `format_with_unavailable_rates=true` is passed. Do one read-only
          // diagnostic fetch (if Veeqo now returns available rates, use them;
          // otherwise capture the exact rejection reasons + order/allocation
          // state so we know WHY Veeqo rejected the quote).
          let emptyOrderDiag = "";
          if (liveRates.length === 0) {
            try {
              const diagResp = (await getShippingRates(item.allocationId!, {
                includeUnavailable: true,
              })) as Record<string, unknown> | null | undefined;
              if (Array.isArray(diagResp?.available) && diagResp.available.length > 0) {
                liveRates = diagResp.available as Record<string, unknown>[];
                emptyDiag = null;
                m = matchLiveRate(liveRates, want);
              } else {
                const unavailDesc = describeUnavailableRates(diagResp);
                const [ordRes, noPkgRes] = await Promise.allSettled([
                  veeqoFetch(`/orders/${item.orderId}`),
                  getShippingRates(item.allocationId!, {
                    fromAllocationPackage: false,
                    includeUnavailable: true,
                  }),
                ]);
                const diagParts = [unavailDesc];
                if (ordRes.status === "fulfilled" && ordRes.value) {
                  const o = ordRes.value as {
                    status?: string;
                    dispatch_date?: string | null;
                    deliver_to?: { country?: string; state?: string; zip?: string; phone?: string };
                    allocations?: {
                      id?: number | string;
                      total_weight?: number | null;
                      allocation_package?: {
                        weight?: number | null;
                        weight_unit?: string | null;
                        depth?: number | null;
                        width?: number | null;
                        height?: number | null;
                        package_selection_source?: string | null;
                      } | null;
                    }[];
                    line_items?: { sellable?: { weight?: number | null; weight_unit?: string | null } }[];
                  };
                  const alloc =
                    o.allocations?.find((a) => String(a.id) === String(item.allocationId)) ??
                    o.allocations?.[0];
                  const pkg = alloc?.allocation_package;
                  const itemW = o.line_items?.[0]?.sellable?.weight ?? null;
                  diagParts.push(
                    `orderStatus=${o.status ?? "?"}`,
                    `allocW=${alloc?.total_weight ?? "null"}`,
                    `pkg=${pkg ? `${pkg.weight ?? "?"}${pkg.weight_unit ?? ""}/${pkg.depth ?? "?"}x${pkg.width ?? "?"}x${pkg.height ?? "?"}` : "null"}`,
                    `itemW=${itemW ?? "null"}`,
                    `to=${o.deliver_to?.state ?? "?"}/${o.deliver_to?.zip ?? "?"}/${o.deliver_to?.country ?? "?"}`,
                  );
                }
                if (noPkgRes.status === "fulfilled" && noPkgRes.value) {
                  const np = noPkgRes.value as Record<string, unknown>;
                  const npAvail = Array.isArray(np.available) ? np.available.length : 0;
                  diagParts.push(
                    `noPkgAvail=${npAvail}`,
                    ...(npAvail === 0 ? [`noPkg=${describeUnavailableRates(np)}`] : []),
                  );
                }
                emptyOrderDiag = diagParts.join(", ");
                console.warn(
                  `[buy-empty-diag] ${item.orderNumber} (order=${item.orderId}, alloc=${item.allocationId}): ${emptyOrderDiag}`,
                );
              }
            } catch (diagErr) {
              emptyOrderDiag = `diagErr=${diagErr instanceof Error ? diagErr.message : String(diagErr)}`;
            }
          }
          if (m.rate) {
            freshRate = m.rate;
            liveVas = extractVasFromRate(m.rate);
            // Lightweight diagnostic kept ONLY for the error messages below
            // (spliced into the thrown error when Veeqo rejects the buy).
            rateDiagnostic =
              `match=${m.tier} · rateKeys=[${Object.keys(m.rate).join(",")}] · ` +
              `extracted=${JSON.stringify(liveVas)}`;
          } else {
            rateNotFound = [
              m.reason,
              m.alternatives.length > 0
                ? `Closest live options: ${m.alternatives.join("; ")}. Pick one with the Carrier button, then Buy.`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            rateDiagnostic =
              `no rate match for service=${item.service} (${item.serviceType}), ` +
              `liveRatesCount=${liveRates.length}` +
              (liveRates.length === 0 && emptyDiag ? `, ${emptyDiag}` : "") +
              (liveRates.length === 0 && emptyOrderDiag ? `, ${emptyOrderDiag}` : "") +
              (dispatchToRestore ? `, re-anchored to ${physicalShipDate}` : "");
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
        // Operator manually picked a Label date (or confirmed one in PickRateDialog)
        // that equals the physical ship day (no Ship Date Trick). The trick path
        // above never ran, so Veeqo's dispatch_date may still sit on a different
        // marketplace ship-by (e.g. Monday after 15:00 ET when operator forces
        // Label = today) — push the chosen label date if Veeqo differs so the
        // printed label carries it. Best-effort: a failed PUT never blocks the
        // (single) buy, and if nothing gets bought restoreDispatch() puts the
        // original back.
        // (When the re-anchor above already moved dispatch_date to the
        // physical ship day — which equals labelDate here — it is a no-op.)
        if (!trickApplies && ov?.labelDate) {
          try {
            if (!dispatchToRestore) {
              const ord = (await veeqoFetch(`/orders/${item.orderId}`)) as {
                dispatch_date?: string | null;
              };
              const current = ord?.dispatch_date ?? null;
              if (!current || utcToPacificYMD(current) !== labelDate) {
                await updateOrderDispatchDate(
                  item.orderId,
                  `${labelDate}T06:59:59.000Z`,
                );
                dispatchToRestore = current;
              }
            }
          } catch (labelErr) {
            console.warn(
              `[buy] Could not set dispatch_date to manual labelDate ${labelDate} for ${item.orderId}:`,
              labelErr instanceof Error ? labelErr.message : labelErr,
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
          await restoreDispatch();
          throw new Error(
            `Could not re-quote "${item.service ?? item.serviceType}" — ` +
              `label NOT bought. ` +
              (rateNotFound ||
                "Refresh the list and try again.") +
              ` DIAG: ${rateDiagnostic}`,
          );
        }

        // Buy against the FRESH rate (quoted after the package push), not
        // the plan-time identifiers. Each field falls back to the stored
        // value only if absent on the live rate (shouldn't happen).
        const fr = freshRate;
        const str = (v: unknown, fallback: string): string =>
          v != null ? String(v) : fallback;
        const buyCarrierId = str(fr.carrier, item.carrierId);
        // item.remoteShipmentId is no longer guard-narrowed to non-null (frozen
        // new-API rates have none), so default it to "" — the live freshRate's
        // remote_shipment_id is what's actually used.
        const buyRemoteShipmentId = str(
          fr.remote_shipment_id,
          item.remoteShipmentId ?? "",
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
          shipment = await stage(stageTotals, "carrierLabelPurchase", () =>
            buyShippingLabel({
              allocationId: item.allocationId!,
              carrierId: buyCarrierId,
              remoteShipmentId: buyRemoteShipmentId,
              serviceType: buyServiceType,
              subCarrierId: buySubCarrierId,
              serviceCarrier: buyServiceCarrier,
              totalNetCharge: buyTotalNetCharge,
              baseRate: buyBaseRate,
              vas: liveVas,
            }),
          );
        } catch (buyErr) {
          await restoreDispatch();
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
              const pdfRes = await stage(stageTotals, "veeqoLabelPdf", () =>
              fetch(veeqoLabelUrl, veeqoLabelFetchOpts),
            );
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
              const filename = buildPdfFilename(item);
              // The Drive folder ALWAYS follows the physical ship day (the
              // day the warehouse hands the parcel over), never the label
              // date — even if the legacy actualShipDay column disagrees.
              const folderPath = buildFolderPath({
                ...item,
                actualShipDay: physicalShipDate,
              });
              // Hold the PDF bytes for the auto-print path. The same
              // buffer also feeds the Drive upload below.
              pdfBase64 = pdfBuf.toString("base64");

              // ── Drive upload (preferred) ────────────────────────────
              const drive = await stage(stageTotals, "driveUpload", () =>
                uploadLabelPdf({
                  folderSegments: folderPath.split("/"),
                  filename,
                  pdf: pdfBuf,
                }),
              );
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
          : ` | Ship: ${physicalShipDate}`;
        // Written AFTER the response goes out. The label is already bought by
        // this point, so making the operator wait on a warehouse note is pure
        // dead time — and worse, a Veeqo hiccup here used to fall into the
        // catch below and report a SUCCESSFUL purchase as failed. Its own
        // try/catch keeps it that way permanently: a note that doesn't land is
        // a log line, never a failed buy.
        // Live temperature-aware pick that uses the ice-extended day → tell
        // the warehouse how many extra gel-ice pieces go in (plan marks it
        // "[ice +N]"; the label weight already includes them).
        const iceExtra = iceExtraFromNotes(item.notes);
        const iceNote = iceExtra > 0 ? ` | ADD ${iceExtra} EXTRA ICE` : "";
        const noteText = `✅ Label Purchased: ${item.carrier} ${boughtService} $${boughtPrice ?? "?"} | Tracking: ${tracking}${shipDayNote}${iceNote}`;
        after(async () => {
          try {
            await addEmployeeNote(parseInt(item.orderId), noteText);
          } catch (noteErr) {
            console.warn(
              `[buy] employee note failed for ${item.orderNumber} (label IS bought):`,
              noteErr instanceof Error ? noteErr.message : noteErr,
            );
          }
        });

        // Update DB. Persist the carrier/service/price ACTUALLY bought (from
        // the fresh rate) so the row keeps showing the purchased service —
        // bought rows that re-quote later must not drift to a different rate.
        //
        // The label is already BOUGHT at this point, so a DB failure must not
        // turn it into "Buy failed": during Turso's write timeouts
        // (2026-10-26, 11–30 s or a 502) that branch showed an error for a
        // paid label, dropped its tracking number and invited a second buy.
        // Report the buy, and retry the bookkeeping in the background.
        const boughtData = {
          status: "bought",
          trackingNumber: tracking,
          labelPdfUrl: labelPath,
          service: boughtService,
          price: boughtPrice,
          // Keep the exact dates the label was bought with (manual Label /
          // Ship picks included) so the bought card shows what was used.
          labelDate,
          physicalShipDate,
          actualShipDay: physicalShipDate,
        };
        try {
          await prisma.shippingPlanItem.update({
            where: { id: item.id },
            data: boughtData,
          });
        } catch (dbErr) {
          console.error(
            `[buy] label IS bought for ${item.orderNumber} (${tracking}) but the DB update failed — retrying in background:`,
            dbErr instanceof Error ? dbErr.message : dbErr,
          );
          after(async () => {
            for (let attempt = 1; attempt <= 3; attempt++) {
              await new Promise((r) => setTimeout(r, 5_000 * attempt));
              try {
                await prisma.shippingPlanItem.update({
                  where: { id: item.id },
                  data: boughtData,
                });
                return;
              } catch (e) {
                console.error(
                  `[buy] background DB update ${attempt}/3 failed for ${item.orderNumber} (${tracking}):`,
                  e instanceof Error ? e.message : e,
                );
              }
            }
          });
        }

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
          labelDate,
          physicalShipDate,
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
    });

    // Mark the plan completed once nothing is left pending. Bookkeeping only —
    // nothing in the response depends on it, so it runs after the operator
    // already has their tracking numbers.
    after(async () => {
      try {
        const remaining = await prisma.shippingPlanItem.count({
          where: { planId, status: "pending" },
        });
        if (remaining === 0) {
          await prisma.shippingPlan.update({
            where: { id: planId },
            data: { status: "completed" },
          });
        }
      } catch (e) {
        console.warn(
          "[buy] plan completion bookkeeping failed:",
          e instanceof Error ? e.message : e,
        );
      }
    });

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

    const timing = {
      totalMs: Date.now() - requestStartedAt,
      orders: itemsToBuy.length,
      concurrency: Math.min(BUY_CONCURRENCY, itemsToBuy.length),
      coldStart: wasColdStart,
    };

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
      timing,
    });

    // One structured line per buy — this is what turns "it felt slow" into a
    // number we can act on. `stages` sums across orders, `totalMs` is the real
    // wall clock, so stages ≫ total is the parallel pool working as intended.
    console.log(
      `[buy] timing ${JSON.stringify({ ...timing, stages: stageTotals })}`,
    );

    return NextResponse.json(
      { ...results, timing: { ...timing, stages: stageTotals } },
      {
        headers: {
          // Visible in the browser's network panel without any log access, so
          // a slow click can be diagnosed from the operator's own machine.
          "Server-Timing": [
            `total;dur=${timing.totalMs}`,
            ...Object.entries(stageTotals).map(
              ([k, v]) => `${k};dur=${v}`,
            ),
            wasColdStart ? "cold;dur=0" : "warm;dur=0",
          ].join(", "),
        },
      },
    );
  } catch (error) {
    console.error("Buy labels error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to buy labels" },
      { status: 500 }
    );
  }
}
