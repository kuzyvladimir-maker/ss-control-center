"use client";

/**
 * Studio Step 2 client picker — search the Reference Catalog, multi-select
 * donor products, then seed the draft and hand off to the pipeline.
 *
 * Search re-queries server-side via the `?q=` URL param (the page is a server
 * component); selection + submit are local. UI strings are English.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Search, Check, ArrowRight, ImageOff } from "lucide-react";

export interface StudioDonorProduct {
  id: string;
  name: string;
  brand: string | null;
  size: string | null;
  category: string | null;
  imageUrl: string | null;
  bestPrice: number | null;
  bestRetailer: string | null;
}

export function StudioDonorPicker({
  draftId,
  initialQuery,
  packCount,
  products,
}: {
  draftId: string;
  initialQuery: string;
  packCount: number;
  products: StudioDonorProduct[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(`/bundle-factory/new/${draftId}${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  }

  async function build() {
    if (selected.size === 0 || building) return;
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch(`/api/bundle-factory/studio/${draftId}/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ donor_product_ids: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Failed to build the draft from these products");
      }
      router.push(`/bundle-factory/drafts/${draftId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBuilding(false);
    }
  }

  return (
    <div className="space-y-4 pb-20">
      <form onSubmit={runSearch} className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search size={15} strokeWidth={1.8} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the catalog by brand or product…"
            className="w-full rounded-[10px] border border-rule bg-surface py-2 pl-9 pr-3 text-[13.5px] text-ink outline-none placeholder:text-ink-4 focus:border-silver-line"
          />
        </div>
        <Btn variant="default" size="md" type="submit">Search</Btn>
      </form>

      <p className="text-[12px] text-ink-3">
        Pick around <span className="font-medium text-ink-2">{packCount}</span> products for this set.
      </p>

      {products.length === 0 ? (
        <div className="rounded-[14px] border border-rule bg-surface px-4 py-10 text-center text-[13px] text-ink-3">
          No products found{initialQuery ? ` for “${initialQuery}”` : ""}. Try another search — or pull
          missing products in from the Reference Catalog.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {products.map((p) => {
            const isSel = selected.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                className={cn(
                  "group relative overflow-hidden rounded-[14px] border bg-surface text-left transition-colors",
                  isSel ? "border-green ring-1 ring-green" : "border-rule hover:border-silver-line"
                )}
              >
                <span
                  className={cn(
                    "absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border transition-colors",
                    isSel ? "border-green bg-green text-green-cream" : "border-rule bg-surface/90 text-transparent"
                  )}
                >
                  <Check size={14} strokeWidth={2.4} />
                </span>
                <div className="flex h-32 items-center justify-center bg-surface-tint">
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.imageUrl} alt={p.name} className="h-full w-full object-contain p-2" />
                  ) : (
                    <ImageOff size={22} strokeWidth={1.5} className="text-ink-4" />
                  )}
                </div>
                <div className="border-t border-rule p-2.5">
                  <div className="line-clamp-2 text-[12px] font-medium leading-snug text-ink">{p.name}</div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-ink-3">
                    <span className="truncate">{p.brand ?? "—"}{p.size ? ` · ${p.size}` : ""}</span>
                    {typeof p.bestPrice === "number" && (
                      <span className="shrink-0 font-mono tabular-nums text-ink-2">${p.bestPrice.toFixed(2)}</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="rounded-[10px] border border-danger/20 bg-danger-tint px-3 py-2 text-[12.5px] text-danger">
          {error}
        </div>
      )}

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-surface/95 px-6 py-3 backdrop-blur md:left-[236px]">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between">
          <span className="text-[13px] text-ink-2">
            <span className="font-mono font-semibold tabular-nums text-ink">{selected.size}</span> selected
          </span>
          <Btn variant="primary" size="md" onClick={build} disabled={selected.size === 0} loading={building}>
            Build the draft
            <ArrowRight size={16} strokeWidth={2} />
          </Btn>
        </div>
      </div>
    </div>
  );
}
