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

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PageHead, Btn } from "@/components/kit";
import {
  WalmartShippingTemplateSelector,
  type WalmartShippingSelection,
} from "@/components/bundle-factory/WalmartShippingTemplateSelector";
import {
  resolveWalmartStudioRequestIntent,
} from "@/lib/bundle-factory/walmart-studio-request";
import { CLAUDE, CLAUDE_MODEL_LABELS } from "@/lib/ai-models";
import { cn } from "@/lib/utils";
import { ArrowLeft, ChevronDown, ChevronRight, Sparkles } from "lucide-react";

type HouseBrand = "Salutem Vita" | "Starfit";
type PhotoStrategy = "reuse-donor" | "generate";
type ImageQuality = "cheaper" | "best";
type UncrustablesImageMode = "retail_boxes" | "individual_wraps";

const CHANNELS: Array<{ value: string; label: string; disabled?: boolean }> = [
  { value: "AMAZON_SALUTEM", label: "Amazon · Salutem Solutions" },
  { value: "AMAZON_PERSONAL", label: "Amazon · Vladimir Personal" },
  { value: "AMAZON_AMZCOM", label: "Amazon · AMZ Commerce" },
  { value: "AMAZON_SIRIUS", label: "Amazon · Sirius International" },
  { value: "AMAZON_RETAILER", label: "Amazon · Retailer Distributor" },
  {
    value: "WALMART",
    label: "Walmart · new SKU",
  },
];

const EXAMPLES = [
  "50 Uncrustables gift sets in different variations",
  "30 frozen breakfast multipacks",
  "20 chocolate variety gift baskets",
];

const WALMART_COLLECTION_RECOVERY_KEY =
  "bundle-factory:walmart-product-truth-collection:v1";

interface CatalogFlavor {
  key: string;
  label: string;
  donors: number;
  unit_price_cents: number | null;
  pack_sizes: number[];
  buildable: boolean;
  missing: { upc: number; ingredients: number; image: number; first_party_offer: number; unit_cost: number };
  art_approved: boolean | null;
}

interface WalmartReadinessCandidate {
  donor_product_id: string;
  canonical_variant_id: string;
  title: string;
  brand: string;
  ready: boolean;
  missing: string[];
  data_collection: {
    supported: boolean;
    reason: string;
  } | null;
}

interface WalmartReadinessResult {
  catalog: {
    matched_variants: number;
    ready_variants: number;
    enough_ready: boolean;
    candidates: WalmartReadinessCandidate[];
  };
  diagnosis: {
    capability_gaps: Array<{ code: string; message: string }>;
    data_gap: {
      requested_variants: number;
      ready_variants: number;
      missing_ready_variants: number;
    } | null;
    no_exact_matches: boolean;
  };
  fallback: {
    required: boolean;
    engine: string | null;
    target_donor_product_ids: string[];
    web_control: {
      status: "OFF" | "ACTIVE";
      stage: string;
      command_admission: boolean;
      worker_claims: boolean;
      metered_execution: boolean;
      provider_calls_from_web: false;
      marketplace_mutations: false;
    };
    automatic_web_execution: boolean;
    automatic_web_execution_reason: string;
    recommendation: string | null;
  };
}

interface WalmartCollectionState {
  batchId: string;
  status:
    | "QUEUED_NO_SPEND"
    | "RUNNING_NO_SPEND"
    | "AWAITING_OWNER"
    | "RUNNING_ENRICHMENT"
    | "DECLINED"
    | "FAILED"
    | "AMBIGUOUS"
    | "SUCCEEDED";
  jobs: Array<{
    run_id: string;
    donor_product_id: string;
    title: string;
    missing_fields: string[];
    doctor_status: string;
    plan_status: string | null;
    phase: string;
    error_code: string | null;
  }>;
  quote: null | {
    quote_id: string;
    quote_sha256: string;
    expires_at: string;
    cost_unit: "PREPAID_PROVIDER_CREDITS";
    usd_equivalent: null;
    balance_probe_maximum_units: number;
    job_maximum_units: number;
    maximum_provider_units: number;
    actions: Array<{
      ordinal: number;
      run_id: string;
      title: string;
      missing_fields: string[];
      oxylabs_query_maximum_units: number;
      unwrangle_detail_maximum_units: number;
      maximum_provider_units: number;
    }>;
  };
  approval: null | {
    command_id: string;
    status: string;
    outcome: string | null;
    error_code: string | null;
    authorized_at: string | null;
    authorization_expires_at: string | null;
    execution_started_at: string | null;
    updated_at: string;
  };
}

const WALMART_GAP_LABELS: Record<string, string> = {
  EXACT_CONTENT_EVIDENCE: "verified exact product content",
  TITLE: "exact title",
  MAIN_IMAGE: "main image",
  MANUFACTURER_UPC: "manufacturer UPC",
  INGREDIENTS: "ingredients",
  NUTRITION: "nutrition facts",
  ALLERGENS: "allergen information",
  FRESH_LOCAL_PRICE: "current exact purchase price",
  CATEGORY: "category evidence",
  SHELF_STABLE_CLASSIFICATION: "shelf-stable classification",
  CURRENT_MATCHER_PROVENANCE: "current exact-identity proof",
  POLICY_ELIGIBILITY: "Walmart pilot eligibility evidence",
};

export default function StudioStartPage() {
  const router = useRouter();

  const [prompt, setPrompt] = useState("");
  const [channel, setChannel] = useState("AMAZON_SALUTEM");
  const [walmartShipping, setWalmartShipping] =
    useState<WalmartShippingSelection | null>(null);

  // Flavor picker: real catalog flavors for the typed theme. Selected labels
  // are sent as an exact structured filter — the engine fails closed on any
  // flavor it cannot satisfy instead of silently building a different set.
  const [flavors, setFlavors] = useState<CatalogFlavor[] | null>(null);
  const [flavorsLoading, setFlavorsLoading] = useState(false);
  const [flavorsError, setFlavorsError] = useState<string | null>(null);
  const [selectedFlavors, setSelectedFlavors] = useState<Set<string>>(new Set());
  const [listingCount, setListingCount] = useState("");
  const [packCount, setPackCount] = useState("");
  const [walmartReadiness, setWalmartReadiness] =
    useState<WalmartReadinessResult | null>(null);
  const [walmartReadinessLoading, setWalmartReadinessLoading] = useState(false);
  const [walmartReadinessError, setWalmartReadinessError] =
    useState<string | null>(null);
  const [walmartCollection, setWalmartCollection] =
    useState<WalmartCollectionState | null>(null);
  const [walmartCollectionLoading, setWalmartCollectionLoading] =
    useState(false);
  const [walmartApprovalLoading, setWalmartApprovalLoading] =
    useState<"APPROVE" | "DECLINE" | null>(null);
  const [walmartCollectionError, setWalmartCollectionError] =
    useState<string | null>(null);
  const [restoredWalmartCollectionBatchId, setRestoredWalmartCollectionBatchId] =
    useState<string | null>(null);
  const collectionPollTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pollWalmartCollectionRef = useRef<(batchId: string) => void>(
    () => undefined,
  );

  useEffect(() => () => {
    if (collectionPollTimer.current) {
      clearTimeout(collectionPollTimer.current);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(
        WALMART_COLLECTION_RECOVERY_KEY,
      );
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        batchId?: unknown;
        prompt?: unknown;
        listingCount?: unknown;
        packCount?: unknown;
        walmartShipping?: unknown;
      };
      if (
        typeof saved.batchId !== "string"
        || !/^ptbfw-[a-f0-9]{24}$/u.test(saved.batchId)
        || typeof saved.prompt !== "string"
        || saved.prompt.length < 3
        || saved.prompt.length > 1_000
      ) {
        window.sessionStorage.removeItem(
          WALMART_COLLECTION_RECOVERY_KEY,
        );
        return;
      }
      setChannel("WALMART");
      setPrompt(saved.prompt);
      setListingCount(
        typeof saved.listingCount === "number"
          ? String(saved.listingCount)
          : "",
      );
      setPackCount(
        typeof saved.packCount === "number"
          ? String(saved.packCount)
          : "",
      );
      if (
        saved.walmartShipping !== null
        && typeof saved.walmartShipping === "object"
        && !Array.isArray(saved.walmartShipping)
        && "template_id" in saved.walmartShipping
        && typeof saved.walmartShipping.template_id === "string"
      ) {
        setWalmartShipping(
          saved.walmartShipping as WalmartShippingSelection,
        );
      }
      setRestoredWalmartCollectionBatchId(saved.batchId);
    } catch {
      window.sessionStorage.removeItem(
        WALMART_COLLECTION_RECOVERY_KEY,
      );
    }
  }, []);

  useEffect(() => {
    if (!restoredWalmartCollectionBatchId) return;
    pollWalmartCollectionRef.current(restoredWalmartCollectionBatchId);
    setRestoredWalmartCollectionBatchId(null);
  }, [restoredWalmartCollectionBatchId]);

  function clearWalmartCollection() {
    if (collectionPollTimer.current) {
      clearTimeout(collectionPollTimer.current);
      collectionPollTimer.current = null;
    }
    setWalmartCollection(null);
    setWalmartCollectionError(null);
    setWalmartCollectionLoading(false);
    setWalmartApprovalLoading(null);
    window.sessionStorage.removeItem(WALMART_COLLECTION_RECOVERY_KEY);
  }

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
      setSelectedFlavors(new Set());
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

  async function checkWalmartReadiness(): Promise<WalmartReadinessResult | null> {
    const theme = prompt.trim();
    if (theme.length < 3) {
      setWalmartReadinessError("Describe the products first.");
      return null;
    }
    setWalmartReadinessLoading(true);
    setWalmartReadinessError(null);
    try {
      const search = new URLSearchParams({ prompt: theme });
      if (structuredListingCount != null) {
        search.set("listing_count", String(structuredListingCount));
      }
      if (structuredPackCount != null) {
        search.set("pack_count", String(structuredPackCount));
      }
      const res = await fetch(
        `/api/bundle-factory/walmart/readiness?${search.toString()}`,
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? "Walmart readiness check failed");
      }
      const result = data as WalmartReadinessResult;
      setWalmartReadiness(result);
      return result;
    } catch (e) {
      setWalmartReadinessError(
        e instanceof Error ? e.message : "Walmart readiness check failed",
      );
      setWalmartReadiness(null);
      return null;
    } finally {
      setWalmartReadinessLoading(false);
    }
  }

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [houseBrand, setHouseBrand] = useState<HouseBrand>("Salutem Vita");
  const [photoStrategy, setPhotoStrategy] = useState<PhotoStrategy>("reuse-donor");
  const [imageQuality, setImageQuality] = useState<ImageQuality>("cheaper");
  const [uncrustablesImageMode, setUncrustablesImageMode] =
    useState<UncrustablesImageMode>("retail_boxes");
  const [targetMargin, setTargetMargin] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const walmartShippingReady =
    channel !== "WALMART" ||
    (
      walmartShipping != null &&
      walmartShipping.template_status === "ACTIVE"
    );
  const structuredListingCount =
    /^\d+$/.test(listingCount) && Number(listingCount) >= 1
      ? Number(listingCount)
      : null;
  const structuredPackCount =
    /^\d+$/.test(packCount) && Number(packCount) >= 1
      ? Number(packCount)
      : null;
  const walmartRequest =
    channel === "WALMART"
      ? resolveWalmartStudioRequestIntent({
          prompt,
          listingCount: structuredListingCount,
          packCount: structuredPackCount,
        })
      : null;
  const walmartFieldsValid =
    channel !== "WALMART" ||
    (
      (listingCount === "" || structuredListingCount != null) &&
      (packCount === "" || structuredPackCount != null) &&
      walmartRequest?.blockers.length === 0
    );
  const canGenerate =
    prompt.trim().length > 0 &&
    walmartShippingReady &&
    walmartFieldsValid &&
    !submitting;

  async function submitStudioGeneration() {
    const res = await fetch("/api/bundle-factory/studio/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: prompt.trim(),
        channel,
        target_margin_pct: targetMargin ? Number(targetMargin) : null,
        ...(channel !== "WALMART"
          ? {
              house_brand: houseBrand,
              photo_strategy: photoStrategy,
              image_quality: imageQuality,
              uncrustables_image_mode: uncrustablesImageMode,
            }
          : {}),
        ...(channel === "WALMART" && walmartShipping
          ? {
              walmart_shipping: {
                store_index: walmartShipping.store_index,
                account_name: walmartShipping.account_name,
                template_id: walmartShipping.template_id,
                template_name: walmartShipping.template_name,
                template_status: walmartShipping.template_status,
                rate_model_type: walmartShipping.rate_model_type,
                is_free_shipping: walmartShipping.is_free_shipping,
                template_sha256: walmartShipping.template_sha256,
                template_modified_at:
                  walmartShipping.template_modified_at,
              },
            }
          : {}),
        ...(selectedFlavors.size > 0 && flavors
          ? {
              // Keys are the engine's own identity tokens (same dedupe run) —
              // labels proved ambiguous across pools (review 2026-07-21).
              flavors: flavors
                .filter((f) => selectedFlavors.has(f.key))
                .map((f) => f.key),
            }
          : {}),
        ...(listingCount && Number(listingCount) >= 1
          ? { listing_count: Number(listingCount) }
          : {}),
        ...(channel === "WALMART" && packCount && Number(packCount) >= 1
          ? { pack_count: Number(packCount) }
          : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? "Failed to start the build");
    window.sessionStorage.removeItem(WALMART_COLLECTION_RECOVERY_KEY);
    router.push(`/bundle-factory/new/${data.batch_id}`);
  }

  async function continueAfterCollection() {
    const readiness = await checkWalmartReadiness();
    if (
      !readiness
      || !readiness.catalog.enough_ready
      || readiness.diagnosis.capability_gaps.length > 0
    ) {
      setError(
        "Product data changed, but the Walmart request still has a visible blocker. Review the updated readiness result.",
      );
      return;
    }
    if (!walmartShippingReady || !walmartFieldsValid) {
      setError(
        "Product data is ready. Select an active shipping template and correct the visible Walmart scope to continue.",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await submitStudioGeneration();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  function persistWalmartCollectionRecovery(batchId: string) {
    window.sessionStorage.setItem(
      WALMART_COLLECTION_RECOVERY_KEY,
      JSON.stringify({
        batchId,
        prompt: prompt.trim(),
        listingCount:
          structuredListingCount ?? walmartRequest?.listing_count ?? 2,
        packCount:
          structuredPackCount ?? walmartRequest?.pack_count ?? 2,
        walmartShipping,
      }),
    );
  }

  async function pollWalmartCollection(batchId: string) {
    try {
      const res = await fetch(
        `/api/bundle-factory/walmart/data-collection?batch_id=${encodeURIComponent(batchId)}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.message ?? data?.code ?? "Collection status check failed",
        );
      }
      const collection = data.collection as WalmartCollectionState;
      setWalmartCollection(collection);
      persistWalmartCollectionRecovery(collection.batchId);
      if (
        collection.status === "QUEUED_NO_SPEND"
        || collection.status === "RUNNING_NO_SPEND"
        || collection.status === "RUNNING_ENRICHMENT"
      ) {
        collectionPollTimer.current = setTimeout(
          () => void pollWalmartCollection(batchId),
          4_000,
        );
      } else if (collection.status === "SUCCEEDED") {
        await continueAfterCollection();
      }
    } catch (e) {
      setWalmartCollectionError(
        e instanceof Error ? e.message : "Collection status check failed",
      );
    }
  }
  pollWalmartCollectionRef.current = (batchId: string) => {
    void pollWalmartCollection(batchId);
  };

  async function prepareWalmartOwnerAuthorization(
    collection: WalmartCollectionState,
  ) {
    if (!collection.quote) {
      throw new Error("The exact enrichment quote is not available.");
    }
    const res = await fetch(
      `/api/bundle-factory/walmart/data-collection/${encodeURIComponent(collection.batchId)}/approval`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "PREPARE_OWNER_AUTHORIZATION",
          quote_sha256: collection.quote.quote_sha256,
        }),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        data?.message ?? data?.code ?? "Owner authorization could not be prepared",
      );
    }
    return data.approval as {
      command_id: string;
      command_sha256: string;
      quote: unknown;
      quote_sha256: string;
      envelope: unknown;
      owner_agent_url: string;
    };
  }

  async function approveWalmartEnrichment() {
    if (!walmartCollection?.quote) return;
    setWalmartApprovalLoading("APPROVE");
    setWalmartCollectionError(null);
    try {
      const approval = await prepareWalmartOwnerAuthorization(
        walmartCollection,
      );
      let ownerResponse: Response;
      try {
        ownerResponse = await fetch(approval.owner_agent_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command_sha256: approval.command_sha256,
            quote_sha256: approval.quote_sha256,
            quote: approval.quote,
            envelope: approval.envelope,
          }),
        });
      } catch {
        throw new Error(
          "The protected owner approval agent on this Mac is not reachable. No provider credits were spent.",
        );
      }
      const signed = await ownerResponse.json();
      if (!ownerResponse.ok || signed?.ok !== true) {
        throw new Error(
          signed?.message
            ?? "The local owner agent rejected this exact quote. No credits were spent.",
        );
      }
      const authorize = await fetch(
        `/api/bundle-factory/walmart/data-collection/${encodeURIComponent(walmartCollection.batchId)}/approval`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "AUTHORIZE",
            command_id: approval.command_id,
            signature_base64: signed.signature_base64,
          }),
        },
      );
      const result = await authorize.json();
      if (!authorize.ok) {
        throw new Error(
          result?.message ?? result?.code ?? "Exact approval was not admitted",
        );
      }
      await pollWalmartCollection(walmartCollection.batchId);
    } catch (e) {
      setWalmartCollectionError(
        e instanceof Error ? e.message : "Enrichment approval failed closed",
      );
    } finally {
      setWalmartApprovalLoading(null);
    }
  }

  async function declineWalmartEnrichment() {
    if (!walmartCollection?.quote) return;
    setWalmartApprovalLoading("DECLINE");
    setWalmartCollectionError(null);
    try {
      await prepareWalmartOwnerAuthorization(walmartCollection);
      const response = await fetch(
        `/api/bundle-factory/walmart/data-collection/${encodeURIComponent(walmartCollection.batchId)}/approval`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "DECLINE" }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result?.message ?? result?.code ?? "Quote could not be declined",
        );
      }
      await pollWalmartCollection(walmartCollection.batchId);
    } catch (e) {
      setWalmartCollectionError(
        e instanceof Error ? e.message : "Quote could not be declined",
      );
    } finally {
      setWalmartApprovalLoading(null);
    }
  }

  async function startWalmartDataCollection() {
    setWalmartCollectionLoading(true);
    setWalmartCollectionError(null);
    setError(null);
    try {
      const res = await fetch(
        "/api/bundle-factory/walmart/data-collection",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim(),
            listing_count:
              structuredListingCount ?? walmartRequest?.listing_count ?? 2,
            pack_count:
              structuredPackCount ?? walmartRequest?.pack_count ?? 2,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.message ?? data?.code ?? "Data collection could not start",
        );
      }
      const collection = data.collection as WalmartCollectionState;
      setWalmartCollection(collection);
      persistWalmartCollectionRecovery(collection.batchId);
      if (
        collection.status === "QUEUED_NO_SPEND"
        || collection.status === "RUNNING_NO_SPEND"
        || collection.status === "RUNNING_ENRICHMENT"
      ) {
        collectionPollTimer.current = setTimeout(
          () => void pollWalmartCollection(collection.batchId),
          2_000,
        );
      }
    } catch (e) {
      setWalmartCollectionError(
        e instanceof Error ? e.message : "Data collection could not start",
      );
    } finally {
      setWalmartCollectionLoading(false);
    }
  }

  async function onGenerate() {
    if (!canGenerate) return;
    setSubmitting(true);
    setError(null);
    try {
      if (channel === "WALMART") {
        const readiness = await checkWalmartReadiness();
        if (!readiness) {
          setError(
            "Generation did not start because product readiness could not be verified.",
          );
          setSubmitting(false);
          return;
        }
        if (
          !readiness.catalog.enough_ready ||
          readiness.diagnosis.capability_gaps.length > 0
        ) {
          if (
            readiness.diagnosis.capability_gaps.length === 0 &&
            readiness.fallback.engine === "TARGETED_WALMART_EVIDENCE" &&
            readiness.fallback.target_donor_product_ids.length > 0
          ) {
            await startWalmartDataCollection();
            setSubmitting(false);
            return;
          }
          setError(
            "Generation did not start. Review Product data readiness and the recommended next step below.",
          );
          setSubmitting(false);
          return;
        }
      }
      await submitStudioGeneration();
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
            onChange={(e) => {
              setPrompt(e.target.value);
              setWalmartReadiness(null);
              clearWalmartCollection();
            }}
            rows={3}
            placeholder="e.g. 50 Uncrustables gift sets in different variations"
            className="mt-2 w-full resize-y rounded-[12px] border border-rule bg-surface px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-4 focus:border-silver-line"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setPrompt(ex);
                  setWalmartReadiness(null);
                  clearWalmartCollection();
                }}
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
        {channel !== "WALMART" && (
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
                  const blocked = !f.buildable;
                  const notes: string[] = [];
                  if (f.missing.unit_cost > 0) notes.push("no unit cost");
                  if (f.missing.ingredients >= f.donors && f.missing.ingredients > 0) notes.push("no ingredients");
                  if (f.missing.upc >= f.donors && f.missing.upc > 0) notes.push("no UPC");
                  if (f.missing.first_party_offer >= f.donors && f.missing.first_party_offer > 0) notes.push("no 1P offer");
                  if (f.art_approved === false) notes.push("image art not approved yet");
                  return (
                    <label
                      key={f.key}
                      className={cn(
                        "flex items-start gap-2 rounded-[10px] border px-2.5 py-2 text-[12.5px]",
                        blocked ? "cursor-not-allowed opacity-70" : "cursor-pointer",
                        selectedFlavors.has(f.key)
                          ? "border-silver-line bg-bg-elev"
                          : "border-rule bg-surface hover:bg-bg-elev/60",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selectedFlavors.has(f.key)}
                        onChange={() => toggleFlavor(f.key)}
                        disabled={blocked}
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

              {channel !== "WALMART" && (
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
              )}
            </>
          )}
          </div>
        )}

        {/* SELL ON — where it publishes. */}
        <div>
          <label className="text-[13px] font-semibold text-ink">Sell on</label>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            Which of your channels these listings publish to.
          </p>
          <select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              setWalmartReadiness(null);
              clearWalmartCollection();
            }}
            className="mt-2 w-full rounded-[10px] border border-rule bg-surface px-3 py-2.5 text-[13.5px] text-ink outline-none focus:border-silver-line"
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value} disabled={c.disabled}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        {channel === "WALMART" && (
          <>
            <div className="rounded-[12px] border border-rule bg-surface px-3.5 py-3.5">
              <div className="text-[13px] font-semibold text-ink">
                Walmart request scope
              </div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
                Your complete request is preserved. The Walmart branch plans
                each listing as a separate protected work item, gathers any
                missing Product Truth data, and never silently changes the
                requested quantities.
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-[12.5px] font-medium text-ink-2">
                  Listings to create
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={listingCount}
                    onChange={(e) => {
                      setListingCount(e.target.value);
                      setWalmartReadiness(null);
                      clearWalmartCollection();
                    }}
                    placeholder={
                      walmartRequest?.prompt_listing_count != null
                        ? String(walmartRequest.prompt_listing_count)
                        : "2"
                    }
                    className="mt-1.5 block w-full rounded-[10px] border border-rule bg-surface px-2.5 py-2 text-[13px] text-ink outline-none focus:border-silver-line"
                  />
                </label>
                <label className="text-[12.5px] font-medium text-ink-2">
                  Units in each listing
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={packCount}
                    onChange={(e) => {
                      setPackCount(e.target.value);
                      setWalmartReadiness(null);
                      clearWalmartCollection();
                    }}
                    placeholder={
                      walmartRequest?.prompt_pack_count != null
                        ? String(walmartRequest.prompt_pack_count)
                        : "2"
                    }
                    className="mt-1.5 block w-full rounded-[10px] border border-rule bg-surface px-2.5 py-2 text-[13px] text-ink outline-none focus:border-silver-line"
                  />
                </label>
              </div>

              {walmartRequest && walmartRequest.blockers.length > 0 ? (
                <div className="mt-3 space-y-1.5 rounded-[10px] border border-danger/20 bg-danger-tint px-3 py-2.5 text-[12px] leading-relaxed text-danger">
                  {walmartRequest.blockers.map((blocker) => (
                    <p key={blocker.code}>{blocker.message}</p>
                  ))}
                  <p className="font-semibold">
                    No request will be started or changed to different numbers.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-[12px] text-ink-3">
                  Request that will be recorded:{" "}
                  <span className="font-medium text-ink">
                    {walmartRequest?.listing_count ?? 2} listing
                    {(walmartRequest?.listing_count ?? 2) === 1 ? "" : "s"} ·
                    pack of {walmartRequest?.pack_count ?? 2}
                  </span>
                  . The engine will process{" "}
                  {walmartRequest?.listing_count ?? 2} protected work item
                  {(walmartRequest?.listing_count ?? 2) === 1 ? "" : "s"}.
                </p>
              )}
            </div>

            <div className="rounded-[12px] border border-rule bg-surface px-3.5 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-ink">
                    Product data readiness
                  </div>
                  <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
                    Checks the shared Product Truth donor catalog. This is
                    read-only: it does not call donor sites or spend provider
                    credits.
                  </p>
                </div>
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={checkWalmartReadiness}
                  disabled={walmartReadinessLoading}
                >
                  {walmartReadinessLoading
                    ? "Checking…"
                    : walmartReadiness
                      ? "Check again"
                      : "Check products"}
                </Btn>
              </div>

              {walmartReadinessError && (
                <p className="mt-3 text-[12px] text-danger">
                  {walmartReadinessError}
                </p>
              )}

              {walmartReadiness && (
                <div className="mt-3 space-y-3">
                  <div
                    className={cn(
                      "rounded-[10px] border px-3 py-2.5 text-[12px] leading-relaxed",
                      walmartReadiness.catalog.enough_ready
                        ? "border-green/20 bg-green/5 text-ink-2"
                        : "border-danger/20 bg-danger-tint text-danger",
                    )}
                  >
                    {walmartReadiness.catalog.enough_ready
                      ? `${walmartReadiness.catalog.ready_variants} exact variants are ready for the requested ${walmartRequest?.listing_count ?? 2} listings.`
                      : `${walmartReadiness.catalog.ready_variants} of ${walmartRequest?.listing_count ?? 2} requested variants are ready now.`}
                  </div>

                  {walmartReadiness.diagnosis.capability_gaps.length > 0 && (
                    <div className="rounded-[10px] border border-rule bg-bg-elev px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
                      <p className="font-semibold">Engine capability limit</p>
                      {walmartReadiness.diagnosis.capability_gaps.map((gap) => (
                        <p key={gap.code} className="mt-1 text-ink-3">
                          {gap.message}
                        </p>
                      ))}
                      <p className="mt-1 font-medium">
                        Collecting more product data cannot fix this. A new
                        tested Walmart engine release is required.
                      </p>
                    </div>
                  )}

                  {walmartReadiness.catalog.candidates.length > 0 ? (
                    <div className="space-y-1.5">
                      {walmartReadiness.catalog.candidates
                        .slice(0, 12)
                        .map((candidate) => (
                          <div
                            key={candidate.canonical_variant_id}
                            className="rounded-[10px] border border-rule bg-surface-tint/40 px-3 py-2"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-[12.5px] font-medium text-ink">
                                {candidate.title}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0 text-[11px] font-semibold",
                                  candidate.ready ? "text-green" : "text-danger",
                                )}
                              >
                                {candidate.ready ? "READY" : "DATA MISSING"}
                              </span>
                            </div>
                            {!candidate.ready && (
                              <p className="mt-1 text-[11.5px] leading-snug text-ink-3">
                                Missing:{" "}
                                {candidate.missing
                                  .map(
                                    (gap) =>
                                      WALMART_GAP_LABELS[gap] ?? gap,
                                  )
                                  .join(", ") || "verified Product Truth evidence"}
                                {candidate.data_collection?.supported
                                  ? " · targeted collection is supported"
                                  : " · broader Product Truth discovery is required"}
                              </p>
                            )}
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="rounded-[10px] border border-rule bg-bg-elev px-3 py-2.5 text-[12px] leading-relaxed text-ink-3">
                      No exact Product Truth variant matched this request.
                    </p>
                  )}

                  {walmartReadiness.fallback.required && (
                    <div className="rounded-[10px] border border-silver-line bg-bg-elev px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
                      <p className="font-semibold">Recommended next step</p>
                      <p className="mt-1">
                        {walmartReadiness.fallback.recommendation}
                      </p>
                      {walmartReadiness.fallback.engine
                        === "TARGETED_WALMART_EVIDENCE"
                        && walmartReadiness.fallback
                          .target_donor_product_ids.length > 0
                        && !walmartCollection && (
                          <div className="mt-3">
                            {walmartCollectionLoading ? (
                              <p className="font-medium text-ink-2">
                                Preparing the exact no-spend collection plan…
                              </p>
                            ) : walmartCollectionError ? (
                              <Btn
                                size="sm"
                                variant="primary"
                                onClick={startWalmartDataCollection}
                              >
                                Retry plan preparation
                              </Btn>
                            ) : (
                              <p className="text-ink-3">
                                Prepare Walmart request will build this plan
                                automatically at no cost, then show the exact
                                quote for your approval.
                              </p>
                            )}
                            <p className="mt-1.5 text-[11px] text-ink-3">
                              Nothing is published and no Walmart setting is
                              changed.
                            </p>
                          </div>
                        )}
                      {walmartReadiness.fallback.engine
                        === "PRODUCT_TRUTH_DEMAND_DISCOVERY" && (
                          <div className="mt-3 rounded-[8px] border border-silver-line bg-surface px-2.5 py-2 text-[11px] leading-relaxed text-ink-2">
                            No exact donor variant exists yet. This is a new
                            Product Truth catalog-expansion campaign, not a
                            missing-field enrichment of an existing exact
                            product. The current exact-product quote cannot be
                            reused for it, and no provider action has been
                            authorized.
                          </div>
                        )}

                      {!walmartReadiness.fallback.automatic_web_execution && (
                        <p className="mt-2 text-ink-3">
                          The collection worker is currently off. The button
                          will show the exact activation blocker without
                          pretending that a run started.
                        </p>
                      )}

                      {walmartCollectionError && (
                        <p className="mt-2 rounded-[8px] border border-danger/20 bg-danger-tint px-2.5 py-2 text-danger">
                          {walmartCollectionError}
                        </p>
                      )}

                      {walmartCollection && (
                        <div className="mt-3 space-y-2 rounded-[8px] border border-rule bg-surface px-2.5 py-2.5">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-semibold">Collection progress</p>
                            <span className="text-[10.5px] font-semibold text-ink-3">
                              {walmartCollection.status === "QUEUED_NO_SPEND"
                                ? "QUEUED"
                                : walmartCollection.status === "RUNNING_NO_SPEND"
                                  ? "PREPARING"
                                  : walmartCollection.status === "AWAITING_OWNER"
                                    ? "PLAN READY"
                                    : walmartCollection.status === "RUNNING_ENRICHMENT"
                                      ? "ENRICHING"
                                      : walmartCollection.status === "DECLINED"
                                        ? "DECLINED"
                                    : walmartCollection.status}
                            </span>
                          </div>
                          {walmartCollection.jobs.map((job) => (
                            <div
                              key={job.run_id}
                              className="flex items-start justify-between gap-3 border-t border-rule pt-2 first:border-t-0 first:pt-0"
                            >
                              <span className="min-w-0 text-[11.5px] text-ink-2">
                                {job.title}
                              </span>
                              <span className="shrink-0 text-[10.5px] font-medium text-ink-3">
                                {job.phase === "QUEUED_NO_SPEND"
                                  ? "queued"
                                  : job.phase === "RUNNING_NO_SPEND"
                                    ? "preparing"
                                    : job.phase === "AWAITING_OWNER"
                                      ? "plan ready"
                                      : job.phase.toLowerCase()}
                              </span>
                            </div>
                          ))}
                          {walmartCollection.status === "AWAITING_OWNER" && (
                            <div className="space-y-2 border-t border-rule pt-2">
                              <p className="text-[11px] text-ink-3">
                                Free preparation is complete. Review the exact
                                products and maximum provider-credit cost below.
                                Nothing has been spent yet.
                              </p>
                              {walmartCollection.quote && (
                                <div className="rounded-[8px] border border-silver-line bg-bg-elev px-2.5 py-2.5">
                                  <div className="flex items-start justify-between gap-3">
                                    <div>
                                      <p className="text-[11.5px] font-semibold text-ink">
                                        Enrichment quote
                                      </p>
                                      <p className="mt-0.5 text-[10.5px] text-ink-3">
                                        One balance check:{" "}
                                        {walmartCollection.quote.balance_probe_maximum_units.toFixed(1)} credits
                                        {" · "}
                                        {walmartCollection.quote.actions.length} exact product
                                        {walmartCollection.quote.actions.length === 1 ? "" : "s"}:{" "}
                                        {walmartCollection.quote.job_maximum_units.toFixed(1)} credits each
                                      </p>
                                      <p className="mt-0.5 text-[9.5px] text-ink-4">
                                        Exact quote valid until{" "}
                                        {walmartCollection.quote.expires_at}
                                      </p>
                                    </div>
                                    <div className="text-right">
                                      <p className="text-[15px] font-semibold text-ink">
                                        ≤ {walmartCollection.quote.maximum_provider_units.toFixed(1)}
                                      </p>
                                      <p className="text-[9.5px] uppercase tracking-wide text-ink-4">
                                        provider credits
                                      </p>
                                    </div>
                                  </div>
                                  <div className="mt-2 space-y-1 border-t border-rule pt-2">
                                    {walmartCollection.quote.actions.map((action) => (
                                      <div
                                        key={action.run_id}
                                        className="flex items-start justify-between gap-3 text-[10.5px]"
                                      >
                                        <span className="min-w-0 text-ink-2">
                                          <span>
                                            {action.ordinal}. {action.title}
                                          </span>
                                          <span className="mt-0.5 block text-[9.5px] leading-relaxed text-ink-4">
                                            Fill:{" "}
                                            {action.missing_fields
                                              .map(
                                                (gap) =>
                                                  WALMART_GAP_LABELS[gap] ?? gap,
                                              )
                                              .join(", ")}
                                            {" · "}Walmart exact search ≤{" "}
                                            {action.oxylabs_query_maximum_units.toFixed(1)}
                                            {" · "}exact product detail ≤{" "}
                                            {action.unwrangle_detail_maximum_units.toFixed(1)}
                                          </span>
                                        </span>
                                        <span className="shrink-0 font-medium text-ink-3">
                                          ≤ {action.maximum_provider_units.toFixed(1)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                  <p className="mt-2 text-[10px] leading-relaxed text-ink-3">
                                    Cost is shown in prepaid provider credits;
                                    no unsupported dollar conversion is used.
                                    Approval enriches Product Truth only. It
                                    does not publish, edit, or price a Walmart
                                    listing.
                                  </p>
                                  <div className="mt-2.5 flex flex-wrap gap-2">
                                    <Btn
                                      size="sm"
                                      variant="primary"
                                      onClick={approveWalmartEnrichment}
                                      disabled={walmartApprovalLoading !== null}
                                      loading={walmartApprovalLoading === "APPROVE"}
                                    >
                                      Approve exact quote
                                    </Btn>
                                    <Btn
                                      size="sm"
                                      variant="ghost"
                                      onClick={declineWalmartEnrichment}
                                      disabled={walmartApprovalLoading !== null}
                                    >
                                      {walmartApprovalLoading === "DECLINE"
                                        ? "Declining…"
                                        : "Decline"}
                                    </Btn>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {walmartCollection.status === "RUNNING_ENRICHMENT" && (
                            <p className="border-t border-rule pt-2 text-[11px] text-ink-3">
                              Exact quote approved. Products are being enriched
                              one at a time. The worker stops on stale balance,
                              ambiguous evidence, or any possible replay.
                            </p>
                          )}
                          {walmartCollection.status === "DECLINED" && (
                            <p className="border-t border-rule pt-2 text-[11px] text-ink-3">
                              Quote declined. No provider call or catalog
                              mutation was authorized.
                            </p>
                          )}
                          {walmartCollection.status === "AMBIGUOUS" && (
                            <p className="rounded-[8px] border border-danger/20 bg-danger-tint px-2.5 py-2 text-[11px] leading-relaxed text-danger">
                              A provider outcome is uncertain. Automatic retry
                              is permanently disabled for this command. Product
                              Truth requires ledger/provider reconciliation
                              before another paid action.
                            </p>
                          )}
                          {walmartCollection.status === "FAILED" && (
                            <p className="rounded-[8px] border border-danger/20 bg-danger-tint px-2.5 py-2 text-[11px] leading-relaxed text-danger">
                              Enrichment stopped safely
                              {walmartCollection.approval?.error_code
                                ? `: ${walmartCollection.approval.error_code}`
                                : "."}{" "}
                              No automatic retry will be attempted. Check the
                              products again before preparing another quote.
                            </p>
                          )}
                          {walmartCollection.status === "SUCCEEDED" && (
                            <p className="rounded-[8px] border border-green/20 bg-green/5 px-2.5 py-2 text-[11px] leading-relaxed text-ink-2">
                              Product Truth enrichment completed. Bundle
                              Factory is rechecking readiness and continuing
                              the original Generate request.
                            </p>
                          )}
                          {walmartCollection.approval && (
                            <div className="border-t border-rule pt-2 text-[10px] leading-relaxed text-ink-4">
                              Audit: {walmartCollection.approval.status}
                              {walmartCollection.approval.outcome
                                ? ` · ${walmartCollection.approval.outcome}`
                                : ""}
                              {walmartCollection.approval.authorized_at
                                ? ` · approved ${walmartCollection.approval.authorized_at}`
                                : ""}
                              {walmartCollection.approval.execution_started_at
                                ? ` · execution started ${walmartCollection.approval.execution_started_at}`
                                : ""}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <WalmartShippingTemplateSelector
              value={walmartShipping}
              onChange={setWalmartShipping}
            />
          </>
        )}

        {/* ADVANCED — channel-specific controls only. Walmart preserves the
            donor/manufacturer brand and exact catalog imagery, so Amazon
            house-brand and Uncrustables controls must never enter that path. */}
        <div className="rounded-[12px] border border-rule bg-surface-tint/40">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3.5 py-3 text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            {showAdvanced ? <ChevronDown size={15} strokeWidth={1.9} /> : <ChevronRight size={15} strokeWidth={1.9} />}
            Advanced
            <span className="ml-1 text-[11.5px] font-normal text-ink-4">
              {channel === "WALMART"
                ? "margin"
                : "brand · photos · margin"}
            </span>
          </button>

          {showAdvanced && (
            <div className="space-y-5 border-t border-rule px-3.5 py-4">
              {channel !== "WALMART" && (
                <>
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

                  <div className="rounded-[10px] border border-rule bg-bg-elev px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-3">
                    Text engine: {CLAUDE_MODEL_LABELS[CLAUDE.premium]}.
                    Model versions are managed centrally and compatibility
                    checked before deployment, not selected per listing.
                  </div>

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
                    hint="Only affects Uncrustables own-brand sets outside the Walmart new-SKU branch."
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
                </>
              )}

              {channel === "WALMART" && (
                <div className="rounded-[10px] border border-rule bg-bg-elev px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-3">
                  Walmart preserves the exact manufacturer brand and verified
                  donor product imagery. No house brand, Uncrustables style, or
                  generative product redraw is applied.
                </div>
              )}

              <Row label="Target margin" hint="Floor each listing must clear vs cost. Blank = 30% for Walmart or the global channel default. Price still comes from the economics module.">
                <div className="flex items-center gap-2">
                  <input
                    value={targetMargin}
                    onChange={(e) => setTargetMargin(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder={channel === "WALMART" ? "30" : "default"}
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
            {channel === "WALMART"
              ? "Prepare Walmart request"
              : "Generate listings"}
          </Btn>
          <span className="text-[12px] text-ink-3">
            {channel === "WALMART" && !walmartShippingReady
              ? "Select an active Walmart shipping template first."
              : channel === "WALMART" && !walmartFieldsValid
                ? "Correct the Walmart scope shown above."
                : channel === "WALMART"
                  ? "Product readiness is checked first. Nothing publishes until approval."
                  : "Nothing publishes until you approve the batch."}
          </span>
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
