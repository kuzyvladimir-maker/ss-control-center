"use client";

/**
 * Bundle Factory — "Start a build" (prompt-driven mass generator).
 *
 * The operator describes, in plain words, what to mass-create — e.g.
 * "50 Uncrustables gift sets in different variations". The algorithm does the
 * rest: it finds the products in the catalog, assembles the sets, writes the
 * titles + content, makes the photos, and returns a batch of drafts to
 * approve. No manual naming, no category picking.
 *
 * Visible inputs are just the prompt + where to sell. Everything optional
 * (brand, model, photos, margin) lives under "Advanced". UI strings English.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PageHead, Btn } from "@/components/kit";
import { cn } from "@/lib/utils";
import { ArrowLeft, ChevronDown, ChevronRight, Sparkles } from "lucide-react";

type HouseBrand = "Salutem Vita" | "Starfit";
type TextModel = "sonnet" | "opus";
type PhotoStrategy = "reuse-donor" | "generate";
type ImageQuality = "cheaper" | "best";
type UncrustablesImageMode = "retail_boxes" | "individual_wraps";

const CHANNELS: Array<{ value: string; label: string; disabled?: boolean }> = [
  { value: "AMAZON_SALUTEM", label: "Amazon · Salutem Solutions" },
  { value: "AMAZON_PERSONAL", label: "Amazon · Vladimir Personal" },
  { value: "AMAZON_AMZCOM", label: "Amazon · AMZ Commerce" },
  { value: "AMAZON_SIRIUS", label: "Amazon · Sirius International" },
  { value: "AMAZON_RETAILER", label: "Amazon · Retailer Distributor" },
  { value: "WALMART", label: "Walmart (dry multipacks)" },
];

const EXAMPLES = [
  "50 Uncrustables gift sets in different variations",
  "30 frozen breakfast multipacks",
  "20 chocolate variety gift baskets",
];

interface CatalogFlavor {
  key: string;
  label: string;
  donors: number;
  unit_price_cents: number | null;
  pack_sizes: number[];
  eligible_now: boolean;
  costable: boolean;
  missing: { upc: number; ingredients: number; image: number; first_party_offer: number };
  art_approved: boolean | null;
}

export default function StudioStartPage() {
  const router = useRouter();

  const [prompt, setPrompt] = useState("");
  const [channel, setChannel] = useState("AMAZON_SALUTEM");

  // Flavor picker: real catalog flavors for the typed theme. Selected labels
  // are sent as an exact structured filter — the engine fails closed on any
  // flavor it cannot satisfy instead of silently building a different set.
  const [flavors, setFlavors] = useState<CatalogFlavor[] | null>(null);
  const [flavorsLoading, setFlavorsLoading] = useState(false);
  const [flavorsError, setFlavorsError] = useState<string | null>(null);
  const [selectedFlavors, setSelectedFlavors] = useState<Set<string>>(new Set());
  const [listingCount, setListingCount] = useState("");

  async function loadFlavors() {
    const theme = prompt.trim();
    if (theme.length < 3) {
      setFlavorsError("Type the brand/theme first (e.g. Uncrustables).");
      return;
    }
    setFlavorsLoading(true);
    setFlavorsError(null);
    try {
      const res = await fetch(`/api/bundle-factory/studio/flavors?theme=${encodeURIComponent(theme)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to load flavors");
      setFlavors(data.flavors ?? []);
      setSelectedFlavors(new Set());
    } catch (e) {
      setFlavorsError(e instanceof Error ? e.message : "Failed to load flavors");
      setFlavors(null);
    } finally {
      setFlavorsLoading(false);
    }
  }

  function toggleFlavor(key: string) {
    setSelectedFlavors((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [houseBrand, setHouseBrand] = useState<HouseBrand>("Salutem Vita");
  const [textModel, setTextModel] = useState<TextModel>("opus");
  const [photoStrategy, setPhotoStrategy] = useState<PhotoStrategy>("reuse-donor");
  const [imageQuality, setImageQuality] = useState<ImageQuality>("cheaper");
  const [uncrustablesImageMode, setUncrustablesImageMode] =
    useState<UncrustablesImageMode>("retail_boxes");
  const [targetMargin, setTargetMargin] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canGenerate = prompt.trim().length > 0 && !submitting;

  async function onGenerate() {
    if (!canGenerate) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/bundle-factory/studio/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          channel,
          house_brand: houseBrand,
          text_model: textModel,
          photo_strategy: photoStrategy,
          image_quality: imageQuality,
          uncrustables_image_mode: uncrustablesImageMode,
          target_margin_pct: targetMargin ? Number(targetMargin) : null,
          ...(selectedFlavors.size > 0 && flavors
            ? {
                flavors: flavors
                  .filter((f) => selectedFlavors.has(f.key))
                  .map((f) => f.label),
              }
            : {}),
          ...(listingCount && Number(listingCount) >= 1
            ? { listing_count: Number(listingCount) }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to start the build");
      router.push(`/bundle-factory/new/${data.batch_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHead
        title="Start a build"
        subtitle={
          <span>
            Describe what to create. The algorithm finds the products, builds the
            listings, names and writes them — you approve the batch.
          </span>
        }
      />

      <Link
        href="/bundle-factory"
        className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={1.8} /> Bundle Factory
      </Link>

      <div className="max-w-2xl space-y-5">
        {/* PROMPT — the one thing the operator writes. */}
        <div>
          <label className="text-[13px] font-semibold text-ink">
            What should the algorithm create?
          </label>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            Plain words — the brand or theme, how many, and any variations.
          </p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="e.g. 50 Uncrustables gift sets in different variations"
            className="mt-2 w-full resize-y rounded-[12px] border border-rule bg-surface px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-4 focus:border-silver-line"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setPrompt(ex)}
                className="rounded-full border border-rule bg-surface px-2.5 py-1 text-[11.5px] text-ink-3 transition-colors hover:bg-bg-elev hover:text-ink"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        {/* FLAVORS — real catalog flavors for the typed theme; pick exactly
            which to build and how many listings. Optional: skipping it keeps
            the classic prompt-only behaviour. */}
        <div className="rounded-[12px] border border-rule bg-surface-tint/40 px-3.5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold text-ink">Flavors from the catalog</div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
                Load every flavor the reference catalog has for this theme, then pick
                exactly which ones to build.
              </p>
            </div>
            <Btn size="sm" variant="ghost" onClick={loadFlavors} disabled={flavorsLoading}>
              {flavorsLoading ? "Loading…" : flavors ? "Reload" : "Show flavors"}
            </Btn>
          </div>

          {flavorsError && (
            <p className="mt-2 text-[12px] text-red-500">{flavorsError}</p>
          )}

          {flavors && flavors.length === 0 && (
            <p className="mt-2 text-[12px] text-ink-3">
              No flavors found for this theme in the reference catalog.
            </p>
          )}

          {flavors && flavors.length > 0 && (
            <>
              <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {flavors.map((f) => {
                  const blocked = !f.eligible_now || f.art_approved === false;
                  const notes: string[] = [];
                  if (!f.costable) notes.push("no unit cost");
                  if (f.missing.ingredients >= f.donors) notes.push("no ingredients");
                  if (f.missing.upc >= f.donors) notes.push("no UPC");
                  if (f.missing.first_party_offer >= f.donors) notes.push("no 1P offer");
                  if (f.art_approved === false) notes.push("image art not approved");
                  return (
                    <label
                      key={f.key}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-[10px] border px-2.5 py-2 text-[12.5px]",
                        selectedFlavors.has(f.key)
                          ? "border-silver-line bg-bg-elev"
                          : "border-rule bg-surface hover:bg-bg-elev/60",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selectedFlavors.has(f.key)}
                        onChange={() => toggleFlavor(f.key)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className={cn("block truncate font-medium", blocked ? "text-ink-3" : "text-ink")}>
                          {f.label}
                        </span>
                        <span className="block text-[11px] leading-snug text-ink-4">
                          {f.donors} donor{f.donors === 1 ? "" : "s"}
                          {f.unit_price_cents != null
                            ? ` · $${(f.unit_price_cents / 100).toFixed(2)}/unit`
                            : ""}
                          {f.pack_sizes.length > 0 ? ` · packs ${f.pack_sizes.join("/")}` : ""}
                          {notes.length > 0 ? ` · ⚠ ${notes.join(", ")}` : " · ✓ ready"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center gap-3">
                <label className="text-[12.5px] font-medium text-ink-2">Listings to create</label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={listingCount}
                  onChange={(e) => setListingCount(e.target.value)}
                  placeholder="auto"
                  className="w-24 rounded-[10px] border border-rule bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-silver-line"
                />
                <span className="text-[11.5px] text-ink-4">
                  {selectedFlavors.size > 0
                    ? `${selectedFlavors.size} flavor${selectedFlavors.size === 1 ? "" : "s"} selected — singles first, then mixes`
                    : "no flavors selected — the engine uses all it finds"}
                </span>
              </div>
            </>
          )}
        </div>

        {/* SELL ON — where it publishes. */}
        <div>
          <label className="text-[13px] font-semibold text-ink">Sell on</label>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            Which of your channels these listings publish to.
          </p>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="mt-2 w-full rounded-[10px] border border-rule bg-surface px-3 py-2.5 text-[13.5px] text-ink outline-none focus:border-silver-line"
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value} disabled={c.disabled}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        {/* ADVANCED — only what the operator might want to tune: brand, model, photos, margin. */}
        <div className="rounded-[12px] border border-rule bg-surface-tint/40">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3.5 py-3 text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            {showAdvanced ? <ChevronDown size={15} strokeWidth={1.9} /> : <ChevronRight size={15} strokeWidth={1.9} />}
            Advanced
            <span className="ml-1 text-[11.5px] font-normal text-ink-4">brand · model · photos · margin</span>
          </button>

          {showAdvanced && (
            <div className="space-y-5 border-t border-rule px-3.5 py-4">
              <Row label="House brand" hint="Which of your registered brands these publish under.">
                <Segmented
                  value={houseBrand}
                  onChange={setHouseBrand}
                  options={[
                    { value: "Salutem Vita", label: "Salutem Vita" },
                    { value: "Starfit", label: "Starfit" },
                  ]}
                />
              </Row>

              <Row label="Text model" hint="The model that writes titles, bullets and descriptions.">
                <Segmented
                  value={textModel}
                  onChange={setTextModel}
                  options={[
                    { value: "sonnet", label: "Cheaper · Sonnet 4.6" },
                    { value: "opus", label: "Best · Opus 4.8" },
                  ]}
                />
              </Row>

              <Row label="Photos" hint="Reuse real catalog photos, or generate new ones.">
                <Segmented
                  value={photoStrategy}
                  onChange={setPhotoStrategy}
                  options={[
                    { value: "reuse-donor", label: "Use catalog photos" },
                    { value: "generate", label: "Generate" },
                  ]}
                />
              </Row>

              {photoStrategy === "generate" && (
                <Row label="Image quality" hint="Cheaper or the best generator available.">
                  <Segmented
                    value={imageQuality}
                    onChange={setImageQuality}
                    options={[
                      { value: "cheaper", label: "Cheaper" },
                      { value: "best", label: "Best" },
                    ]}
                  />
                </Row>
              )}

              <Row
                label="Uncrustables image style"
                hint="Only affects Uncrustables (own-brand) sets: show real retail cartons, or the individual flavor-coloured sandwich wrappers."
              >
                <Segmented
                  value={uncrustablesImageMode}
                  onChange={setUncrustablesImageMode}
                  options={[
                    { value: "retail_boxes", label: "Retail boxes" },
                    { value: "individual_wraps", label: "Individual wraps" },
                  ]}
                />
              </Row>

              <Row label="Target margin" hint="Floor each listing must clear vs cost. Blank = global default. Price still comes from the economics module.">
                <div className="flex items-center gap-2">
                  <input
                    value={targetMargin}
                    onChange={(e) => setTargetMargin(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="default"
                    inputMode="decimal"
                    className="w-28 rounded-[10px] border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-4 focus:border-silver-line"
                  />
                  <span className="text-[13px] text-ink-3">%</span>
                </div>
              </Row>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-[10px] border border-danger/20 bg-danger-tint px-3 py-2 text-[12.5px] text-danger">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Btn variant="primary" size="md" onClick={onGenerate} disabled={!canGenerate} loading={submitting} icon={<Sparkles size={15} strokeWidth={1.9} />}>
            Generate listings
          </Btn>
          <span className="text-[12px] text-ink-3">Nothing publishes until you approve the batch.</span>
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[12.5px] font-medium text-ink">{label}</label>
      {hint && <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-[10px] border px-3 py-2 text-[12.5px] font-medium transition-colors",
              active
                ? "border-green bg-green text-green-cream"
                : "border-rule bg-surface text-ink-2 hover:bg-bg-elev"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
