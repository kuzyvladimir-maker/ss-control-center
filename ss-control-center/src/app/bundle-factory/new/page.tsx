"use client";

/**
 * Bundle Factory — "Start a build", Step 1 (config).
 *
 * The run's knobs: house brand, marketplace, set type, category, counts,
 * target margin, text model, image strategy. On Continue it creates a draft
 * (POST /api/bundle-factory/studio) and moves to Step 2 (pick products).
 *
 * UI strings are English (project rule); only the operator-facing copy.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PageHead, Btn } from "@/components/kit";
import { cn } from "@/lib/utils";
import { ArrowRight, ArrowLeft } from "lucide-react";

type HouseBrand = "Salutem Vita" | "Starfit";
type SetType = "multipack" | "thematic";
type TextModel = "opus" | "sonnet";
type ImageStrategy = "reuse-donor" | "generate";
type ImageModel = "gpt-image-1" | "gpt-image-2";

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "SHELF_STABLE", label: "Shelf-stable" },
  { value: "REFRIGERATED", label: "Refrigerated" },
  { value: "FROZEN_GROCERY", label: "Frozen" },
  { value: "HEALTH_BEAUTY", label: "Health & Beauty" },
  { value: "PET_FOOD", label: "Pet food" },
  { value: "BABY", label: "Baby" },
  { value: "OTHER", label: "Other" },
];

export default function StudioStep1Page() {
  const router = useRouter();

  const [listingName, setListingName] = useState("");
  const [houseBrand, setHouseBrand] = useState<HouseBrand>("Salutem Vita");
  const [setType, setSetType] = useState<SetType>("multipack");
  const [category, setCategory] = useState("SHELF_STABLE");
  const [packCount, setPackCount] = useState(6);
  const [variations, setVariations] = useState(1);
  const [targetMargin, setTargetMargin] = useState("");
  const [textModel, setTextModel] = useState<TextModel>("opus");
  const [imageStrategy, setImageStrategy] = useState<ImageStrategy>("reuse-donor");
  const [imageModel, setImageModel] = useState<ImageModel>("gpt-image-1");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canContinue = listingName.trim().length > 0 && packCount >= 2 && !submitting;

  async function onContinue() {
    if (!canContinue) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/bundle-factory/studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_name: listingName.trim(),
          house_brand: houseBrand,
          marketplace: "amazon",
          set_type: setType,
          category,
          pack_count: packCount,
          variations,
          target_margin_pct: targetMargin ? Number(targetMargin) : null,
          text_model: textModel,
          image_strategy: imageStrategy,
          image_model: imageStrategy === "generate" ? imageModel : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to create the build");
      router.push(`/bundle-factory/new/${data.draft_id}`);
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
          <>
            <span className="font-medium text-ink-2">Step 1 of 3</span>
            <span className="text-ink-4">·</span>
            <span>Configure the run. Next you&apos;ll pick the products.</span>
          </>
        }
      />

      <Link
        href="/bundle-factory"
        className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={1.8} /> Bundle Factory
      </Link>

      <div className="max-w-2xl space-y-4">
        <Field label="Listing name" hint="Internal name for this build — not the marketplace title.">
          <input
            value={listingName}
            onChange={(e) => setListingName(e.target.value)}
            placeholder="e.g. Frozen Breakfast Gift Set"
            className="w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-4 focus:border-silver-line"
          />
        </Field>

        <Field label="House brand" hint="The registered brand the listing is published under.">
          <Segmented
            value={houseBrand}
            onChange={setHouseBrand}
            options={[
              { value: "Salutem Vita", label: "Salutem Vita" },
              { value: "Starfit", label: "Starfit" },
            ]}
          />
        </Field>

        <Field label="Marketplace">
          <Segmented
            value="amazon"
            onChange={() => {}}
            options={[
              { value: "amazon", label: "Amazon" },
              { value: "walmart", label: "Walmart", disabled: true, badge: "Soon" },
            ]}
          />
        </Field>

        <Field
          label="Set type"
          hint={
            setType === "multipack"
              ? "Multipack of one product, presented as a gift set."
              : "Thematic gift set of different products."
          }
        >
          <Segmented
            value={setType}
            onChange={setSetType}
            options={[
              { value: "multipack", label: "Multipack" },
              { value: "thematic", label: "Thematic set" },
            ]}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Category">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-[13.5px] text-ink outline-none focus:border-silver-line"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Items per set">
            <NumberInput value={packCount} onChange={setPackCount} min={2} max={50} />
          </Field>
          <Field label="Variations" hint="Listings to draft.">
            <NumberInput value={variations} onChange={setVariations} min={1} max={5} />
          </Field>
        </div>

        <Field
          label="Target margin"
          hint="Optional. Floor the listing must clear vs cost. Blank = the global default. Price still comes from the economics module."
        >
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
        </Field>

        <Field label="Text model" hint="LLM that writes title, bullets and description.">
          <Segmented
            value={textModel}
            onChange={setTextModel}
            options={[
              { value: "opus", label: "Opus 4.8" },
              { value: "sonnet", label: "Sonnet 4.6" },
            ]}
          />
        </Field>

        <Field
          label="Photos"
          hint={
            imageStrategy === "reuse-donor"
              ? "Use real product photos from the catalog (cheapest, accurate)."
              : "Generate new images. Pick the model below."
          }
        >
          <Segmented
            value={imageStrategy}
            onChange={setImageStrategy}
            options={[
              { value: "reuse-donor", label: "Reuse donor photos" },
              { value: "generate", label: "Generate" },
            ]}
          />
        </Field>

        {imageStrategy === "generate" && (
          <Field label="Image model">
            <Segmented
              value={imageModel}
              onChange={setImageModel}
              options={[
                { value: "gpt-image-1", label: "Image-1 · cheaper" },
                { value: "gpt-image-2", label: "GPT Image-2 · pricier" },
              ]}
            />
          </Field>
        )}

        {error && (
          <div className="rounded-[10px] border border-danger/20 bg-danger-tint px-3 py-2 text-[12.5px] text-danger">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Btn variant="primary" size="md" onClick={onContinue} disabled={!canContinue} loading={submitting}>
            Continue — pick products
            <ArrowRight size={16} strokeWidth={2} />
          </Btn>
          <span className="text-[12px] text-ink-3">Nothing publishes until you approve a preview.</span>
        </div>
      </div>
    </>
  );
}

function Field({
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
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n))));
      }}
      className="w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-[13.5px] tabular-nums text-ink outline-none focus:border-silver-line"
    />
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; disabled?: boolean; badge?: string }>;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={o.disabled}
            onClick={() => !o.disabled && onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[12.5px] font-medium transition-colors",
              active
                ? "border-green bg-green text-green-cream"
                : "border-rule bg-surface text-ink-2 hover:bg-bg-elev",
              o.disabled && "cursor-not-allowed opacity-50 hover:bg-surface"
            )}
          >
            {o.label}
            {o.badge && (
              <span className="rounded-sm bg-silver-tint px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-silver-dark">
                {o.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
