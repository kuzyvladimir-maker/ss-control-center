/**
 * Uncrustables Studio — client review surface.
 *
 * Zoomable/pannable 2048px MAIN, donor reference art, the expected-carton
 * table from recipe_json and the 11-point minter checklist. APPROVE is
 * enabled only when every checklist item is confirmed; the server then
 * re-downloads the exact R2 bytes and verifies sha256 + dimensions before
 * writing APPROVED. REJECT stores the reason and re-queues the render.
 */

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface ReviewRecipeComp {
  flavor: string;
  qty: number;
  box_size: number;
  box_count: number;
  donor_title: string | null;
  donor_image: string | null;
}

interface ReviewCandidate {
  id: string;
  run_id: string;
  slug: string;
  state: string;
  title: string;
  bullets: string[];
  description: string;
  recipe: {
    comps: ReviewRecipeComp[];
    total: number;
    band: string;
    cooler: string;
  } | null;
  price_cents: number;
  pack_count: number;
  main_image_url: string | null;
  image_sha256: string | null;
  pixel_width: number | null;
  pixel_height: number | null;
  reviewed_by: string | null;
  reject_reason: string | null;
  last_error: string | null;
}

/** The 11-point checklist — the exact HumanVisualApprovalChecklist keys the
 *  authenticity gate (and the A4 proof minter) require to all be true. */
const CHECKLIST_ITEMS: { key: string; label: string }[] = [
  {
    key: "image_opened_and_compared_to_registry_evidence",
    label: "Image opened at full size and compared against the reviewed reference art",
  },
  { key: "all_required_flavors_present", label: "Every flavor from the recipe is present" },
  {
    key: "only_reviewed_brand_art_present",
    label: "Only reviewed brand package art appears — no invented designs",
  },
  {
    key: "pack_modes_and_sizes_match_recipe",
    label: "Pack modes and carton sizes match the recipe",
  },
  { key: "no_foreign_or_fictional_items", label: "No foreign or fictional items in the scene" },
  {
    key: "exact_per_variant_package_counts_match_recipe",
    label: "Exact per-flavor carton counts match the recipe",
  },
  {
    key: "frozen_kit_geometry_and_branding_match_anchor",
    label: "Cooler geometry and Salutem Solutions branding match the anchor",
  },
  {
    key: "exactly_two_inside_and_two_outside_gel_packs",
    label: "Exactly two gel packs inside and two outside",
  },
  {
    key: "products_physically_seated_without_floating_or_paste",
    label: "Cartons are physically seated — nothing floats or looks pasted",
  },
  {
    key: "pure_white_square_amazon_main_background",
    label: "Pure white square Amazon MAIN background",
  },
  {
    key: "no_loose_ice_water_overlays_or_extra_props",
    label: "No loose ice, water, text overlays or extra props",
  },
];

export function ReviewClient({ candidate }: { candidate: ReviewCandidate }) {
  const router = useRouter();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [reviewer, setReviewer] = useState("owner");
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ---- zoom/pan state (plain CSS transform — no library).
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(
    null,
  );

  const allChecked = CHECKLIST_ITEMS.every((item) => checked[item.key]);
  const isRendered = candidate.state === "RENDERED";

  function onWheel(event: React.WheelEvent) {
    event.preventDefault();
    setZoom((z) => Math.min(6, Math.max(1, z * (event.deltaY < 0 ? 1.15 : 1 / 1.15))));
  }
  function onMouseDown(event: React.MouseEvent) {
    dragging.current = {
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  }
  function onMouseMove(event: React.MouseEvent) {
    if (!dragging.current) return;
    setPan({
      x: dragging.current.panX + (event.clientX - dragging.current.startX),
      y: dragging.current.panY + (event.clientY - dragging.current.startY),
    });
  }
  function endDrag() {
    dragging.current = null;
  }
  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  async function approve() {
    if (!allChecked || !reviewer.trim() || busy) return;
    setBusy("approve");
    setActionError(null);
    try {
      const response = await fetch(
        `/api/bundle-factory/uncrustables/candidates/${candidate.id}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewer: reviewer.trim() }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        setActionError(
          [data.error, data.expected_sha256 && `expected ${data.expected_sha256}`, data.actual_sha256 && `actual ${data.actual_sha256}`]
            .filter(Boolean)
            .join(" — "),
        );
        return;
      }
      router.push(`/bundle-factory/uncrustables/${candidate.run_id}`);
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!rejectReason.trim() || busy) return;
    setBusy("reject");
    setActionError(null);
    try {
      const response = await fetch(
        `/api/bundle-factory/uncrustables/candidates/${candidate.id}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: rejectReason.trim() }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        setActionError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      router.push(`/bundle-factory/uncrustables/${candidate.run_id}`);
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      {/* ---- left: zoomable image + reference art ---- */}
      <div className="space-y-4">
        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-ink">MAIN candidate</h2>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(6, z * 1.25))}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-rule text-[13px] text-ink-2 hover:bg-bg-elev"
                aria-label="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(1, z / 1.25))}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-rule text-[13px] text-ink-2 hover:bg-bg-elev"
                aria-label="Zoom out"
              >
                -
              </button>
              <button
                type="button"
                onClick={resetView}
                className="inline-flex h-7 items-center rounded-md border border-rule px-2.5 text-[11.5px] text-ink-2 hover:bg-bg-elev"
              >
                Reset
              </button>
              <span className="ml-1 font-mono text-[11.5px] tabular-nums text-ink-3">
                {zoom.toFixed(2)}x
              </span>
            </div>
          </div>
          {candidate.main_image_url ? (
            <div
              className="mt-3 aspect-square w-full cursor-grab overflow-hidden rounded-md border border-rule bg-white active:cursor-grabbing"
              onWheel={onWheel}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={candidate.main_image_url}
                alt={`MAIN candidate ${candidate.slug}`}
                draggable={false}
                className="h-full w-full select-none object-contain"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "center center",
                }}
              />
            </div>
          ) : (
            <p className="mt-3 text-[12.5px] text-ink-3">No rendered image yet.</p>
          )}
          <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-3">
            {candidate.pixel_width && candidate.pixel_height
              ? `${candidate.pixel_width}x${candidate.pixel_height}px`
              : "dimensions unknown"}
            {candidate.image_sha256 ? ` · sha256 ${candidate.image_sha256.slice(0, 16)}…` : ""}
          </p>
        </section>

        {candidate.recipe && (
          <section className="rounded-[14px] border border-rule bg-surface p-4">
            <h2 className="text-[13px] font-semibold text-ink">Reference art (donors)</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {candidate.recipe.comps.map((comp) => (
                <div key={comp.flavor} className="space-y-1">
                  {comp.donor_image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={comp.donor_image}
                      alt={`Donor carton for ${comp.flavor}`}
                      className="aspect-square w-full rounded-md border border-rule bg-white object-contain"
                    />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-rule text-[11px] text-ink-4">
                      No donor image
                    </div>
                  )}
                  <p className="truncate text-[10.5px] text-ink-3" title={comp.flavor}>
                    {comp.flavor}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* ---- right: expected cartons, checklist, actions ---- */}
      <div className="space-y-4">
        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <h2 className="text-[13px] font-semibold text-ink">Expected cartons</h2>
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            {candidate.pack_count} sandwiches · band {candidate.recipe?.band ?? "?"} · $
            {(candidate.price_cents / 100).toFixed(2)}
          </p>
          {candidate.recipe ? (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-[12px] text-ink">
                <thead className="text-[10.5px] uppercase tracking-wider text-ink-3">
                  <tr>
                    <th className="py-1.5 pr-3 text-left font-medium">Flavor</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Cartons</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Badge digit</th>
                    <th className="py-1.5 text-right font-medium">Sandwiches</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {candidate.recipe.comps.map((comp) => (
                    <tr key={comp.flavor}>
                      <td className="py-1.5 pr-3">{comp.flavor}</td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {comp.box_count} × {comp.box_size}ct
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {comp.box_size}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums">{comp.qty}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1.5 pr-3 font-medium">Total</td>
                    <td className="py-1.5 pr-3 text-right font-mono font-medium tabular-nums">
                      {candidate.recipe.comps.reduce((s, c) => s + c.box_count, 0)}
                    </td>
                    <td className="py-1.5 pr-3" />
                    <td className="py-1.5 text-right font-mono font-medium tabular-nums">
                      {candidate.recipe.total}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-[12px] text-red-600">recipe_json failed to parse.</p>
          )}
          {candidate.reject_reason && (
            <p className="mt-3 text-[12px] text-red-700">
              Previous reject reason: {candidate.reject_reason}
            </p>
          )}
        </section>

        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <h2 className="text-[13px] font-semibold text-ink">
            Approval checklist ({CHECKLIST_ITEMS.filter((i) => checked[i.key]).length}/
            {CHECKLIST_ITEMS.length})
          </h2>
          <ul className="mt-3 space-y-2">
            {CHECKLIST_ITEMS.map((item) => (
              <li key={item.key}>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={Boolean(checked[item.key])}
                    onChange={(e) =>
                      setChecked((prev) => ({ ...prev, [item.key]: e.target.checked }))
                    }
                    className="mt-0.5 h-4 w-4 shrink-0 accent-green-700"
                    disabled={!isRendered}
                  />
                  <span className="text-[12px] leading-snug text-ink-2">{item.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <h2 className="text-[13px] font-semibold text-ink">Decision</h2>
          {!isRendered && (
            <p className="mt-2 text-[12px] text-ink-3">
              This candidate is in state {candidate.state}; approve and reject apply only
              to RENDERED candidates.
            </p>
          )}
          <label className="mt-3 block">
            <span className="block text-[11px] uppercase tracking-wider text-ink-3">
              Reviewer
            </span>
            <input
              type="text"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              disabled={!isRendered}
              className="mt-1 h-9 w-full rounded-md border border-rule bg-surface px-3 text-[12.5px] text-ink outline-none focus:border-green-soft2 disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            onClick={() => void approve()}
            disabled={!isRendered || !allChecked || !reviewer.trim() || busy !== null}
            className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-md border border-green-soft2 bg-green-soft px-4 text-[12.5px] font-medium text-green-ink transition-colors hover:bg-green-soft2 disabled:opacity-40"
          >
            {busy === "approve"
              ? "Verifying exact R2 bytes..."
              : "Approve (server re-verifies sha256 + dimensions)"}
          </button>
          {!allChecked && isRendered && (
            <p className="mt-1.5 text-[11px] text-ink-3">
              All {CHECKLIST_ITEMS.length} checklist items must be confirmed to approve.
            </p>
          )}
          <div className="mt-4 border-t border-rule pt-4">
            <label className="block">
              <span className="block text-[11px] uppercase tracking-wider text-ink-3">
                Reject reason
              </span>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                disabled={!isRendered}
                rows={2}
                placeholder="What is wrong with this render"
                className="mt-1 w-full rounded-md border border-rule bg-surface px-3 py-2 text-[12.5px] text-ink outline-none focus:border-green-soft2 disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              onClick={() => void reject()}
              disabled={!isRendered || !rejectReason.trim() || busy !== null}
              className="mt-2 inline-flex h-9 w-full items-center justify-center rounded-md border border-red-200 bg-red-50 px-4 text-[12.5px] font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40"
            >
              {busy === "reject" ? "Rejecting..." : "Reject and re-queue render"}
            </button>
          </div>
          {actionError && <p className="mt-3 text-[12px] text-red-600">{actionError}</p>}
        </section>

        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <h2 className="text-[13px] font-semibold text-ink">Listing copy</h2>
          <p className="mt-2 text-[12.5px] text-ink">{candidate.title}</p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {candidate.bullets.map((b, i) => (
              <li key={i} className="text-[12px] text-ink-2">
                {b}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
