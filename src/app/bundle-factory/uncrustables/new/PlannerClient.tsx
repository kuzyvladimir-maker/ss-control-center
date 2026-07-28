/**
 * Uncrustables Studio — client-side recipe planner.
 *
 * Flavor picker (qty steps = carton size), live box-planner validation,
 * cooler band meter, listing copy + price preview. Recipes accumulate into
 * one run; submit POSTs to /api/bundle-factory/uncrustables/runs (which
 * re-validates everything server-side, incl. donor/art readiness) and
 * redirects to the run board.
 */

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  UNCRUSTABLES_FLAVORS,
  buildListingCopy,
  rationalBandFor,
  validateRecipe,
  type RecipeComponent,
} from "@/lib/bundle-factory/uncrustables-box-planner";
import { priceFor } from "@/lib/pricing/cost-model";

type DraftRecipe = { slug: string; comps: RecipeComponent[] };

const FLAVORS = Object.values(UNCRUSTABLES_FLAVORS);
const MAX_TOTAL = 135;

/** Band meter segments across 0..135: proven bands and dead zones. */
const METER_SEGMENTS: { from: number; to: number; label: string; dead: boolean }[] = [
  { from: 0, to: 3, label: "", dead: true },
  { from: 4, to: 30, label: "S", dead: false },
  { from: 31, to: 47, label: "dead", dead: true },
  { from: 48, to: 54, label: "M", dead: false },
  { from: 55, to: 59, label: "dead", dead: true },
  { from: 60, to: 66, label: "L", dead: false },
  { from: 67, to: 89, label: "dead", dead: true },
  { from: 90, to: 135, label: "XL", dead: false },
];

function autoSlug(comps: RecipeComponent[], total: number): string {
  const band = rationalBandFor(total);
  const words = comps
    .map((c) => UNCRUSTABLES_FLAVORS[c.flavor]?.titleName.split(" ")[0].toLowerCase() ?? "x")
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, 3);
  return [band?.name.toLowerCase() ?? "x", ...words, String(total)].join("-");
}

export function PlannerClient() {
  const router = useRouter();
  const [runName, setRunName] = useState("");
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [slugEdited, setSlugEdited] = useState(false);
  const [slug, setSlug] = useState("");
  const [recipes, setRecipes] = useState<DraftRecipe[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [recipeErrors, setRecipeErrors] = useState<Record<string, string[]>>({});

  const comps: RecipeComponent[] = useMemo(
    () =>
      FLAVORS.filter((f) => (qtys[f.component] ?? 0) > 0).map((f) => ({
        flavor: f.component,
        qty: qtys[f.component],
      })),
    [qtys],
  );
  const total = comps.reduce((s, c) => s + c.qty, 0);
  const errors = comps.length ? validateRecipe(comps) : [];
  const band = rationalBandFor(total);
  const price = total > 0 ? priceFor(total) : null;
  const copy = comps.length && errors.length === 0 ? buildListingCopy(comps) : null;
  const effectiveSlug = slugEdited ? slug : comps.length ? autoSlug(comps, total) : "";

  function step(component: string, direction: 1 | -1) {
    const flavor = UNCRUSTABLES_FLAVORS[component];
    if (!flavor) return;
    setQtys((prev) => {
      const next = Math.max(0, (prev[component] ?? 0) + direction * flavor.cartonSize);
      const updated = { ...prev, [component]: next };
      if (next === 0) delete updated[component];
      return updated;
    });
    setSlugEdited(false);
  }

  function addRecipe() {
    if (!comps.length || errors.length || !effectiveSlug) return;
    if (recipes.some((r) => r.slug === effectiveSlug)) {
      setServerError(`Recipe slug "${effectiveSlug}" is already in this run`);
      return;
    }
    setRecipes((prev) => [...prev, { slug: effectiveSlug, comps }]);
    setQtys({});
    setSlug("");
    setSlugEdited(false);
    setServerError(null);
  }

  async function createRun() {
    if (!runName.trim() || recipes.length === 0 || submitting) return;
    setSubmitting(true);
    setServerError(null);
    setRecipeErrors({});
    try {
      const response = await fetch("/api/bundle-factory/uncrustables/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: runName.trim(), recipes }),
      });
      const data = await response.json();
      if (!response.ok) {
        setServerError(data.error ?? `HTTP ${response.status}`);
        if (data.recipe_errors) setRecipeErrors(data.recipe_errors);
        return;
      }
      router.push(`/bundle-factory/uncrustables/${data.run_id}`);
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
      {/* ---- left: picker + validation ---- */}
      <div className="space-y-5">
        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <h2 className="text-[13px] font-semibold text-ink">Flavors</h2>
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            Quantity steps by retail carton size. Proven scene limits: 4 flavors,
            11 cartons, 4 rows, 4 cartons per row.
          </p>
          <div className="mt-3 divide-y divide-rule">
            {FLAVORS.map((f) => {
              const qty = qtys[f.component] ?? 0;
              const cartons = qty / f.cartonSize;
              return (
                <div key={f.component} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-ink">
                      {f.titleName}
                    </div>
                    <div className="truncate text-[11px] text-ink-3">
                      {f.component} · {f.cartonSize}-count carton
                    </div>
                  </div>
                  {qty > 0 && (
                    <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-2">
                      {cartons} × {f.cartonSize}ct
                    </span>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => step(f.component, -1)}
                      disabled={qty === 0}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-rule bg-surface text-[13px] text-ink-2 transition-colors hover:bg-bg-elev disabled:opacity-40"
                      aria-label={`Remove one carton of ${f.titleName}`}
                    >
                      -
                    </button>
                    <span className="w-9 text-center font-mono text-[12.5px] tabular-nums text-ink">
                      {qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => step(f.component, 1)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-rule bg-surface text-[13px] text-ink-2 transition-colors hover:bg-bg-elev"
                      aria-label={`Add one carton of ${f.titleName}`}
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold text-ink">Cooler band</h2>
            <span className="font-mono text-[12.5px] tabular-nums text-ink-2">
              {total} sandwiches{band ? ` · band ${band.name}` : total > 0 ? " · dead zone" : ""}
            </span>
          </div>
          <div className="relative mt-3 flex h-6 w-full overflow-hidden rounded-md border border-rule">
            {METER_SEGMENTS.map((seg, i) => (
              <div
                key={i}
                style={{ width: `${((seg.to - seg.from + 1) / (MAX_TOTAL + 1)) * 100}%` }}
                className={
                  seg.dead
                    ? "flex items-center justify-center bg-bg-elev text-[9.5px] uppercase tracking-wide text-ink-4"
                    : "flex items-center justify-center bg-green-soft text-[10px] font-semibold text-green-ink"
                }
              >
                {seg.dead ? "" : seg.label}
              </div>
            ))}
            {total > 0 && total <= MAX_TOTAL && (
              <div
                className="absolute top-0 h-full w-0.5 bg-ink"
                style={{ left: `${(total / (MAX_TOTAL + 1)) * 100}%` }}
              />
            )}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            Allowed totals: 4-30 (S), 48-54 (M), 60-66 (L), 90-135 (XL). Everything
            else is a dead zone and is refused by the planner.
          </p>
          {errors.length > 0 && (
            <ul className="mt-3 space-y-1">
              {errors.map((e, i) => (
                <li key={i} className="text-[12px] text-red-600">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <h2 className="text-[13px] font-semibold text-ink">Add to run</h2>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex-1">
              <span className="block text-[11px] uppercase tracking-wider text-ink-3">
                Recipe slug
              </span>
              <input
                type="text"
                value={effectiveSlug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugEdited(true);
                }}
                placeholder="s-berry-trio-24"
                className="mt-1 h-9 w-full rounded-md border border-rule bg-surface px-3 font-mono text-[12.5px] text-ink outline-none focus:border-green-soft2"
              />
            </label>
            <button
              type="button"
              onClick={addRecipe}
              disabled={!comps.length || errors.length > 0 || !effectiveSlug}
              className="inline-flex h-9 items-center rounded-md border border-green-soft2 bg-green-soft px-4 text-[12.5px] font-medium text-green-ink transition-colors hover:bg-green-soft2 disabled:opacity-40"
            >
              Add recipe
            </button>
          </div>
        </section>
      </div>

      {/* ---- right: preview + run assembly ---- */}
      <div className="space-y-5">
        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <h2 className="text-[13px] font-semibold text-ink">Listing preview</h2>
          {copy && price ? (
            <div className="mt-3 space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-ink-3">Title</div>
                <p className="mt-0.5 text-[12.5px] text-ink">{copy.title}</p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-ink-3">Bullets</div>
                <ul className="mt-0.5 list-disc space-y-1 pl-4">
                  {copy.bullets.map((b, i) => (
                    <li key={i} className="text-[12px] text-ink-2">
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-ink-3">Price model</div>
                <p className="mt-0.5 font-mono text-[12.5px] tabular-nums text-ink">
                  suggested ${price.suggested.toFixed(2)} · floor ${price.floor.toFixed(2)} ·
                  landed ${price.landed.toFixed(2)} · cooler {price.cooler}
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-[12px] text-ink-3">
              Pick flavors until the recipe passes validation to preview copy and price.
            </p>
          )}
        </section>

        <section className="rounded-[14px] border border-rule bg-surface p-4">
          <h2 className="text-[13px] font-semibold text-ink">
            Run ({recipes.length} recipe{recipes.length === 1 ? "" : "s"})
          </h2>
          <label className="mt-3 block">
            <span className="block text-[11px] uppercase tracking-wider text-ink-3">
              Run name
            </span>
            <input
              type="text"
              value={runName}
              onChange={(e) => setRunName(e.target.value)}
              placeholder="August wave 1"
              className="mt-1 h-9 w-full rounded-md border border-rule bg-surface px-3 text-[12.5px] text-ink outline-none focus:border-green-soft2"
            />
          </label>
          {recipes.length > 0 && (
            <ul className="mt-3 divide-y divide-rule">
              {recipes.map((r) => {
                const rTotal = r.comps.reduce((s, c) => s + c.qty, 0);
                const rErrors = recipeErrors[r.slug];
                return (
                  <li key={r.slug} className="flex items-start gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12.5px] text-ink">{r.slug}</div>
                      <div className="text-[11px] text-ink-3">
                        {rTotal}ct ·{" "}
                        {r.comps
                          .map(
                            (c) =>
                              `${c.qty} ${UNCRUSTABLES_FLAVORS[c.flavor]?.titleName ?? c.flavor}`,
                          )
                          .join(", ")}
                      </div>
                      {rErrors && rErrors.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {rErrors.map((e, i) => (
                            <li key={i} className="text-[11.5px] text-red-600">
                              {e}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setRecipes((prev) => prev.filter((x) => x.slug !== r.slug))
                      }
                      className="shrink-0 rounded-md border border-rule px-2 py-1 text-[11.5px] text-ink-3 transition-colors hover:bg-bg-elev hover:text-ink"
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {serverError && (
            <p className="mt-3 text-[12px] text-red-600">{serverError}</p>
          )}
          <button
            type="button"
            onClick={createRun}
            disabled={!runName.trim() || recipes.length === 0 || submitting}
            className="mt-4 inline-flex h-9 w-full items-center justify-center rounded-md border border-green-soft2 bg-green-soft px-4 text-[12.5px] font-medium text-green-ink transition-colors hover:bg-green-soft2 disabled:opacity-40"
          >
            {submitting ? "Creating run..." : "Create run"}
          </button>
          <p className="mt-2 text-[11px] text-ink-3">
            The server re-validates every recipe, resolves reviewed package art and
            donors fail-closed, and queues candidates as PLANNED. Rendering starts
            from the run board.
          </p>
        </section>
      </div>
    </div>
  );
}
