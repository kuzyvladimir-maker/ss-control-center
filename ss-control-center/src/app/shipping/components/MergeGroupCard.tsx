"use client";

// One merged group: the orders that will travel in a single box, plus the
// combined package the operator enters for it.
//
// Weight and box are NOT inherited from any member and NOT guessed. Merging
// two orders makes a physically different parcel, and for frozen goods the
// cooler size drives everything downstream, so the operator states the type and
// the dimensions and the rate is quoted from those. That is also why there is
// no capacity check here: the person packing the box is the one who knows
// whether it fits.
//
// The label is bought against the PRIMARY member — the earliest order, which
// carries the tightest dispatch deadline in the normal case. Every other member
// is ship-confirmed with that label's tracking.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Package, Trash2, Check, ShoppingCart } from "lucide-react";
import { cn } from "@/lib/utils";
import { BoxPresetPicker } from "./BoxPresetPicker";
import { WeightInput, type WeightUnit, toLbs } from "./WeightInput";

export interface MergeGroupCardGroup {
  id: string;
  channelKind: string;
  storeName: string | null;
  primaryOrderId: string;
  productType: string | null;
  boxSize: string | null;
  weight: number | null;
  status: string;
  trackingNumber: string | null;
  carrier: string | null;
  service: string | null;
  price: number | null;
  labelPdfUrl: string | null;
  members: Array<{
    id: string;
    orderId: string;
    orderNumber: string;
    allocationId: string | null;
    walmartPurchaseOrderId: string | null;
    shipmentSyncedAt: string | null;
    shipmentSyncError: string | null;
  }>;
}

interface OrderLite {
  orderId: string;
  orderNumber: string;
  storeName: string;
  customerName?: string | null;
  city?: string | null;
  shipToState?: string | null;
  items: Array<{ sku: string; productTitle: string; quantity: number }>;
}

// One quoted option. The two channels name their fields differently, so the
// card keeps both shapes and hands back whichever the buy endpoint needs.
interface GroupRate {
  // Veeqo
  name?: string;
  title?: string;
  sub_carrier_id?: string;
  total_net_charge?: string;
  delivery_promise_date?: string;
  // Walmart
  serviceType?: string;
  displayName?: string;
  carrierName?: string;
  amount?: number | null;
  deliveryDate?: string | null;
  deliveryPromiseFulfilled?: boolean;
}

// The rate the algorithm picked, as returned by GET /api/shipping/merge/rates.
// It is chosen by the SAME Frozen/Dry rules that pick the carrier for a single
// order (@/lib/shipping/rate-selection), against the group's tightest deadline
// and its worst frozen-risk member — so the operator no longer reads a price
// list and decides by hand.
interface Recommended {
  // Veeqo purchase identifiers
  serviceType?: string | null;
  subCarrierId?: string | null;
  carrier?: string | null;
  // Walmart purchase identifiers
  carrierName?: string | null;
  carrierServiceType?: string | null;
  label: string;
  price: number | null;
  edd: string | null;
  // The physical day the rate was quoted for — differs from today only when
  // the Frozen rule shifted the shipment to Monday.
  shipDate: string;
  reason: string;
}

// What the buy endpoint needs. Built either from the recommendation or from a
// hand-picked line in the full list.
interface BuyPayload {
  serviceType: string | null;
  subCarrierId: string | null;
  carrier: string | null;
  carrierName: string | null;
  carrierServiceType: string | null;
  shipDate: string | null;
}

// Price and delivery estimate read from whichever channel's field is present.
function rateAmount(r: GroupRate): number {
  if (typeof r.amount === "number") return r.amount;
  const n = parseFloat(r.total_net_charge ?? "");
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function rateEdd(r: GroupRate): string {
  const raw = r.deliveryDate ?? r.delivery_promise_date;
  return shortDate(raw);
}

// "2026-08-07" → "8/7". Same compact form the order rows use.
function shortDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}` : "";
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : DAY_SHORT[d.getDay()];
}

// Today in Eastern — the operator's day, matching the server's todayNY().
function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
}

export function MergeGroupCard({
  group,
  orders,
  onUpdate,
  onDissolve,
}: {
  group: MergeGroupCardGroup;
  orders: OrderLite[];
  onUpdate: (patch: Record<string, unknown>) => Promise<void>;
  onDissolve: () => Promise<void>;
}) {
  const byId = new Map(orders.map((o) => [o.orderId, o]));
  const members = group.members.map((m) => ({
    ...m,
    order: byId.get(m.orderId) ?? null,
  }));
  const primary = members.find((m) => m.orderId === group.primaryOrderId);
  const destination = primary?.order
    ? [primary.order.customerName, primary.order.city, primary.order.shipToState]
        .filter(Boolean)
        .join(", ")
    : "";
  // A group can span two seller accounts (same buyer, same address, different
  // store) — worth saying out loud, because the label is bought under one of
  // them and only that one gets the carrier's protections.
  const stores = [...new Set(members.map((m) => m.order?.storeName).filter(Boolean))];

  const parseBox = (s: string | null) => {
    const m = s?.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i);
    return m ? { l: m[1], w: m[2], h: m[3] } : { l: "", w: "", h: "" };
  };
  const initial = parseBox(group.boxSize);
  const [length, setLength] = useState(initial.l);
  const [width, setWidth] = useState(initial.w);
  const [height, setHeight] = useState(initial.h);
  const [weight, setWeight] = useState(
    group.weight != null ? String(group.weight) : "",
  );
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("lbs");
  const [saving, setSaving] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [rates, setRates] = useState<GroupRate[] | null>(null);
  const [recommended, setRecommended] = useState<Recommended | null>(null);
  // Why the algorithm couldn't pick anything (no on-time rate, nothing inside
  // the frozen window). Shown instead of a recommendation — a merged group with
  // no safe option is exactly the case the operator must see, not guess at.
  const [noRecReason, setNoRecReason] = useState<string | null>(null);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  // The full price list is collapsed by default: the recommendation IS the
  // answer, the list is there for the rare override.
  const [showAllRates, setShowAllRates] = useState(false);
  const [buying, setBuying] = useState(false);
  const [buyResult, setBuyResult] = useState<string | null>(null);

  const isBought = group.status === "bought";
  // Frozen ships on Amazon only — a frozen parcel behind a Walmart order is the
  // wrong product, and Walmart has no frozen lane.
  const frozenAllowed = group.channelKind === "amazon";

  async function setType(t: "Frozen" | "Dry") {
    setErr(null);
    try {
      await onUpdate({ productType: t });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function savePackage() {
    setErr(null);
    const L = Number(length);
    const W = Number(width);
    const H = Number(height);
    const w = toLbs(weight, weightUnit);
    if (![L, W, H].every((n) => Number.isFinite(n) && n > 0)) {
      setErr("Length, width and height must all be positive numbers");
      return;
    }
    if (!Number.isFinite(w) || w <= 0) {
      setErr("Weight must be a positive number");
      return;
    }
    setSaving(true);
    try {
      await onUpdate({ boxSize: `${L}x${W}x${H}`, weight: w });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const loadRates = useCallback(async () => {
    setRatesLoading(true);
    setRatesError(null);
    try {
      const r = await fetch(
        `/api/shipping/merge/rates?groupId=${encodeURIComponent(group.id)}`,
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setRates(j.rates ?? []);
      setRecommended(j.recommended ?? null);
      setNoRecReason(j.noRecommendationReason ?? null);
    } catch (e) {
      setRatesError(e instanceof Error ? e.message : String(e));
      setRates(null);
      setRecommended(null);
      setNoRecReason(null);
    } finally {
      setRatesLoading(false);
    }
  }, [group.id]);

  // Quote as soon as the package is complete, and re-quote whenever it changes
  // — the whole point of entering a combined box is that the price follows it.
  useEffect(() => {
    if (isBought) return;
    if (group.weight == null || !group.boxSize || !group.productType) {
      setRates(null);
      return;
    }
    void loadRates();
  }, [
    isBought,
    group.weight,
    group.boxSize,
    group.productType,
    loadRates,
  ]);

  // A hand-picked line from the full list is always quoted for the day the
  // list itself was quoted for — which is the recommendation's day when the
  // Frozen rule shifted it, so an override still buys against the right pool.
  function payloadFromRate(rate: GroupRate): BuyPayload {
    return {
      // Veeqo identifiers
      serviceType: rate.name ?? null,
      subCarrierId: rate.sub_carrier_id ?? null,
      carrier: rate.title ?? null,
      // Walmart identifiers
      carrierName: rate.carrierName ?? null,
      carrierServiceType: rate.serviceType ?? null,
      shipDate: recommended?.shipDate ?? null,
    };
  }

  function payloadFromRecommended(r: Recommended): BuyPayload {
    return {
      serviceType: r.serviceType ?? null,
      subCarrierId: r.subCarrierId ?? null,
      carrier: r.carrier ?? null,
      carrierName: r.carrierName ?? null,
      carrierServiceType: r.carrierServiceType ?? null,
      shipDate: r.shipDate ?? null,
    };
  }

  async function buy(rate: BuyPayload) {
    setBuying(true);
    setBuyResult(null);
    setErr(null);
    try {
      const res = await fetch("/api/shipping/merge/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: group.id, rate }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setBuyResult(
        j.warning ??
          `Bought — tracking ${j.tracking} sent to all ${j.members?.length ?? 0} orders.`,
      );
      // Refresh the group so its bought state and per-member sync show through.
      await onUpdate({});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuying(false);
    }
  }

  const packageReady =
    group.boxSize != null && group.weight != null && group.productType != null;

  return (
    <div
      className={cn(
        "rounded-md border p-3",
        isBought
          ? "border-green bg-green-soft/40"
          : "border-info bg-info-tint/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Package size={16} className="shrink-0 text-info" />
        <span className="text-[length:var(--ship-row)] font-semibold text-ink">
          Merged — {members.length} orders in one box
        </span>
        <span className="text-[length:var(--ship-meta)] text-ink-2">
          {destination}
        </span>
        {stores.length > 1 && (
          <span className="rounded bg-warn-tint px-1.5 py-0.5 text-[length:var(--ship-badge)] font-medium text-warn-strong">
            {stores.length} seller accounts
          </span>
        )}
        {isBought && (
          <span className="inline-flex items-center gap-1 rounded bg-green px-1.5 py-0.5 text-[length:var(--ship-badge)] font-semibold text-white">
            <Check size={12} />
            Label bought
          </span>
        )}
        <div className="ml-auto">
          {!isBought && (
            <button
              type="button"
              disabled={dissolving}
              onClick={async () => {
                setDissolving(true);
                setErr(null);
                try {
                  await onDissolve();
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                  setDissolving(false);
                }
              }}
              className="inline-flex items-center gap-1 rounded border border-rule px-2 py-1 text-[length:var(--ship-button)] text-ink-2 hover:border-danger hover:text-danger disabled:opacity-50"
            >
              {dissolving ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Trash2 size={12} />
              )}
              Un-merge
            </button>
          )}
        </div>
      </div>

      {/* Members. The primary is called out because that is the order the
          real label is bought against — the others receive its tracking. */}
      <div className="mt-2 space-y-1">
        {members.map((m) => (
          <div
            key={m.id}
            className="flex flex-wrap items-center gap-2 rounded bg-surface px-2 py-1.5 text-[length:var(--ship-meta)]"
          >
            <span className="font-mono text-ink">{m.orderNumber}</span>
            {m.orderId === group.primaryOrderId ? (
              <span className="rounded bg-info px-1.5 py-0.5 text-[length:var(--ship-badge)] font-semibold text-white">
                label bought here
              </span>
            ) : (
              <span className="rounded border border-rule px-1.5 py-0.5 text-[length:var(--ship-badge)] text-ink-3">
                gets the same tracking
              </span>
            )}
            {m.order && (
              <span className="text-ink-3">{m.order.storeName}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-ink-2">
              {m.order?.items
                .map((i) => `${i.quantity}× ${i.productTitle}`)
                .join(" + ")}
            </span>
            {m.shipmentSyncedAt && (
              <span className="text-green-ink">tracking sent ✓</span>
            )}
            {m.shipmentSyncError && (
              <span className="text-danger" title={m.shipmentSyncError}>
                tracking failed
              </span>
            )}
          </div>
        ))}
      </div>

      {isBought ? (
        <div className="mt-2 border-t border-rule pt-2 text-[length:var(--ship-meta)]">
          <span className="text-ink-2">
            {group.carrier} {group.service}
            {group.price != null && ` · $${group.price.toFixed(2)}`}
          </span>
          <span className="ml-3 text-ink-3">
            Tracking:{" "}
            <span className="font-mono text-ink-2">{group.trackingNumber}</span>
          </span>
          {group.labelPdfUrl && (
            <a
              href={group.labelPdfUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-3 text-info underline"
            >
              Open PDF
            </a>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2 border-t border-rule pt-3">
          {/* Type first — it decides which rate logic runs, frozen or dry. */}
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
              Type
            </span>
            {(["Frozen", "Dry"] as const).map((t) => {
              const disabled = t === "Frozen" && !frozenAllowed;
              return (
                <button
                  key={t}
                  type="button"
                  disabled={disabled}
                  onClick={() => setType(t)}
                  title={
                    disabled
                      ? "Frozen ships on Amazon only"
                      : undefined
                  }
                  className={cn(
                    "rounded border px-2 py-1 text-[length:var(--ship-button)] font-medium",
                    group.productType === t
                      ? "border-info bg-info text-white"
                      : "border-rule text-ink-2 hover:border-info hover:text-info",
                    disabled && "cursor-not-allowed opacity-40 hover:border-rule hover:text-ink-2",
                  )}
                >
                  {t}
                </button>
              );
            })}
            {!group.productType && (
              <span className="text-[length:var(--ship-meta)] text-warn-strong">
                pick one — the rate depends on it
              </span>
            )}
          </div>

          <BoxPresetPicker
            value={group.boxSize ?? ""}
            onSelect={(_label, dims) => {
              setLength(String(dims.length));
              setWidth(String(dims.width));
              setHeight(String(dims.height));
            }}
          />

          <div className="flex flex-wrap items-end gap-2">
            {(
              [
                ["L", length, setLength],
                ["W", width, setWidth],
                ["H", height, setHeight],
              ] as const
            ).map(([label, value, setter]) => (
              <label key={label} className="flex flex-col gap-0.5">
                <span className="text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
                  {label}
                </span>
                <input
                  type="number"
                  step="0.1"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  className="w-20 rounded border border-rule bg-surface px-2 py-1 text-[length:var(--ship-row)] focus:border-info focus:outline-none"
                />
              </label>
            ))}
            <div className="w-40">
              <span className="mb-0.5 block text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
                Weight
              </span>
              <WeightInput
                value={weight}
                unit={weightUnit}
                onChange={setWeight}
                onUnitChange={setWeightUnit}
              />
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={savePackage}
              className="rounded border border-info bg-info px-3 py-1.5 text-[length:var(--ship-button)] font-medium text-white disabled:opacity-50"
            >
              {saving ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                "Save package"
              )}
            </button>
            {packageReady && (
              <span className="text-[length:var(--ship-meta)] text-green-ink">
                {group.productType} · {group.boxSize} · {group.weight} lb
              </span>
            )}
          </div>

          {/* The chosen rate for the combined box. The algorithm picks it —
              same Frozen/Dry rules as any single order, against the group's
              tightest deadline — so the operator's job is one click. Buying it
              buys ONE label; every other member then receives its tracking. */}
          {packageReady && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[length:var(--ship-cell-label)] font-mono uppercase tracking-wider text-ink-3">
                  Rate for the combined box
                </span>
                {ratesLoading && (
                  <Loader2 size={12} className="animate-spin text-ink-3" />
                )}
                <button
                  type="button"
                  onClick={() => void loadRates()}
                  disabled={ratesLoading}
                  className="text-[length:var(--ship-button)] text-info underline disabled:opacity-50"
                >
                  Refresh
                </button>
                <span className="text-[length:var(--ship-meta)] text-ink-3">
                  {group.channelKind === "walmart"
                    ? "via Ship with Walmart"
                    : "via Veeqo"}
                </span>
              </div>

              {ratesError && (
                <div className="rounded border border-danger bg-danger-tint px-2 py-1 text-[length:var(--ship-meta)] text-danger">
                  {ratesError}
                </div>
              )}

              {rates && rates.length === 0 && !ratesLoading && (
                <div className="text-[length:var(--ship-meta)] text-warn-strong">
                  No rates came back for this package.
                </div>
              )}

              {/* The recommendation, laid out like a ready-to-buy order row:
                  carrier · EDD · price · one button. */}
              {recommended && (
                <div className="flex flex-wrap items-center gap-2 rounded border border-info bg-surface px-2 py-2">
                  <span className="rounded bg-info px-1.5 py-0.5 text-[length:var(--ship-badge)] font-semibold text-white">
                    Picked by the rules
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--ship-row)] font-medium text-ink">
                    {recommended.label}
                  </span>
                  {recommended.edd && (
                    <span className="shrink-0 text-[length:var(--ship-meta)] text-ink-3">
                      delivers {shortDate(recommended.edd)}
                    </span>
                  )}
                  <span className="shrink-0 text-[length:var(--ship-cell-value)] font-semibold tabular text-ink">
                    {recommended.price != null
                      ? `$${recommended.price.toFixed(2)}`
                      : "—"}
                  </span>
                  <button
                    type="button"
                    disabled={buying}
                    onClick={() => void buy(payloadFromRecommended(recommended))}
                    className="inline-flex shrink-0 items-center gap-1 rounded bg-info px-3 py-1.5 text-[length:var(--ship-button)] font-semibold text-white disabled:opacity-50"
                  >
                    {buying ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <ShoppingCart size={12} />
                    )}
                    Buy one label
                  </button>
                  <div className="w-full text-[length:var(--ship-meta)] text-ink-3">
                    {recommended.reason}
                  </div>
                  {/* The Frozen Monday-shift moved the physical ship day. Say
                      it out loud: the label still prints today's date (Amazon's
                      Late Shipment Rate), but the box must NOT leave before the
                      day quoted, or the food travels longer than planned. */}
                  {recommended.shipDate !== todayET() && (
                    <div className="w-full rounded bg-warn-tint px-2 py-1 text-[length:var(--ship-meta)] font-medium text-warn-strong">
                      Ship {dayLabel(recommended.shipDate)}{" "}
                      {shortDate(recommended.shipDate)} — the label prints with
                      today&apos;s date, the box leaves that day.
                    </div>
                  )}
                </div>
              )}

              {/* No safe option. Never silently fall back to "cheapest" — for a
                  frozen box that is a food-safety decision, not a UI default. */}
              {!recommended && noRecReason && !ratesLoading && (
                <div className="rounded border border-warn bg-warn-tint px-2 py-1.5 text-[length:var(--ship-meta)] text-warn-strong">
                  No rate could be picked: {noRecReason}
                </div>
              )}

              {rates && rates.length > 0 && (
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setShowAllRates((v) => !v)}
                    className="text-[length:var(--ship-button)] text-info underline"
                  >
                    {showAllRates
                      ? "Hide the other rates"
                      : `Other rates (${rates.length})`}
                  </button>
                  {showAllRates && (
                    <div className="max-h-[220px] space-y-1 overflow-y-auto">
                      {[...rates]
                        .sort((a, b) => rateAmount(a) - rateAmount(b))
                        .map((r, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-2 rounded border border-rule bg-surface px-2 py-1.5"
                          >
                            <span className="min-w-0 flex-1 truncate text-[length:var(--ship-meta)] text-ink">
                              {r.displayName ?? r.title ?? r.serviceType ?? r.name}
                            </span>
                            <span className="shrink-0 text-[length:var(--ship-meta)] text-ink-3">
                              {rateEdd(r)}
                            </span>
                            <span className="shrink-0 text-[length:var(--ship-cell-value)] font-semibold tabular text-ink">
                              {Number.isFinite(rateAmount(r))
                                ? `$${rateAmount(r).toFixed(2)}`
                                : "—"}
                            </span>
                            <button
                              type="button"
                              disabled={buying}
                              onClick={() => void buy(payloadFromRate(r))}
                              className="inline-flex shrink-0 items-center gap-1 rounded border border-rule px-2 py-1 text-[length:var(--ship-button)] font-medium text-ink-2 hover:border-info hover:text-info disabled:opacity-50"
                            >
                              {buying ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <ShoppingCart size={12} />
                              )}
                              Buy this one
                            </button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {buyResult && (
        <div className="mt-2 rounded border border-info bg-info-tint px-2 py-1 text-[length:var(--ship-meta)] text-ink-2">
          {buyResult}
        </div>
      )}

      {err && (
        <div className="mt-2 rounded border border-danger bg-danger-tint px-2 py-1 text-[length:var(--ship-meta)] text-danger">
          {err}
        </div>
      )}
    </div>
  );
}
