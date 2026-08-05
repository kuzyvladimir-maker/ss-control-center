"use client";

/**
 * Narrow the drafts list to the batch you are about to publish.
 *
 * Without this the page loaded the newest hundred rows and nothing else, so a
 * build of 200 could never be seen — let alone selected — in one go. The filter
 * that matters most is "ready to publish": it reduces the list to exactly the
 * rows a batch is made of, which is what makes one tick of "select all" mean
 * "the whole batch".
 *
 * Filters live in the URL so a filtered view can be shared, reloaded, or handed
 * to a colleague as a link.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Btn } from "@/components/kit";
import { Search, X } from "lucide-react";

export function DraftFilters({
  search,
  buildId,
  readyOnly,
  pageSize,
  pageSizes,
  page,
  totalPages,
}: {
  search: string;
  buildId: string;
  readyOnly: boolean;
  pageSize: number;
  pageSizes: number[];
  page: number;
  totalPages: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [draftSearch, setDraftSearch] = useState(search);

  /** Any filter change resets to page 1 — page 7 of the old filter is noise. */
  function apply(changes: Record<string, string | null>, keepPage = false) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (!keepPage) next.delete("page");
    router.push(`/bundle-factory/drafts?${next.toString()}`);
  }

  const filtered = Boolean(search || buildId || readyOnly);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border border-rule bg-surface px-3.5 py-2.5">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          apply({ q: draftSearch.trim() || null });
        }}
      >
        <div className="relative">
          <Search
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4"
          />
          <input
            value={draftSearch}
            onChange={(event) => setDraftSearch(event.target.value)}
            placeholder="Find by name…"
            className="w-56 rounded-[9px] border border-rule bg-surface py-1.5 pl-7 pr-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus:border-silver-line"
          />
        </div>
        <Btn variant="outline" size="sm" type="submit">
          Find
        </Btn>
      </form>

      <Btn
        variant={readyOnly ? "primary" : "outline"}
        size="sm"
        onClick={() => apply({ ready: readyOnly ? null : "1" })}
      >
        Ready to publish
      </Btn>

      {buildId && (
        <span className="inline-flex items-center gap-1 rounded-full border border-rule bg-bg-elev px-2 py-0.5 font-mono text-[11px] text-ink-2">
          build {buildId.slice(0, 12)}…
          <button
            type="button"
            onClick={() => apply({ build: null })}
            className="text-ink-3 hover:text-ink"
            aria-label="Clear build filter"
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </span>
      )}

      <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
        Show
        <select
          value={pageSize}
          onChange={(event) => apply({ size: event.target.value })}
          className="rounded-[8px] border border-rule bg-surface px-1.5 py-1 text-[12px] text-ink outline-none focus:border-silver-line"
        >
          {pageSizes.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </label>

      {filtered && (
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => apply({ q: null, build: null, ready: null })}
        >
          Clear filters
        </Btn>
      )}

      {totalPages > 1 && (
        <span className="ml-auto inline-flex items-center gap-1.5">
          <Btn
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => apply({ page: String(page - 1) }, true)}
          >
            Previous
          </Btn>
          <span className="font-mono text-[11.5px] tabular-nums text-ink-3">
            {page} / {totalPages}
          </span>
          <Btn
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => apply({ page: String(page + 1) }, true)}
          >
            Next
          </Btn>
        </span>
      )}
    </div>
  );
}
