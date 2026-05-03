"use client";

import { useMemo, useState } from "react";
import { Copy, Check, ImageOff, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
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

interface ProcurementCardProps {
  card: ProcurementCardData;
}

/**
 * Single line-item card. Shows photo (tap → lightbox), title, qty,
 * one-tap copy of the product name. Phase 2 = display-only; Phase 3
 * adds the bought/partial/undo action buttons inside this same card.
 */
export function ProcurementCard({ card }: ProcurementCardProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const isPartial = card.status?.kind === "remain";
  const listingsToBuy = isPartial ? card.remaining : card.quantityOrdered;

  // If the title encodes a pack size ("Pack of 7"), surface the *physical*
  // total (listings × pack size) so Vladimir grabs the right number off
  // the shelf. Falls back to plain "N шт" when no pattern matches.
  const pack = useMemo(() => parsePackSize(card.productTitle), [card.productTitle]);
  const physicalTotal = pack ? listingsToBuy * pack.size : null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(card.productTitle);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Some browsers block clipboard on http or in iframes — silently ignore.
    }
  };

  return (
    <>
      <div className="flex gap-3 border-t border-rule/60 px-3 py-3 first:border-t-0 sm:px-4">
        {/* Photo (tap → fullscreen). Tap target is the whole 80×80 box. */}
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
        </button>

        {/* Right: title + meta + qty */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-ink">
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
                    <span className="font-medium text-ink-2">{pack.label}</span>
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
