"use client";

/**
 * Multi-step Brief creation form.
 *
 * Step 1 — name + brand
 * Step 2 — category + composition type
 * Step 3 — pack count + target channels (only Phase 2 channels enabled)
 * Step 4 — review + submit
 *
 * Defaults follow Vladimir's most common shape: Salutem Vita, FROZEN_GROCERY,
 * CROSS_BRAND, pack 12, all 6 Phase-2 channels checked.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Btn } from "@/components/kit";
import {
  PRODUCT_CATEGORIES,
  COMPOSITION_TYPES,
  type SalesChannel,
} from "@/lib/bundle-factory/enums";

type Brand = "Salutem Vita" | "Starfit" | "Other";

const BRAND_OPTIONS: Brand[] = ["Salutem Vita", "Starfit", "Other"];

const PHASE_2_CHANNELS: SalesChannel[] = [
  "AMAZON_SALUTEM",
  "AMAZON_PERSONAL",
  "AMAZON_AMZCOM",
  "AMAZON_SIRIUS",
  "AMAZON_RETAILER",
  "WALMART",
];

const PHASE_3_CHANNELS: SalesChannel[] = ["EBAY", "TIKTOK_1", "TIKTOK_2"];

const CHANNEL_LABEL: Record<SalesChannel, string> = {
  AMAZON_SALUTEM: "Amazon · Salutem",
  AMAZON_PERSONAL: "Amazon · Personal",
  AMAZON_AMZCOM: "Amazon · AMZ Commerce",
  AMAZON_SIRIUS: "Amazon · Sirius",
  AMAZON_RETAILER: "Amazon · Retailer",
  WALMART: "Walmart",
  EBAY: "eBay",
  TIKTOK_1: "TikTok · 1",
  TIKTOK_2: "TikTok · 2",
};

const CATEGORY_LABEL: Record<(typeof PRODUCT_CATEGORIES)[number], string> = {
  FROZEN_GROCERY: "Frozen Grocery",
  REFRIGERATED: "Refrigerated",
  SHELF_STABLE: "Shelf-stable",
  PET_FOOD: "Pet Food",
  HEALTH_BEAUTY: "Health & Beauty",
  BABY: "Baby",
  OTHER: "Other",
};

const COMPOSITION_LABEL: Record<(typeof COMPOSITION_TYPES)[number], string> = {
  SINGLE_FLAVOR: "Single flavor",
  MIXED_FLAVOR: "Mixed flavors",
  USE_CASE: "Use-case themed",
  HOLIDAY_THEMED: "Holiday themed",
  CROSS_BRAND: "Cross-brand variety",
};

interface FormState {
  draft_name: string;
  brandKind: Brand;
  brandCustom: string;
  category: (typeof PRODUCT_CATEGORIES)[number];
  composition_type: (typeof COMPOSITION_TYPES)[number];
  pack_count: number;
  target_channels: SalesChannel[];
}

const INITIAL_STATE: FormState = {
  draft_name: "",
  brandKind: "Salutem Vita",
  brandCustom: "",
  category: "FROZEN_GROCERY",
  composition_type: "CROSS_BRAND",
  pack_count: 12,
  target_channels: [...PHASE_2_CHANNELS],
};

export function NewBriefForm() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<FormState>(INITIAL_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolvedBrand =
    state.brandKind === "Other" ? state.brandCustom.trim() : state.brandKind;

  const step1Valid = useMemo(() => {
    if (state.draft_name.trim().length < 5 || state.draft_name.length > 100) {
      return false;
    }
    if (state.brandKind === "Other" && state.brandCustom.trim().length < 2) {
      return false;
    }
    return true;
  }, [state]);

  const step2Valid = Boolean(state.category && state.composition_type);
  const step3Valid =
    state.pack_count >= 2 &&
    state.pack_count <= 50 &&
    state.target_channels.length > 0;

  const canAdvance =
    (step === 1 && step1Valid) ||
    (step === 2 && step2Valid) ||
    (step === 3 && step3Valid);

  function toggleChannel(ch: SalesChannel) {
    setState((s) => ({
      ...s,
      target_channels: s.target_channels.includes(ch)
        ? s.target_channels.filter((c) => c !== ch)
        : [...s.target_channels, ch],
    }));
  }

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        draft_name: state.draft_name.trim(),
        brand: resolvedBrand,
        category: state.category,
        composition_type: state.composition_type,
        pack_count: state.pack_count,
        target_channels: state.target_channels,
      };
      const r = await fetch("/api/bundle-factory/briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as { brief: { id: string } };
      router.push(`/bundle-factory/briefs/${data.brief.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <StepIndicator current={step} />

      <div className="rounded-[14px] border border-rule bg-surface p-5">
        {step === 1 && (
          <Step1
            state={state}
            setState={setState}
          />
        )}
        {step === 2 && <Step2 state={state} setState={setState} />}
        {step === 3 && (
          <Step3
            state={state}
            setState={setState}
            toggleChannel={toggleChannel}
          />
        )}
        {step === 4 && (
          <Step4 state={state} resolvedBrand={resolvedBrand} />
        )}

        {error && (
          <div className="mt-4 rounded-md border border-danger/30 bg-danger-tint/40 p-3 text-[12.5px] text-danger">
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <div>
            {step > 1 && (
              <Btn
                variant="ghost"
                onClick={() => setStep((s) => Math.max(1, s - 1))}
              >
                ← Back
              </Btn>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/bundle-factory/briefs"
              className="text-[12.5px] text-ink-3 hover:text-ink-2"
            >
              Cancel
            </Link>
            {step < 4 ? (
              <Btn
                variant="primary"
                onClick={() => setStep((s) => Math.min(4, s + 1))}
                disabled={!canAdvance}
              >
                Continue →
              </Btn>
            ) : (
              <Btn variant="primary" onClick={submit} loading={submitting}>
                Create brief
              </Btn>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────

function Step1({
  state,
  setState,
}: {
  state: FormState;
  setState: (fn: (s: FormState) => FormState) => void;
}) {
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Step 1 · Idea + Brand"
        subtitle="What's the concept? Which house brand does it ship under?"
      />
      <Field label="Draft name (5–100 chars)">
        <input
          value={state.draft_name}
          onChange={(e) =>
            setState((s) => ({ ...s, draft_name: e.target.value }))
          }
          placeholder="e.g. Pizza Lunch Variety Gift Set"
          maxLength={100}
          className="w-full rounded-md border border-rule bg-bg-elev px-3 py-2 text-[13px] text-ink"
        />
        <Counter value={state.draft_name.length} min={5} max={100} />
      </Field>
      <Field label="House brand">
        <div className="grid grid-cols-3 gap-2">
          {BRAND_OPTIONS.map((b) => (
            <RadioCard
              key={b}
              active={state.brandKind === b}
              onClick={() =>
                setState((s) => ({ ...s, brandKind: b as Brand }))
              }
              label={b}
            />
          ))}
        </div>
        {state.brandKind === "Other" && (
          <input
            value={state.brandCustom}
            onChange={(e) =>
              setState((s) => ({ ...s, brandCustom: e.target.value }))
            }
            placeholder="Custom brand name"
            className="mt-2 w-full rounded-md border border-rule bg-bg-elev px-3 py-2 text-[13px] text-ink"
          />
        )}
      </Field>
    </div>
  );
}

function Step2({
  state,
  setState,
}: {
  state: FormState;
  setState: (fn: (s: FormState) => FormState) => void;
}) {
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Step 2 · Category + Composition"
        subtitle="How should the research focus and what shape is the bundle?"
      />
      <Field label="Product category">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PRODUCT_CATEGORIES.map((c) => (
            <RadioCard
              key={c}
              active={state.category === c}
              onClick={() => setState((s) => ({ ...s, category: c }))}
              label={CATEGORY_LABEL[c]}
            />
          ))}
        </div>
      </Field>
      <Field label="Composition type">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {COMPOSITION_TYPES.map((t) => (
            <RadioCard
              key={t}
              active={state.composition_type === t}
              onClick={() => setState((s) => ({ ...s, composition_type: t }))}
              label={COMPOSITION_LABEL[t]}
            />
          ))}
        </div>
      </Field>
    </div>
  );
}

function Step3({
  state,
  setState,
  toggleChannel,
}: {
  state: FormState;
  setState: (fn: (s: FormState) => FormState) => void;
  toggleChannel: (ch: SalesChannel) => void;
}) {
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Step 3 · Pack size + Channels"
        subtitle="Each bundle ships as N units; channels are the 6 Phase-2 stores."
      />
      <Field label="Pack count (2–50)">
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={2}
            max={50}
            value={state.pack_count}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                pack_count: Number.parseInt(e.target.value, 10) || 0,
              }))
            }
            className="w-28 rounded-md border border-rule bg-bg-elev px-3 py-2 text-[13px] tabular-nums text-ink"
          />
          <span className="text-[12px] text-ink-3">
            ×{state.pack_count} units per bundle
          </span>
        </div>
      </Field>
      <Field label="Target channels (Phase 2)">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PHASE_2_CHANNELS.map((ch) => (
            <ChannelCheckbox
              key={ch}
              channel={ch}
              checked={state.target_channels.includes(ch)}
              onChange={() => toggleChannel(ch)}
            />
          ))}
        </div>
      </Field>
      <Field label="Coming in Phase 3+">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PHASE_3_CHANNELS.map((ch) => (
            <div
              key={ch}
              title="Coming in Phase 3 — eBay / TikTok distribution"
              className="flex items-center gap-2 rounded-md border border-rule/60 bg-bg-elev/40 px-3 py-2 text-[12.5px] text-ink-3"
            >
              <span className="grid h-4 w-4 place-items-center rounded border border-rule/60 bg-bg-elev/60" />
              <span className="line-through">{CHANNEL_LABEL[ch]}</span>
              <span className="ml-auto rounded bg-bg-elev px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-3">
                Phase 3+
              </span>
            </div>
          ))}
        </div>
      </Field>
    </div>
  );
}

function Step4({
  state,
  resolvedBrand,
}: {
  state: FormState;
  resolvedBrand: string;
}) {
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Step 4 · Review"
        subtitle="Confirm everything before we create the brief."
      />
      <ReviewRow label="Draft name" value={state.draft_name} />
      <ReviewRow label="Brand" value={resolvedBrand} />
      <ReviewRow label="Category" value={CATEGORY_LABEL[state.category]} />
      <ReviewRow
        label="Composition"
        value={COMPOSITION_LABEL[state.composition_type]}
      />
      <ReviewRow label="Pack count" value={`×${state.pack_count}`} />
      <ReviewRow
        label="Channels"
        value={state.target_channels
          .map((c) => CHANNEL_LABEL[c as SalesChannel])
          .join(", ")}
      />
      <p className="text-[12px] text-ink-3">
        After creation, the brief lands in status <strong>DRAFT</strong>. Click
        <strong> Run Research</strong> on the detail page to call Perplexity
        and populate the candidate pool.
      </p>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: number }) {
  const steps = [1, 2, 3, 4];
  return (
    <div className="flex items-center gap-3">
      {steps.map((s, i) => (
        <div key={s} className="flex flex-1 items-center gap-3">
          <div
            className={`grid h-7 w-7 place-items-center rounded-full border text-[11px] font-medium ${
              s === current
                ? "border-green bg-green text-cream"
                : s < current
                  ? "border-green-soft2 bg-green-soft text-green-ink"
                  : "border-rule bg-surface text-ink-3"
            }`}
          >
            {s}
          </div>
          {i < steps.length - 1 && (
            <div
              className={`h-px flex-1 ${s < current ? "bg-green-soft2" : "bg-rule"}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
      <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </div>
      {children}
    </div>
  );
}

function Counter({
  value,
  min,
  max,
}: {
  value: number;
  min: number;
  max: number;
}) {
  const ok = value >= min && value <= max;
  return (
    <div
      className={`mt-1 text-[11px] tabular-nums ${ok ? "text-ink-3" : "text-warn"}`}
    >
      {value} / {max} chars
    </div>
  );
}

function RadioCard({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors ${
        active
          ? "border-green ring-2 ring-green/30 bg-green-soft text-green-ink"
          : "border-rule bg-surface text-ink hover:border-ink-3"
      }`}
    >
      {label}
    </button>
  );
}

function ChannelCheckbox({
  channel,
  checked,
  onChange,
}: {
  channel: SalesChannel;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[12.5px] transition-colors ${
        checked
          ? "border-green bg-green-soft text-green-ink"
          : "border-rule bg-surface text-ink hover:border-ink-3"
      }`}
    >
      <span
        className={`grid h-4 w-4 place-items-center rounded border ${
          checked ? "border-green bg-green text-cream" : "border-rule bg-bg-elev"
        }`}
      >
        {checked && <Checkmark />}
      </span>
      {CHANNEL_LABEL[channel]}
    </button>
  );
}

function Checkmark() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="2 6 5 9 10 3" />
    </svg>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between border-b border-rule/40 py-2 last:border-b-0">
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </span>
      <span className="ml-4 text-right text-[12.5px] text-ink">{value}</span>
    </div>
  );
}

