"use client";

import { useMemo, useState } from "react";
import {
  Copy,
  Check,
  ImageOff,
  Zap,
  Loader2,
  Undo2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Btn } from "@/components/kit";
import { parsePackSize } from "@/lib/procurement/pack-size";
import { PhotoLightbox } from "./PhotoLightbox";

export interface ProcurementCardData {
  lineItemId: string;
  productTitle: string;
  productImageUrl: string | null;
  sku: string;
  quantityOrdered: number;
  remaining: number;
  status: { kind: string; remaining?: number } | null;
  shippingMethod: string | null;
  isPremium: boolean;
}

export type CardAction =
  | { kind: "bought" }
  | { kind: "partial"; remaining: number }
  | { kind: "undo" };

export interface ActionResult {
  ok: boolean;
  error?: string;
}

interface ProcurementCardProps {
  card: ProcurementCardData;
  /**
   * Dispatch a procurement action. The page-level handler is expected to
   * apply the optimistic update to local state, call the API, and
   * resolve with `ok: false` (and a human-readable `error`) when the
   * server rejects so the card can revert.
   */
  onAction: (lineItemId: string, action: CardAction) => Promise<ActionResult>;
}

/**
 * Single line-item card. Photo (tap → lightbox), title with one-tap copy,
 * pack-aware physical-quantity display, and Phase 3 action buttons:
 *   - "Купил всё" → mark as bought; card stays visible until refresh
 *   - "Купил частично" → ask for remaining count, save
 *   - "Откат" → undo the last action on this line
 */
export function ProcurementCard({ card, onAction }: ProcurementCardProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<null | CardAction["kind"]>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [partialMode, setPartialMode] = useState(false);

  const status = card.status;
  const isBought = status?.kind === "bought";
  const isPartial = status?.kind === "remain";
  const listingsToBuy = isPartial ? card.remaining : card.quantityOrdered;

  // Default the partial input to the current remaining (or full quantity if
  // we're entering partial mode for the first time, minus 1 — most common
  // case is "I bought one, one left").
  const [partialValue, setPartialValue] = useState<number>(
    isPartial ? card.remaining : Math.max(1, card.quantityOrdered - 1)
  );

  const pack = useMemo(
    () => parsePackSize(card.productTitle),
    [card.productTitle]
  );
  const physicalTotal = pack ? listingsToBuy * pack.size : null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(card.productTitle);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — silent */
    }
  };

  async function dispatch(action: CardAction) {
    setPending(action.kind);
    setActionError(null);
    const r = await onAction(card.lineItemId, action);
    setPending(null);
    if (!r.ok) {
      setActionError(r.error ?? "Не удалось применить действие");
    } else {
      setPartialMode(false);
    }
  }

  return (
    <>
      <div
        className={cn(
          "flex gap-3 border-t border-rule/60 px-3 py-3 first:border-t-0 sm:px-4",
          isBought && "bg-green-soft/40",
          isPartial && "bg-warn-tint/30"
        )}
      >
        {/* Photo (tap → fullscreen) */}
        <button
          type="button"
          onClick={() => card.productImageUrl && setLightboxOpen(true)}
          disabled={!card.productImageUrl}
          className={cn(
            "relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-rule bg-bg-elev",
            card.productImageUrl && "cursor-zoom-in"
          )}
          aria-label={
            card.productImageUrl ? "Open photo fullscreen" : "No photo"
          }
        >
          {card.productImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.productImageUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <ImageOff size={20} className="text-ink-4" />
          )}
          {isBought && (
            <div className="absolute inset-0 flex items-center justify-center bg-green/85">
              <Check size={28} className="text-green-cream" strokeWidth={3} />
            </div>
          )}
        </button>

        {/* Right: title + meta + qty + actions */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p
              className={cn(
                "min-w-0 flex-1 text-[14px] font-medium leading-snug text-ink",
                isBought && "line-through opacity-60"
              )}
            >
              {card.productTitle}
            </p>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-elev hover:text-ink"
              aria-label="Copy product name"
              title="Copy name"
            >
              {copied ? (
                <Check size={14} className="text-green" />
              ) : (
                <Copy size={14} />
              )}
            </button>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] tabular text-ink-3">
            <span>SKU: {card.sku || "—"}</span>
            {card.shippingMethod && (
              <>
                <span className="text-ink-4">·</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    card.isPremium && "text-warn-strong"
                  )}
                >
                  {card.isPremium && <Zap size={11} />}
                  {card.shippingMethod}
                </span>
              </>
            )}
          </div>

          {/* Quantity display */}
          {!isBought && (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <div
                className={cn(
                  "inline-flex items-baseline gap-1 rounded-md px-2 py-0.5 text-[14px] font-semibold tabular",
                  isPartial
                    ? "bg-warn-tint text-warn-strong"
                    : "bg-green-soft text-green-ink"
                )}
              >
                <span>
                  {isPartial ? "Осталось купить:" : "Купить:"}{" "}
                  {physicalTotal ?? listingsToBuy} шт
                </span>
              </div>
              {physicalTotal !== null && pack !== null && (
                <span className="text-[11.5px] tabular text-ink-3">
                  {listingsToBuy} ×{" "}
                  <span className="font-medium text-ink-2">{pack.label}</span>
                  {isPartial && (
                    <>
                      {" "}
                      из {card.quantityOrdered} ×{" "}
                      <span className="font-medium text-ink-2">
                        {pack.label}
                      </span>
                    </>
                  )}
                </span>
              )}
              {physicalTotal === null && isPartial && (
                <span className="text-[11.5px] tabular text-ink-3">
                  из {card.quantityOrdered} шт
                </span>
              )}
            </div>
          )}

          {/* Action error banner */}
          {actionError && (
            <div className="mt-2 inline-flex items-start gap-1.5 rounded-md bg-danger-tint px-2 py-1 text-[11.5px] text-danger">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}

          {/* Action area */}
          <div className="mt-3">
            {partialMode ? (
              <PartialInput
                initial={partialValue}
                max={card.quantityOrdered}
                pack={pack}
                pending={pending === "partial"}
                onCancel={() => {
                  setPartialMode(false);
                  setActionError(null);
                }}
                onSave={(n) => {
                  setPartialValue(n);
                  void dispatch({ kind: "partial", remaining: n });
                }}
              />
            ) : isBought ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-md bg-green px-2 py-1 text-[12.5px] font-semibold text-green-cream">
                  <Check size={13} /> Куплено
                </span>
                <Btn
                  variant="ghost"
                  size="sm"
                  loading={pending === "undo"}
                  icon={<Undo2 size={13} />}
                  onClick={() => dispatch({ kind: "undo" })}
                >
                  Откатить
                </Btn>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Btn
                  variant="primary"
                  size="sm"
                  loading={pending === "bought"}
                  disabled={pending !== null}
                  onClick={() => dispatch({ kind: "bought" })}
                >
                  Купил всё
                </Btn>
                <Btn
                  variant="default"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => {
                    setPartialMode(true);
                    setActionError(null);
                  }}
                >
                  {isPartial ? "Изменить остаток" : "Купил частично"}
                </Btn>
                {isPartial && (
                  <Btn
                    variant="ghost"
                    size="sm"
                    loading={pending === "undo"}
                    disabled={pending !== null}
                    icon={<Undo2 size={13} />}
                    onClick={() => dispatch({ kind: "undo" })}
                  >
                    Откатить
                  </Btn>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {lightboxOpen && card.productImageUrl && (
        <PhotoLightbox
          src={card.productImageUrl}
          alt={card.productTitle}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}

interface PartialInputProps {
  initial: number;
  max: number;
  pack: { size: number; label: string } | null;
  pending: boolean;
  onSave: (remaining: number) => void;
  onCancel: () => void;
}

/**
 * Inline number stepper for "сколько ещё осталось купить". Range 1..max,
 * since 0 = bought (use the bought button) and >max would mean you bought
 * negative (use undo).
 */
function PartialInput({
  initial,
  max,
  pack,
  pending,
  onSave,
  onCancel,
}: PartialInputProps) {
  const [n, setN] = useState<number>(
    Math.max(1, Math.min(initial, max))
  );

  const dec = () => setN((v) => Math.max(1, v - 1));
  const inc = () => setN((v) => Math.min(max, v + 1));

  return (
    <div className="rounded-md border border-rule bg-surface-tint px-2.5 py-2">
      <div className="text-[12px] font-medium text-ink-2">
        Сколько ещё нужно купить?
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center overflow-hidden rounded-md border border-rule bg-surface">
          <button
            type="button"
            onClick={dec}
            disabled={n <= 1 || pending}
            className="h-9 w-9 text-[15px] font-semibold text-ink-2 hover:bg-bg-elev disabled:opacity-40"
            aria-label="−1"
          >
            −
          </button>
          <input
            type="number"
            min={1}
            max={max}
            value={n}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v)) setN(Math.max(1, Math.min(max, v)));
            }}
            disabled={pending}
            className="h-9 w-12 border-x border-rule bg-surface text-center text-[14px] font-semibold tabular text-ink outline-none"
          />
          <button
            type="button"
            onClick={inc}
            disabled={n >= max || pending}
            className="h-9 w-9 text-[15px] font-semibold text-ink-2 hover:bg-bg-elev disabled:opacity-40"
            aria-label="+1"
          >
            +
          </button>
        </div>
        <span className="text-[11.5px] tabular text-ink-3">
          из {max} {pack ? `× ${pack.label} = ${n * pack.size} шт` : "шт"}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Btn
          variant="primary"
          size="sm"
          loading={pending}
          onClick={() => onSave(n)}
        >
          Сохранить
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={onCancel}
        >
          Отмена
        </Btn>
        {pending && (
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-3">
            <Loader2 size={12} className="animate-spin" /> Записываем в Veeqo…
          </span>
        )}
      </div>
    </div>
  );
}
