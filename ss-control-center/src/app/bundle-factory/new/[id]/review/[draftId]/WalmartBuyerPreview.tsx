"use client";

import { useState } from "react";
import { Check, ChevronDown, Heart, MapPin, Package, Search, Truck } from
  "lucide-react";

export interface WalmartBuyerPreviewData {
  title: string;
  brand: string;
  packCount: number;
  images: string[];
  bullets: string[];
  description: string;
  itemPriceCents: number;
  buyerShippingMinimumCents: number;
  buyerShippingMaximumCents: number;
  customerTotalMinimumCents: number;
  customerTotalMaximumCents: number;
  shippingTemplateName: string;
  targetMarginBps: number;
  ingredients: string | null;
  allergens: unknown;
  nutritionFacts: unknown;
  category: string | null;
  sourceTitle: string;
  sourceObservationId: string;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function moneyRange(minimum: number, maximum: number): string {
  return minimum === maximum
    ? money(minimum)
    : `${money(minimum)}–${money(maximum)}`;
}

function factualText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => factualText(entry))
      .filter((entry): entry is string => Boolean(entry));
    return values.length ? values.join(", ") : null;
  }
  if (value && typeof value === "object") {
    const values = Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => {
        const rendered = factualText(child);
        return rendered ? [`${key.replaceAll("_", " ")}: ${rendered}`] : [];
      });
    return values.length ? values.join(" · ") : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

export function WalmartBuyerPreview({
  data,
}: {
  data: WalmartBuyerPreviewData;
}) {
  const [selectedImage, setSelectedImage] = useState(0);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const hero = data.images[selectedImage] ?? data.images[0] ?? null;
  const shippingFree = data.buyerShippingMaximumCents === 0;
  const allergens = factualText(data.allergens);
  const nutrition = factualText(data.nutritionFacts);

  return (
    <div className="overflow-hidden rounded-[16px] border border-[#d5d9e0] bg-white shadow-sm">
      <header className="bg-[#0071dc] text-white">
        <div className="mx-auto flex max-w-[1320px] items-center gap-5 px-5 py-4">
          <div className="shrink-0 text-[26px] font-bold tracking-tight">
            Walmart<span className="ml-1 text-[#ffc220]">✦</span>
          </div>
          <div className="hidden items-center gap-2 text-[12px] font-semibold md:flex">
            <MapPin size={18} />
            <span>Shipping to 33765</span>
          </div>
          <div className="flex h-11 min-w-0 flex-1 items-center rounded-full bg-white px-4 text-[#4a4a4a]">
            <span className="min-w-0 flex-1 truncate text-[14px]">
              Search everything at Walmart online and in store
            </span>
            <Search size={19} className="shrink-0 text-[#001e60]" />
          </div>
        </div>
        <div className="border-t border-white/25 px-5 py-2 text-center text-[12px] font-semibold">
          Departments &nbsp;&nbsp; Services &nbsp;&nbsp; Grocery & Essentials
        </div>
      </header>

      <div className="border-b border-[#eadb9b] bg-[#fff6cf] px-5 py-3 text-[12px] text-[#3f3215]">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-2">
          <span>
            <strong>INTERNAL OWNER REVIEW</strong> &nbsp; Buyer-page preview ·
            not live · no listing UPC reserved · nothing published
          </span>
          <span className="font-mono text-[10.5px]">
            Exact donor evidence {data.sourceObservationId.slice(0, 12)}…
          </span>
        </div>
      </div>

      <main className="mx-auto max-w-[1280px] px-5 py-7">
        <div className="mb-6 text-[12px] text-[#4a5568]">
          Food &nbsp;/&nbsp; Pantry &nbsp;/&nbsp; {data.category ?? "Shelf-stable food"}
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
          <section className="min-w-0">
            <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-4">
              <div className="space-y-2">
                {data.images.map((image, index) => (
                  <button
                    key={`${image}-${index}`}
                    type="button"
                    onClick={() => setSelectedImage(index)}
                    className={`relative flex aspect-square w-16 items-center justify-center overflow-hidden rounded-[7px] bg-white p-1 ${
                      index === selectedImage
                        ? "border-2 border-[#0071dc]"
                        : "border border-[#cbd5e1]"
                    }`}
                    aria-label={`Show product image ${index + 1}`}
                  >
                    {/* Exact Product Truth image; no generative redraw. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image} alt="" className="h-full w-full object-contain" />
                    {index === 0 && (
                      <span className="absolute bottom-0 right-0 rounded-tl bg-[#0071dc] px-1 text-[8px] font-bold text-white">
                        {data.packCount}×
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="relative flex aspect-square min-h-[420px] items-center justify-center overflow-hidden bg-white">
                {hero && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={hero}
                    alt={data.title}
                    className="h-full w-full object-contain"
                  />
                )}
                {selectedImage === 0 && (
                  <span className="absolute bottom-4 left-4 rounded bg-black px-2.5 py-1 text-[11px] font-bold tracking-wide text-white">
                    PACK OF {data.packCount}
                  </span>
                )}
              </div>
            </div>
            <p className="mt-3 text-center text-[10.5px] leading-relaxed text-[#6b7280]">
              Main image repeats the exact donor package {data.packCount} times
              after connected-white-background removal. Product artwork is not redrawn.
            </p>
          </section>

          <section className="min-w-0">
            <a className="text-[13px] font-semibold text-[#0053a0] underline" href="#product-information">
              Visit the {data.brand} Store
            </a>
            <h1 className="mt-2 text-[23px] font-semibold leading-[1.22] text-[#1f2937]">
              {data.title}
            </h1>
            <div className="mt-3 text-[12px] text-[#6b7280]">(No ratings yet)</div>

            <div className="mt-5 border-y border-[#d5d9e0] py-5">
              <div className="text-[11.5px] text-[#4b5563]">Current item price in USD</div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="text-[32px] font-bold tracking-tight text-[#1f2937]">
                  {money(data.itemPriceCents)}
                </span>
                <span className="text-[11.5px] text-[#4b5563]">
                  {money(Math.round(data.itemPriceCents / data.packCount))} each
                </span>
              </div>
              {!shippingFree && (
                <p className="mt-1 text-[12px] text-[#4b5563]">
                  + {moneyRange(
                    data.buyerShippingMinimumCents,
                    data.buyerShippingMaximumCents,
                  )} buyer shipping
                </p>
              )}
            </div>

            <div className="mt-5 rounded-[10px] border border-[#cbd5e1] p-4">
              <h2 className="text-[14px] font-semibold text-[#1f2937]">
                How you&apos;ll get this item
              </h2>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-[8px] border-2 border-[#0071dc] bg-[#eef7ff] px-2 py-3 text-center">
                  <Truck size={20} className="mx-auto text-[#0071dc]" />
                  <div className="mt-2 text-[11.5px] font-semibold">Shipping</div>
                  <div className="text-[10px] text-[#4b5563]">Available</div>
                </div>
                <div className="rounded-[8px] border border-[#cbd5e1] px-2 py-3 text-center text-[#6b7280]">
                  <Package size={20} className="mx-auto" />
                  <div className="mt-2 text-[11.5px] font-semibold">Pickup</div>
                  <div className="text-[10px]">Not available</div>
                </div>
                <div className="rounded-[8px] border border-[#cbd5e1] px-2 py-3 text-center text-[#6b7280]">
                  <MapPin size={20} className="mx-auto" />
                  <div className="mt-2 text-[11.5px] font-semibold">Delivery</div>
                  <div className="text-[10px]">Not available</div>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-[#e5e7eb] pt-3 text-[12px]">
                <span>Shipping to 33765</span>
                <strong className={shippingFree ? "text-[#17823b]" : "text-[#1f2937]"}>
                  {shippingFree
                    ? "Free shipping"
                    : moneyRange(
                        data.buyerShippingMinimumCents,
                        data.buyerShippingMaximumCents,
                      )}
                </strong>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <div className="rounded-full border border-[#9ca3af] px-3 py-2 text-[12px]">
                  Qty&nbsp; 1 <ChevronDown size={13} className="inline" />
                </div>
                <button
                  type="button"
                  disabled
                  className="min-w-0 flex-1 rounded-full bg-[#8e98a5] px-4 py-3 text-[12px] font-bold text-white"
                >
                  Preview only — Add to cart disabled
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-[10px] bg-[#f5f7fa] p-4 text-[12px]">
              <div className="flex items-center justify-between gap-3">
                <span>Customer total</span>
                <strong className="text-[18px]">
                  {moneyRange(
                    data.customerTotalMinimumCents,
                    data.customerTotalMaximumCents,
                  )}
                </strong>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-[#6b7280]">
                <span>Shipping template</span>
                <span>{data.shippingTemplateName}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-[#6b7280]">
                <span>Target contribution margin</span>
                <span>{(data.targetMarginBps / 100).toFixed(0)}%</span>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2 border-t border-[#d5d9e0] pt-4 text-[12px] text-[#0053a0]">
              <Heart size={17} /> Add to list
            </div>
          </section>
        </div>

        <section className="mt-10 grid gap-8 border-t border-[#d5d9e0] pt-8 lg:grid-cols-2">
          <div>
            <h2 className="text-[20px] font-bold text-[#1f2937]">About this item</h2>
            <ul className="mt-4 space-y-2.5 text-[14px] leading-relaxed text-[#374151]">
              {data.bullets.map((bullet) => (
                <li key={bullet} className="flex gap-2">
                  <Check size={17} className="mt-0.5 shrink-0 text-[#17823b]" />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-[20px] font-bold text-[#1f2937]">Product details</h2>
            <p className="mt-4 whitespace-pre-wrap text-[14px] leading-relaxed text-[#374151]">
              {data.description}
            </p>
          </div>
        </section>

        <section id="product-information" className="mt-8 border-t border-[#d5d9e0] pt-8">
          <h2 className="text-[20px] font-bold text-[#1f2937]">Product information</h2>
          <div className="mt-4 grid overflow-hidden rounded-[10px] border border-[#d5d9e0] text-[12.5px] md:grid-cols-2">
            <Fact label="Brand" value={data.brand} />
            <Fact label="Pack quantity" value={`${data.packCount} exact retail units`} />
            {data.category && <Fact label="Category" value={data.category} />}
            {data.ingredients && <Fact label="Ingredients" value={data.ingredients} />}
            {allergens && <Fact label="Allergen information" value={allergens} />}
            {nutrition && <Fact label="Nutrition facts" value={nutrition} />}
          </div>
        </section>

        <section className="mt-8 rounded-[10px] border border-[#cbd5e1] bg-[#f8fafc]">
          <button
            type="button"
            onClick={() => setEvidenceOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[12.5px] font-semibold text-[#1f2937]"
          >
            <span>Show exact engine evidence</span>
            <ChevronDown
              size={16}
              className={evidenceOpen ? "rotate-180 transition-transform" : "transition-transform"}
            />
          </button>
          {evidenceOpen && (
            <div className="border-t border-[#d5d9e0] px-4 py-3 text-[11.5px] leading-relaxed text-[#4b5563]">
              <div><strong>Exact source title:</strong> {data.sourceTitle}</div>
              <div className="mt-1 break-all font-mono">
                <strong>Content observation:</strong> {data.sourceObservationId}
              </div>
              <div className="mt-2">
                This preview is internal. It carries no Walmart mutation authority,
                reserves no listing UPC, and cannot publish itself.
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[145px_1fr] border-b border-[#e5e7eb] last:border-b-0 md:border-r md:odd:border-r-0">
      <div className="bg-[#f3f4f6] px-3 py-2.5 font-semibold text-[#4b5563]">{label}</div>
      <div className="whitespace-pre-wrap px-3 py-2.5 text-[#1f2937]">{value}</div>
    </div>
  );
}
