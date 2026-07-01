"use client";

/**
 * Client island for the draft detail page (Stage 4 content view).
 *
 * Owns:
 *   - "Generate content" button → POST /drafts/[id]/generate-content
 *   - Per-channel content cards (title, bullets, description, compliance status)
 *   - "Regenerate" button on BLOCKED cards → POST /drafts/[id]/regenerate-content
 *   - Polls /api/bundle-factory/drafts/[id] for fresh state after generation
 */

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/kit";

interface GeneratedContentRow {
  id: string;
  channel: string;
  template: string;
  title: string;
  bullets_json: string;
  description: string;
  compliance_status: string;
  compliance_attempts: number;
  manual_review_required: boolean;
  failed_rule_ids: string | null;
  generation_cost_cents: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  // Phase 2.3 Stage 5
  main_image_url: string | null;
  image_generation_cost_cents: number;
  image_retry_count: number;
  // Phase 2.4 Stage 6 — joined from ChannelSKU when promotion has happened.
  channel_sku_id: string | null;
  sku_code: string | null;
  /** Amazon browse node ChannelSKU will publish under. Auto-set by
   *  promote-draft based on the bundle's distinct-brand count: Gift
   *  Basket Exception node for multi-brand. Null on non-Amazon channels
   *  and on rows that haven't been promoted to ChannelSKU yet. */
  channel_browse_node: string | null;
  validation_status: string; // PENDING | PASSED | NEEDS_REVIEW | FAILED
  validation_errors_json: string | null;
  validation_attempt_count: number;
  // Full attribute set + ship specs — surfaced in the preview.
  attributes_json: string | null;
  upc: string | null;
  country_of_origin: string | null;
  package_weight_oz: number | null;
  package_length_in: number | null;
  package_width_in: number | null;
  package_height_in: number | null;
  // Phase 2.5 Stage 7 — distribution state.
  listing_status: string; // PENDING | SUBMITTED | LIVE | FAILED | PENDING_REVIEW
  submission_id: string | null;
  distribution_errors_json: string | null;
  distribution_attempt_count: number;
  asin: string | null;
  live_url: string | null;
}

interface ValidationErrorEntry {
  validator_id: string;
  severity: "error" | "warning";
  message: string;
  details?: unknown;
}

interface DistributionErrorEntry {
  code?: string;
  message?: string;
  severity?: string;
}

interface Props {
  draftId: string;
  canGenerate: boolean;
  targetChannels: string[];
  initialContent: GeneratedContentRow[];
  /** BundleDraft.status — used to gate the Generate All Images header
   *  button (only shown when status==='GENERATED' or beyond). */
  draftStatus: string;
  /** Auto retail price (cents) the listing will publish at — shown in the
   *  marketplace preview. */
  previewPriceCents: number;
  /** Full cost-buildup pricing state for the calculator modal. */
  pricing: PricingProp;
  /** Donor-catalog photos (main + secondary), shown as the preview gallery
   *  alongside the generated title image. */
  donorPhotos: string[];
  /** Donor-derived attribute preview (shown before a ChannelSKU exists). */
  previewAttributes: Array<{ label: string; value: string }>;
  /** House brand, shown in the preview "Brand:" line. */
  brand: string;
}

// ── Pricing calculator types (mirror pricing-config.ts) ─────────────────────
interface PricingModelShape {
  mode: "margin" | "markup";
  markup: number;
  target_margin_pct: number;
  min_price_cents: number;
  fba_fee_cents: number;
  closing_fee_cents: number;
  own_shipping_cents: number;
  referral_pct_override: number | null;
}
interface BundlePriceResultShape {
  selling_price_cents: number;
  mode: "margin" | "markup";
  cooler_size: string | null;
  packaging_estimated: boolean;
  cost: {
    goods_cents: number;
    cooler_cents: number;
    ice_cents: number;
    box_cents: number;
    packaging_cents: number;
    fba_cents: number;
    closing_cents: number;
    own_shipping_cents: number;
    total_cost_cents: number;
  };
  referral_pct: number;
  referral_fee_cents: number;
  profit_cents: number;
  margin_pct: number;
}
interface PricingProp {
  input: { cogs_cents: number; weight_lb: number | null; category: string | null };
  model: PricingModelShape;
  result: BundlePriceResultShape;
}

export function DraftDetailClient(props: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<GeneratedContentRow[]>(props.initialContent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<{
    total_cost_cents: number;
    duration_ms: number;
    outcomes: Array<{ channel: string; compliance_status: string; attempts: number }>;
  } | null>(null);

  async function generate(channels?: string[]) {
    if (!props.canGenerate) {
      setError("Select a variant on the brief page first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/drafts/${props.draftId}/generate-content`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(channels ? { channels } : {}),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLastSummary({
        total_cost_cents: data.total_cost_cents,
        duration_ms: data.duration_ms,
        outcomes: data.outcomes,
      });
      // Refetch the canonical rows.
      const fresh = await fetch(`/api/bundle-factory/drafts/${props.draftId}`);
      const freshData = await fresh.json();
      setRows(freshData.draft.generated_content);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateBlocked() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/drafts/${props.draftId}/regenerate-content`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLastSummary({
        total_cost_cents: data.total_cost_cents,
        duration_ms: data.duration_ms,
        outcomes: data.outcomes,
      });
      const fresh = await fetch(`/api/bundle-factory/drafts/${props.draftId}`);
      const freshData = await fresh.json();
      setRows(freshData.draft.generated_content);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function generateImages(channels?: string[]) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/drafts/${props.draftId}/generate-images`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(channels ? { channels } : {}),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLastSummary({
        total_cost_cents: data.total_cost_cents,
        duration_ms: data.duration_ms,
        outcomes: data.outcomes,
      });
      const fresh = await fetch(`/api/bundle-factory/drafts/${props.draftId}`);
      const freshData = await fresh.json();
      setRows(freshData.draft.generated_content);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateImage(channel: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/drafts/${props.draftId}/regenerate-image`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel }),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLastSummary({
        total_cost_cents: data.total_cost_cents,
        duration_ms: data.duration_ms,
        outcomes: data.outcomes,
      });
      const fresh = await fetch(`/api/bundle-factory/drafts/${props.draftId}`);
      const freshData = await fresh.json();
      setRows(freshData.draft.generated_content);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function validateDraft() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/drafts/${props.draftId}/validate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      // The validation response is a different shape from the
      // content/image summary; we reuse the same "Last run" pill by
      // mapping it onto our local summary shape.
      const v = data.validation;
      setLastSummary({
        total_cost_cents: 0,
        duration_ms: v?.duration_ms ?? 0,
        outcomes: (v?.per_sku ?? []).map(
          (s: { channel: string; status: string; failed?: string[] }) => ({
            channel: s.channel,
            compliance_status: s.status,
            attempts: 1,
          }),
        ),
      });
      const fresh = await fetch(`/api/bundle-factory/drafts/${props.draftId}`);
      const freshData = await fresh.json();
      // GET /drafts/[id] returns generated_content only; merge ChannelSKU
      // state from the validation-status endpoint to keep validation
      // badges fresh.
      const statusRes = await fetch(
        `/api/bundle-factory/drafts/${props.draftId}/validation-status`,
      );
      const statusData = await statusRes.json();
      const byChannel: Record<
        string,
        {
          sku_id: string;
          sku: string;
          validation_status: string;
          validation_errors: string | null;
          validation_attempt_count: number;
        }
      > = {};
      for (const cs of statusData?.per_sku ?? []) {
        byChannel[cs.channel] = cs;
      }
      const merged = (freshData.draft.generated_content as GeneratedContentRow[])
        .map((g) => {
          const cs = byChannel[g.channel];
          return {
            ...g,
            channel_sku_id: cs?.sku_id ?? g.channel_sku_id,
            sku_code: cs?.sku ?? g.sku_code,
            validation_status: cs?.validation_status ?? g.validation_status,
            validation_errors_json: cs?.validation_errors ?? g.validation_errors_json,
            validation_attempt_count:
              cs?.validation_attempt_count ?? g.validation_attempt_count,
          };
        });
      setRows(merged);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function validateSku(skuId: string, channel: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/skus/${skuId}/validate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setRows((prev) =>
        prev.map((r2) =>
          r2.channel === channel
            ? {
                ...r2,
                validation_status: data.validation_status,
                validation_errors_json:
                  (data.results as ValidationErrorEntry[] | undefined)
                    ?.filter((res) => !res.message || res.severity)
                    .filter((res) => res.severity)
                    .length
                    ? JSON.stringify(
                        (data.results as ValidationErrorEntry[])
                          .filter((res) => res.severity)
                          .map((res) => ({
                            validator_id: res.validator_id,
                            severity: res.severity,
                            message: res.message ?? "",
                          })),
                      )
                    : null,
                validation_attempt_count: r2.validation_attempt_count + 1,
              }
            : r2,
        ),
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishConfirmChecked, setPublishConfirmChecked] = useState(false);

  // Manual ship-specs (Phase-2 scaffold — weight + L×W×H). Retail price is
  // auto, so it's not entered here.
  const [weightOz, setWeightOz] = useState("");
  const [lengthIn, setLengthIn] = useState("");
  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("");

  async function saveShipSpecs() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/drafts/${props.draftId}/ship-specs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            weight_oz: Number(weightOz),
            length_in: Number(lengthIn),
            width_in: Number(widthIn),
            height_in: Number(heightIn),
          }),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      // Re-validate immediately so the weight/dims validators flip to PASSED
      // and the Publish button can appear.
      await validateDraft();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSkusFromServer() {
    const fresh = await fetch(`/api/bundle-factory/drafts/${props.draftId}`);
    const freshData = await fresh.json();
    const statusRes = await fetch(
      `/api/bundle-factory/drafts/${props.draftId}/validation-status`,
    );
    const statusData = await statusRes.json();
    const distRes = await fetch(
      `/api/bundle-factory/drafts/${props.draftId}/distribution-status`,
    );
    const distData = await distRes.json();
    const valByChannel: Record<string, {
      sku_id: string;
      sku: string;
      validation_status: string;
      validation_errors: string | null;
      validation_attempt_count: number;
    }> = {};
    for (const cs of statusData?.per_sku ?? []) valByChannel[cs.channel] = cs;
    const distByChannel: Record<string, {
      id: string;
      sku: string;
      listing_status: string;
      submission_id: string | null;
      distribution_errors: string | null;
      distribution_attempt_count: number;
      asin: string | null;
      live_url: string | null;
    }> = {};
    for (const cs of distData?.per_sku ?? []) distByChannel[cs.channel] = cs;
    const merged = (freshData.draft.generated_content as GeneratedContentRow[])
      .map((g) => {
        const cs = valByChannel[g.channel];
        const ds = distByChannel[g.channel];
        return {
          ...g,
          channel_sku_id: cs?.sku_id ?? g.channel_sku_id,
          sku_code: cs?.sku ?? g.sku_code,
          validation_status: cs?.validation_status ?? g.validation_status,
          validation_errors_json: cs?.validation_errors ?? g.validation_errors_json,
          validation_attempt_count:
            cs?.validation_attempt_count ?? g.validation_attempt_count,
          listing_status: ds?.listing_status ?? g.listing_status,
          submission_id: ds?.submission_id ?? g.submission_id,
          distribution_errors_json:
            ds?.distribution_errors ?? g.distribution_errors_json,
          distribution_attempt_count:
            ds?.distribution_attempt_count ?? g.distribution_attempt_count,
          asin: ds?.asin ?? g.asin,
          live_url: ds?.live_url ?? g.live_url,
        };
      });
    setRows(merged);
  }

  async function publishDraft(apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/drafts/${props.draftId}/publish?dryRun=${apply ? "false" : "true"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLastSummary({
        total_cost_cents: 0,
        duration_ms: data.duration_ms ?? 0,
        outcomes: (data.per_sku ?? []).map(
          (s: { channel: string; status: string }) => ({
            channel: s.channel,
            compliance_status: s.status,
            attempts: 1,
          }),
        ),
      });
      await refreshSkusFromServer();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPublishModalOpen(false);
      setPublishConfirmChecked(false);
    }
  }

  async function republishSku(skuId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/skus/${skuId}/publish?dryRun=false`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      await refreshSkusFromServer();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pollSku(skuId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/bundle-factory/skus/${skuId}/poll-status`,
        { method: "POST" },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      await refreshSkusFromServer();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const blockedCount = rows.filter(
    (r) => r.compliance_status === "BLOCKED",
  ).length;
  const imagePendingCount = rows.filter(
    (r) => r.compliance_status === "CAN_PUBLISH" && !r.main_image_url,
  ).length;
  const showGenerateAllImagesBtn =
    imagePendingCount > 0 &&
    (props.draftStatus === "GENERATED" ||
      props.draftStatus === "IMAGE_GENERATING" ||
      props.draftStatus === "IMAGE_GENERATED");
  const validationPendingCount = rows.filter(
    (r) =>
      r.compliance_status === "CAN_PUBLISH" &&
      r.main_image_url &&
      (r.validation_status === "PENDING" || r.validation_status === "FAILED"),
  ).length;
  const showValidateAllBtn =
    validationPendingCount > 0 &&
    (props.draftStatus === "IMAGE_GENERATED" ||
      props.draftStatus === "VALIDATING" ||
      props.draftStatus === "VALIDATED" ||
      props.draftStatus === "ERROR");
  // Publishable = validation PASSED or NEEDS_REVIEW (warnings only). FAILED is
  // still blocked. Warnings don't block publish — the operator confirms in the
  // modal.
  const isPublishable = (status: string) =>
    status === "PASSED" || status === "NEEDS_REVIEW";
  const publishPendingCount = rows.filter(
    (r) =>
      isPublishable(r.validation_status) &&
      (r.listing_status === "PENDING" || r.listing_status === "FAILED"),
  ).length;
  // The ship-specs form is relevant once the draft is promotable/validating —
  // i.e. it has CAN_PUBLISH content with an image. Weight + dims are required
  // for validation to PASS and there's no auto-derivation yet.
  const canEnterShipSpecs = rows.some(
    (r) => r.compliance_status === "CAN_PUBLISH" && !!r.main_image_url,
  );
  const specsValid =
    Number(weightOz) > 0 &&
    Number(lengthIn) > 0 &&
    Number(widthIn) > 0 &&
    Number(heightIn) > 0;
  const showPublishAllBtn =
    publishPendingCount > 0 &&
    (props.draftStatus === "VALIDATED" ||
      props.draftStatus === "PUBLISHING" ||
      props.draftStatus === "PUBLISHED" ||
      props.draftStatus === "ERROR");

  return (
    <section className="space-y-4">
      <div className="rounded-[14px] border border-rule bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-ink">
            Per-channel content ({rows.length}/{props.targetChannels.length})
          </h2>
          <div className="flex items-center gap-2">
            {rows.length === 0 ? (
              <Btn
                variant="primary"
                disabled={!props.canGenerate || busy}
                loading={busy}
                onClick={() => generate()}
              >
                Generate content
              </Btn>
            ) : (
              <>
                <Btn
                  variant="ghost"
                  disabled={busy}
                  loading={busy}
                  onClick={() => generate()}
                >
                  Re-generate all
                </Btn>
                {blockedCount > 0 && (
                  <Btn
                    variant="primary"
                    disabled={busy}
                    loading={busy}
                    onClick={() => regenerateBlocked()}
                  >
                    Re-try {blockedCount} BLOCKED
                  </Btn>
                )}
                {showGenerateAllImagesBtn && (
                  <Btn
                    variant="primary"
                    disabled={busy}
                    loading={busy}
                    onClick={() => generateImages()}
                  >
                    Generate {imagePendingCount} image
                    {imagePendingCount === 1 ? "" : "s"}
                  </Btn>
                )}
                {showValidateAllBtn && (
                  <Btn
                    variant="primary"
                    disabled={busy}
                    loading={busy}
                    onClick={() => validateDraft()}
                  >
                    Validate {validationPendingCount}
                  </Btn>
                )}
                {showPublishAllBtn && (
                  <>
                    <Btn
                      variant="ghost"
                      disabled={busy}
                      loading={busy}
                      onClick={() => publishDraft(false)}
                    >
                      Dry-run {publishPendingCount}
                    </Btn>
                    <Btn
                      variant="primary"
                      disabled={busy}
                      loading={busy}
                      onClick={() => setPublishModalOpen(true)}
                    >
                      Publish {publishPendingCount}
                    </Btn>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {!props.canGenerate && (
          <p className="mt-3 text-[12px] text-warn">
            Select a variant on the brief page first.
          </p>
        )}

        {busy && (
          <p className="mt-3 text-[12px] text-ink-3">
            Claude is generating content. This typically takes 20–60 seconds
            across 2 templates with 3-retry budget per failure. Compliance
            Gate runs automatically after each generation.
          </p>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-danger/30 bg-danger-tint/40 p-3 text-[12.5px] text-danger">
            {error}
          </div>
        )}

        {lastSummary && (
          <div className="mt-3 rounded-md border border-rule bg-bg-elev/40 p-3 text-[12px] text-ink-2">
            <span className="font-medium">Last run:</span> $
            {(lastSummary.total_cost_cents / 100).toFixed(2)} in{" "}
            {(lastSummary.duration_ms / 1000).toFixed(1)}s ·{" "}
            {lastSummary.outcomes
              .map(
                (o) =>
                  `${o.channel}=${o.compliance_status}` +
                  (o.attempts > 1 ? ` (${o.attempts} attempts)` : ""),
              )
              .join(" · ")}
          </div>
        )}
      </div>

      {canEnterShipSpecs && (
        <div className="rounded-[14px] border border-rule bg-surface p-5">
          <h2 className="text-[13px] font-semibold text-ink">
            Ship specs — вес и габариты коробки
          </h2>
          <p className="mt-1 text-[12px] text-ink-3">
            Розничная цена ставится автоматически. Вес и габариты пока вводятся
            вручную — без них валидаторы не пропускают листинг. Значения
            применяются ко всем каналам этого драфта.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SpecInput label="Вес (oz)" value={weightOz} onChange={setWeightOz} />
            <SpecInput label="Длина (in)" value={lengthIn} onChange={setLengthIn} />
            <SpecInput label="Ширина (in)" value={widthIn} onChange={setWidthIn} />
            <SpecInput label="Высота (in)" value={heightIn} onChange={setHeightIn} />
          </div>
          <div className="mt-3 flex justify-end">
            <Btn
              variant="primary"
              disabled={!specsValid || busy}
              loading={busy}
              onClick={saveShipSpecs}
            >
              Сохранить и проверить
            </Btn>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-[14px] border border-rule bg-surface p-6 text-center text-[12.5px] text-ink-3">
          No content generated yet. Click <strong>Generate content</strong>
          {" "}above to call Claude Sonnet 4.5 across all channels.
        </div>
      ) : (
        <>
        <div className="grid grid-cols-1 gap-3">
          {rows.map((r) => (
            <ChannelCard
              key={r.id}
              row={r}
              busy={busy}
              previewPriceCents={props.previewPriceCents}
              pricing={props.pricing}
              donorPhotos={props.donorPhotos}
              previewAttributes={props.previewAttributes}
              brand={props.brand}
              onGenerateImage={() => generateImages([r.channel])}
              onRegenerateImage={() => regenerateImage(r.channel)}
              onValidateSku={
                r.channel_sku_id
                  ? () => validateSku(r.channel_sku_id!, r.channel)
                  : null
              }
              onRepublishSku={
                r.channel_sku_id
                  ? () => republishSku(r.channel_sku_id!)
                  : null
              }
              onPollSku={
                r.channel_sku_id ? () => pollSku(r.channel_sku_id!) : null
              }
            />
          ))}
        </div>

        {publishModalOpen && (
          <PublishConfirmModal
            pendingCount={publishPendingCount}
            channels={rows
              .filter(
                (r) =>
                  isPublishable(r.validation_status) &&
                  (r.listing_status === "PENDING" ||
                    r.listing_status === "FAILED"),
              )
              .map((r) => r.channel)}
            checked={publishConfirmChecked}
            onCheckedChange={setPublishConfirmChecked}
            onCancel={() => {
              setPublishModalOpen(false);
              setPublishConfirmChecked(false);
            }}
            onConfirm={() => publishDraft(true)}
            busy={busy}
          />
        )}
        </>
      )}
    </section>
  );
}

function ChannelCard({
  row,
  busy,
  previewPriceCents,
  pricing,
  donorPhotos,
  previewAttributes,
  brand,
  onGenerateImage,
  onRegenerateImage,
  onValidateSku,
  onRepublishSku,
  onPollSku,
}: {
  row: GeneratedContentRow;
  busy: boolean;
  previewPriceCents: number;
  pricing: PricingProp;
  donorPhotos: string[];
  previewAttributes: Array<{ label: string; value: string }>;
  brand: string;
  onGenerateImage: () => void;
  onRegenerateImage: () => void;
  onValidateSku: (() => void) | null;
  onRepublishSku: (() => void) | null;
  onPollSku: (() => void) | null;
}) {
  const bullets = safeParse<string[]>(row.bullets_json) ?? [];
  const failed = safeParse<string[]>(row.failed_rule_ids) ?? [];
  const validationErrors =
    safeParse<ValidationErrorEntry[]>(row.validation_errors_json) ?? [];
  const distributionErrors =
    safeParse<DistributionErrorEntry[]>(row.distribution_errors_json) ?? [];
  const canStartImage =
    row.compliance_status === "CAN_PUBLISH" && !row.main_image_url;

  return (
    <div className="rounded-[14px] border border-rule bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold text-ink">{row.channel}</div>
          <div className="mt-0.5 text-[10.5px] uppercase tracking-wider text-ink-3">
            template: {row.template}
            {row.sku_code && (
              <>
                {" · "}
                <span className="font-mono normal-case tracking-normal">{row.sku_code}</span>
              </>
            )}
            {row.channel_browse_node && (
              <>
                {" · "}
                <span
                  className="font-mono normal-case tracking-normal"
                  title="Amazon browse node (set automatically by promote-draft)"
                >
                  node {row.channel_browse_node}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <ComplianceBadge
            status={row.compliance_status}
            attempts={row.compliance_attempts}
          />
          <ValidationBadge
            status={row.validation_status}
            attempts={row.validation_attempt_count}
          />
          <ListingBadge
            status={row.listing_status}
            attempts={row.distribution_attempt_count}
            asin={row.asin}
            liveUrl={row.live_url}
            submissionId={row.submission_id}
          />
        </div>
      </div>

      {row.validation_status === "FAILED" && validationErrors.length > 0 && (
        <details className="mt-3 rounded-md border border-danger/30 bg-danger-tint/40 p-2 text-[11px]">
          <summary className="cursor-pointer font-medium text-danger">
            {validationErrors.filter((e) => e.severity === "error").length} validator
            error{validationErrors.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-1 text-ink-2">
            {validationErrors.map((e, i) => (
              <li key={i}>
                <span className="font-mono text-[10.5px] text-ink-3">{e.validator_id}</span>
                {" — "}
                <span className={e.severity === "error" ? "text-danger" : "text-warn"}>
                  {e.message}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {row.validation_status === "NEEDS_REVIEW" && validationErrors.length > 0 && (
        <details className="mt-3 rounded-md border border-warn/30 bg-warn-tint/40 p-2 text-[11px]">
          <summary className="cursor-pointer font-medium text-warn">
            {validationErrors.length} warning{validationErrors.length === 1 ? "" : "s"} — review before publish
          </summary>
          <ul className="mt-2 space-y-1 text-ink-2">
            {validationErrors.map((e, i) => (
              <li key={i}>
                <span className="font-mono text-[10.5px] text-ink-3">{e.validator_id}</span>
                {" — "}
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {row.manual_review_required && failed.length > 0 && (
        <div className="mt-3 rounded-md border border-danger/30 bg-danger-tint/40 p-2 text-[11.5px] text-danger">
          <div className="font-medium">Failed rules:</div>
          <ul className="mt-1 list-disc pl-4">
            {failed.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <MarketplacePreview
        channel={row.channel}
        brand={brand}
        title={row.title}
        bullets={bullets}
        description={row.description}
        imageUrl={row.main_image_url}
        donorPhotos={donorPhotos}
        priceCents={previewPriceCents}
        pricing={pricing}
        attributes={(() => {
          // Prefer the real ChannelSKU attributes once the draft is promoted;
          // fall back to the donor-derived preview at GENERATED stage.
          const fromSku = buildPreviewAttributes(row);
          return fromSku.length > 0 ? fromSku : previewAttributes;
        })()}
      />

      {/* Image action strip — the preview above shows the image; this is the
          control to make or re-roll it. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-rule/40 pt-3">
        <span className="text-[11px] text-ink-3">
          {row.main_image_url
            ? `Картинка: попыток ${row.image_retry_count} · $${(row.image_generation_cost_cents / 100).toFixed(2)}`
            : canStartImage
              ? "Картинки ещё нет — сгенерируй главное изображение (2000×2000) для публикации."
              : "Картинка станет доступна после бренд-проверки текста."}
        </span>
        {row.main_image_url ? (
          <Btn variant="ghost" disabled={busy} loading={busy} onClick={onRegenerateImage}>
            Re-roll картинку
          </Btn>
        ) : canStartImage ? (
          <Btn variant="primary" disabled={busy} loading={busy} onClick={onGenerateImage}>
            Generate image
          </Btn>
        ) : null}
      </div>

      {row.generation_cost_cents > 0 && (
        <div className="mt-3 border-t border-rule/40 pt-2 text-[10.5px] tabular-nums text-ink-3">
          text: ${(row.generation_cost_cents / 100).toFixed(3)} · cache R/W{" "}
          {row.cache_read_tokens}/{row.cache_write_tokens}
        </div>
      )}

      {row.listing_status === "FAILED" && distributionErrors.length > 0 && (
        <details className="mt-3 rounded-md border border-danger/30 bg-danger-tint/40 p-2 text-[11px]">
          <summary className="cursor-pointer font-medium text-danger">
            {distributionErrors.length} marketplace error
            {distributionErrors.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-1 text-ink-2">
            {distributionErrors.map((e, i) => (
              <li key={i}>
                {e.code && (
                  <span className="font-mono text-[10.5px] text-ink-3">{e.code}</span>
                )}
                {e.code ? " — " : ""}
                <span className={e.severity === "WARNING" ? "text-warn" : "text-danger"}>
                  {e.message ?? "(no message)"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {(onValidateSku || onRepublishSku || onPollSku) && row.main_image_url && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {onValidateSku && (
            <Btn variant="ghost" disabled={busy} loading={busy} onClick={onValidateSku}>
              Re-validate
            </Btn>
          )}
          {onPollSku && row.listing_status === "SUBMITTED" && (
            <Btn variant="ghost" disabled={busy} loading={busy} onClick={onPollSku}>
              Poll status
            </Btn>
          )}
          {onRepublishSku &&
            (row.validation_status === "PASSED" ||
              row.validation_status === "NEEDS_REVIEW") &&
            (row.listing_status === "FAILED" || row.listing_status === "PENDING") && (
              <Btn variant="primary" disabled={busy} loading={busy} onClick={onRepublishSku}>
                {row.listing_status === "FAILED" ? "Re-publish" : "Publish"}
              </Btn>
            )}
        </div>
      )}
    </div>
  );
}

function ValidationBadge({
  status,
  attempts,
}: {
  status: string;
  attempts: number;
}) {
  if (status === "PENDING") return null;
  const style =
    status === "PASSED"
      ? "bg-green-soft text-green-ink"
      : status === "FAILED"
        ? "bg-danger-tint text-danger"
        : status === "NEEDS_REVIEW"
          ? "bg-warn-tint text-warn"
          : "bg-bg-elev text-ink-3";
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${style}`}
      >
        validate: {status}
      </span>
      {attempts > 0 && (
        <span className="text-[10px] text-ink-3">
          {attempts} attempt{attempts === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function ComplianceBadge({
  status,
  attempts,
}: {
  status: string;
  attempts: number;
}) {
  const style =
    status === "CAN_PUBLISH"
      ? "bg-green-soft text-green-ink"
      : status === "BLOCKED"
        ? "bg-danger-tint text-danger"
        : "bg-bg-elev text-ink-3";
  return (
    <div className="flex flex-col items-end gap-1">
      <span
        className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ${style}`}
      >
        {status}
      </span>
      {attempts > 0 && (
        <span className="text-[10px] text-ink-3">
          {attempts} attempt{attempts === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function SpecInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </span>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="0.1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-rule bg-bg-elev/40 px-2 py-1.5 text-[12.5px] text-ink tabular-nums outline-none focus:border-green-ink"
      />
    </label>
  );
}

/**
 * Marketplace preview — renders the generated content the way the shopper sees
 * it on the storefront (Amazon-style PDP: photo gallery, title, brand, price,
 * "About this item" bullets, product description, full attribute table). White
 * surface + marketplace colors so it reads as a real listing, not a form.
 *
 * Per Vladimir 2026-06-30 the preview must show EVERYTHING: all photos (the
 * generated title image + donor-catalog photos), the auto price with a click-
 * through to the pricing formula, and every attribute that will publish.
 */
function MarketplacePreview({
  channel,
  brand,
  title,
  bullets,
  description,
  imageUrl,
  donorPhotos,
  priceCents,
  pricing,
  attributes,
}: {
  channel: string;
  brand: string;
  title: string;
  bullets: string[];
  description: string;
  imageUrl: string | null;
  donorPhotos: string[];
  priceCents: number;
  pricing: PricingProp;
  attributes: Array<{ label: string; value: string }>;
}) {
  const market = channel.startsWith("AMAZON_")
    ? "Amazon"
    : channel === "WALMART"
      ? "Walmart"
      : channel;

  // Photo gallery: the generated title image is the hero (first), donor photos
  // follow. Deduped, generated-first. If nothing generated yet, donor photos
  // still preview the product.
  const gallery: string[] = [];
  const seen = new Set<string>();
  for (const u of [imageUrl, ...donorPhotos]) {
    if (typeof u === "string" && u && !seen.has(u)) {
      seen.add(u);
      gallery.push(u);
    }
  }
  const [heroIdx, setHeroIdx] = useState(0);
  const [priceOpen, setPriceOpen] = useState(false);
  const hero = gallery[Math.min(heroIdx, gallery.length - 1)] ?? null;
  const price = (priceCents / 100).toFixed(2);

  return (
    <div className="mt-3 overflow-hidden rounded-[12px] border border-rule bg-white">
      <div className="flex items-center justify-between border-b border-rule bg-[#f7f8f8] px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-[#565959]">
        <span>Предпросмотр · как на {market}</span>
        <span className="font-mono normal-case tracking-normal">{channel}</span>
      </div>
      <div className="grid grid-cols-1 gap-5 p-4 sm:grid-cols-[280px_1fr]">
        <div>
          <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border border-[#e7e7e7] bg-white">
            {hero ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={hero} alt={title} className="h-full w-full object-contain" />
            ) : (
              <span className="px-6 text-center text-[12px] leading-snug text-[#8d9091]">
                Изображение появится после «Generate image»
              </span>
            )}
          </div>
          {gallery.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {gallery.map((u, i) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setHeroIdx(i)}
                  title={
                    i === 0 && u === imageUrl
                      ? "Сгенерированное титульное фото"
                      : "Фото из донорского каталога"
                  }
                  className={`relative h-11 w-11 overflow-hidden rounded border ${
                    i === heroIdx
                      ? "border-[#e77600] ring-1 ring-[#e77600]"
                      : "border-[#e7e7e7]"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" className="h-full w-full object-contain" />
                  {i === 0 && u === imageUrl && (
                    <span className="absolute inset-x-0 bottom-0 bg-[#0F1111]/70 text-center text-[7px] uppercase tracking-wide text-white">
                      title
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {gallery.length > 0 && (
            <div className="mt-1 text-[10.5px] text-[#8d9091]">
              {gallery.length} фото
              {imageUrl ? " · титул сгенерирован" : " · титул ещё не сгенерирован"}
              {donorPhotos.length > 0 && ` · ${donorPhotos.length} из донора`}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="text-[19px] font-medium leading-snug text-[#0F1111]">
            {title}
          </h3>
          <div className="mt-1 text-[12.5px] text-[#007185]">Бренд: {brand}</div>
          <div className="mt-1 text-[12px] text-[#565959]">
            Новый листинг · ещё нет отзывов
          </div>
          <button
            type="button"
            onClick={() => setPriceOpen(true)}
            title="Показать формулу ценообразования"
            className="mt-3 flex w-full items-baseline gap-1 border-t border-[#e7e7e7] pt-3 text-left hover:opacity-80"
          >
            <span className="align-top text-[13px] text-[#0F1111]">$</span>
            <span className="text-[28px] font-medium leading-none text-[#0F1111]">
              {price}
            </span>
            <span className="ml-1 self-center text-[11px] text-[#007185] underline">
              формула цены
            </span>
          </button>
          <div className="mt-4">
            <div className="text-[15px] font-bold text-[#0F1111]">About this item</div>
            <ul className="mt-1.5 list-disc space-y-1.5 pl-5 text-[12.5px] leading-snug text-[#0F1111]">
              {bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <div className="border-t border-[#e7e7e7] px-4 py-3.5">
        <div className="text-[15px] font-bold text-[#0F1111]">Product description</div>
        <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[#0F1111]">
          {description}
        </p>
      </div>
      {attributes.length > 0 && (
        <div className="border-t border-[#e7e7e7] px-4 py-3.5">
          <div className="text-[15px] font-bold text-[#0F1111]">
            Product information · все атрибуты
          </div>
          <table className="mt-2 w-full border-collapse text-[12px]">
            <tbody>
              {attributes.map((a, i) => (
                <tr
                  key={a.label}
                  className={i % 2 === 0 ? "bg-[#f7f8f8]" : "bg-white"}
                >
                  <td className="w-[42%] border border-[#e7e7e7] px-2 py-1 align-top font-medium text-[#565959]">
                    {a.label}
                  </td>
                  <td className="border border-[#e7e7e7] px-2 py-1 align-top text-[#0F1111]">
                    <span className="whitespace-pre-wrap break-words">{a.value}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {priceOpen && (
        <PricingModal pricing={pricing} onClose={() => setPriceOpen(false)} />
      )}
    </div>
  );
}

/**
 * Flatten the ChannelSKU's Amazon-attribute-shaped JSON (+ ship specs, UPC,
 * country, browse node) into a plain [{label, value}] list for the preview
 * table. Amazon attributes are arrays of `{value, ...}` objects (or nested
 * dimensions); we render the human-meaningful part and skip marketplace/
 * language plumbing. This is display-only — the real publish payload is built
 * server-side by buildAmazonAttributes.
 */
function buildPreviewAttributes(
  row: GeneratedContentRow,
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null | undefined) => {
    const v = (value ?? "").toString().trim();
    if (v) out.push({ label, value: v });
  };

  // Ship specs first — the fields the operator actively fills.
  if (row.package_weight_oz != null)
    push("Package weight", `${row.package_weight_oz} oz`);
  if (
    row.package_length_in != null &&
    row.package_width_in != null &&
    row.package_height_in != null
  )
    push(
      "Package dimensions",
      `${row.package_length_in} × ${row.package_width_in} × ${row.package_height_in} in`,
    );
  push("UPC", row.upc);
  push("Country of origin", row.country_of_origin);
  push("Amazon browse node", row.channel_browse_node);

  // Rich attribute set (Phase 2.1 filler): Amazon attribute shape.
  const attrs = safeParse<Record<string, unknown>>(row.attributes_json);
  if (attrs && typeof attrs === "object") {
    for (const [key, raw] of Object.entries(attrs)) {
      const label = humanizeAttrKey(key);
      push(label, flattenAttrValue(raw));
    }
  }
  return out;
}

function humanizeAttrKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Best-effort render of one Amazon attribute value array into a short string. */
function flattenAttrValue(raw: unknown): string {
  const one = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      return String(v);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      // {value, unit} → "12 ounces"; {value} → "12"; dimensions → nested.
      if ("value" in o) {
        const val = one(o.value);
        const unit = "unit" in o ? ` ${one(o.unit)}` : "";
        return `${val}${unit}`.trim();
      }
      if ("length" in o || "width" in o || "height" in o) {
        const parts = ["length", "width", "height"]
          .filter((k) => k in o)
          .map((k) => one(o[k]));
        return parts.join(" × ");
      }
      // Fallback: compact JSON, capped.
      return JSON.stringify(o).slice(0, 120);
    }
    return "";
  };
  if (Array.isArray(raw)) {
    return raw.map(one).filter(Boolean).join(", ").slice(0, 400);
  }
  return one(raw).slice(0, 400);
}

/**
 * Pricing calculator modal — the real cost buildup for a frozen gift set, like
 * the ChannelMax calculator the owner uses. Left column = costs (goods +
 * cooler/ice/box + FBA/closing/our shipping); right column = the marketplace
 * referral fee + the solved selling price, profit and margin. The operator
 * picks the lever (target MARGIN or a cost MARKUP), adjusts the fee estimates,
 * and Saves — it re-prices every listing (one global model, labelled as such).
 * Live numbers come from the server (POST .../pricing/preview) so the modal and
 * the published price stay on one formula (computeBundlePrice).
 */
const dollars = (cents: number) => `$${((cents || 0) / 100).toFixed(2)}`;

function PricingModal({
  pricing,
  onClose,
}: {
  pricing: PricingProp;
  onClose: () => void;
}) {
  const router = useRouter();
  const m = pricing.model;

  const [mode, setMode] = useState<"margin" | "markup">(m.mode);
  const [markup, setMarkup] = useState(String(m.markup));
  const [marginPct, setMarginPct] = useState(String(Math.round(m.target_margin_pct * 100)));
  const [floor, setFloor] = useState((m.min_price_cents / 100).toFixed(2));
  const [fba, setFba] = useState((m.fba_fee_cents / 100).toFixed(2));
  const [closing, setClosing] = useState((m.closing_fee_cents / 100).toFixed(2));
  const [ownShip, setOwnShip] = useState((m.own_shipping_cents / 100).toFixed(2));
  const [referral, setReferral] = useState(
    m.referral_pct_override == null ? "" : String(Math.round(m.referral_pct_override * 100)),
  );

  const [result, setResult] = useState<BundlePriceResultShape>(pricing.result);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The model as edited, in the API's shape.
  const edited = {
    mode,
    markup: Number(markup),
    target_margin_pct: Number(marginPct) / 100,
    min_price_cents: Math.round(Number(floor) * 100),
    fba_fee_cents: Math.round(Number(fba) * 100),
    closing_fee_cents: Math.round(Number(closing) * 100),
    own_shipping_cents: Math.round(Number(ownShip) * 100),
    referral_pct_override: referral.trim() === "" ? null : Number(referral) / 100,
  };

  const dirty =
    edited.mode !== m.mode ||
    edited.markup !== m.markup ||
    Math.abs(edited.target_margin_pct - m.target_margin_pct) > 1e-9 ||
    edited.min_price_cents !== m.min_price_cents ||
    edited.fba_fee_cents !== m.fba_fee_cents ||
    edited.closing_fee_cents !== m.closing_fee_cents ||
    edited.own_shipping_cents !== m.own_shipping_cents ||
    edited.referral_pct_override !== m.referral_pct_override;

  // Debounced live recompute on the server (single source of truth).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/bundle-factory/pricing/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cogs_cents: pricing.input.cogs_cents,
            weight_lb: pricing.input.weight_lb,
            category: pricing.input.category,
            model: edited,
          }),
        });
        const j = await res.json().catch(() => null);
        if (j?.ok && j.result) setResult(j.result as BundlePriceResultShape);
      } catch {
        /* keep last good result */
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, markup, marginPct, floor, fba, closing, ownShip, referral]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        mode: edited.mode,
        markup: edited.markup,
        target_margin_pct: edited.target_margin_pct,
        min_price_cents: edited.min_price_cents,
        fba_fee_cents: edited.fba_fee_cents,
        closing_fee_cents: edited.closing_fee_cents,
        own_shipping_cents: edited.own_shipping_cents,
      };
      if (edited.referral_pct_override != null)
        body.referral_pct = edited.referral_pct_override;
      const res = await fetch("/api/bundle-factory/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      router.refresh();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const c = result.cost;
  const marginColor =
    result.margin_pct >= 0.2 ? "text-green-ink" : result.margin_pct >= 0.1 ? "text-warn" : "text-danger";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-[14px] border border-rule bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[14px] font-semibold text-ink">Калькулятор цены</h3>
        <p className="mt-1 text-[12px] text-ink-3">
          Цена набора считается из полной себестоимости (товар + кулер + лёд +
          коробка) и комиссий маркетплейса так, чтобы удержать целевую маржу.
        </p>

        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* LEFT — cost buildup */}
          <div className="rounded-md border border-rule bg-bg-elev/40 p-3">
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Себестоимость набора
            </div>
            <div className="space-y-1 text-[12.5px]">
              <FormulaRow label="Товар (COGS)" value={dollars(c.goods_cents)} />
              <FormulaRow
                label={`Кулер${result.cooler_size ? ` (${result.cooler_size})` : ""}`}
                value={dollars(c.cooler_cents)}
              />
              <FormulaRow label="Гелевый лёд" value={dollars(c.ice_cents)} />
              <FormulaRow label="Картонная коробка" value={dollars(c.box_cents)} />
            </div>
            <div className="mt-2 border-t border-rule pt-2">
              <MoneyInput label="FBA / фулфилмент" value={fba} onChange={setFba} />
              <MoneyInput label="Closing fee" value={closing} onChange={setClosing} />
              <MoneyInput label="Наша доставка (лейбл)" value={ownShip} onChange={setOwnShip} />
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-rule pt-2 text-[12.5px] font-semibold text-ink">
              <span>Итого себестоимость</span>
              <span className="tabular-nums">{dollars(c.total_cost_cents)}</span>
            </div>
            {result.packaging_estimated && (
              <p className="mt-1 text-[10.5px] text-warn">
                Упаковка оценена (нет веса) — уточни в ship-specs, цена пересчитается.
              </p>
            )}
          </div>

          {/* RIGHT — fees, lever, result */}
          <div className="rounded-md border border-rule bg-bg-elev/40 p-3">
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Комиссии и цена
            </div>

            <div className="mb-2 flex rounded-md border border-rule p-0.5 text-[11.5px]">
              <button
                type="button"
                onClick={() => setMode("margin")}
                className={`flex-1 rounded px-2 py-1 ${mode === "margin" ? "bg-green-ink text-white" : "text-ink-2"}`}
              >
                По марже
              </button>
              <button
                type="button"
                onClick={() => setMode("markup")}
                className={`flex-1 rounded px-2 py-1 ${mode === "markup" ? "bg-green-ink text-white" : "text-ink-2"}`}
              >
                По маркапу
              </button>
            </div>

            {mode === "margin" ? (
              <PctInput label="Целевая маржа" value={marginPct} onChange={setMarginPct} />
            ) : (
              <label className="flex items-center justify-between gap-2 py-0.5 text-[12px] text-ink-2">
                <span>Маркап (× себестоимости)</span>
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={markup}
                  onChange={(e) => setMarkup(e.target.value)}
                  className="w-20 rounded-md border border-rule bg-surface px-2 py-1 text-right text-[12.5px] tabular-nums outline-none focus:border-green-ink"
                />
              </label>
            )}
            <PctInput
              label="Referral (пусто = авто 8/15%)"
              value={referral}
              onChange={setReferral}
              placeholder="авто"
            />
            <MoneyInput label="Пол цены (минимум)" value={floor} onChange={setFloor} />

            <div className="mt-2 space-y-1 border-t border-rule pt-2 text-[12.5px]">
              <FormulaRow
                label={`Referral (${(result.referral_pct * 100).toFixed(1)}%)`}
                value={`− ${dollars(result.referral_fee_cents)}`}
              />
              <div className="flex items-center justify-between pt-1 text-[13px] font-semibold text-ink">
                <span>Цена продажи</span>
                <span className="tabular-nums">{dollars(result.selling_price_cents)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-2">Прибыль</span>
                <span className={`tabular-nums font-medium ${marginColor}`}>
                  {dollars(result.profit_cents)} ({(result.margin_pct * 100).toFixed(0)}%)
                </span>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-warn">
          Изменение применяется ко ВСЕМ листингам фабрики (единая модель цены).
        </p>
        {err && <p className="mt-1 text-[11px] text-danger">{err}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Btn variant="ghost" disabled={saving} onClick={onClose}>
            Закрыть
          </Btn>
          <Btn variant="primary" disabled={!dirty || saving} loading={saving} onClick={save}>
            Сохранить модель
          </Btn>
        </div>
      </div>
    </div>
  );
}

function FormulaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-ink-2">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5 text-[12px] text-ink-2">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <span className="text-ink-3">$</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 rounded-md border border-rule bg-surface px-2 py-1 text-right text-[12.5px] tabular-nums outline-none focus:border-green-ink"
        />
      </span>
    </label>
  );
}

function PctInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5 text-[12px] text-ink-2">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min="0"
          step="1"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-16 rounded-md border border-rule bg-surface px-2 py-1 text-right text-[12.5px] tabular-nums outline-none focus:border-green-ink"
        />
        <span className="text-ink-3">%</span>
      </span>
    </label>
  );
}

function ListingBadge({
  status,
  attempts,
  asin,
  liveUrl,
  submissionId,
}: {
  status: string;
  attempts: number;
  asin: string | null;
  liveUrl: string | null;
  submissionId: string | null;
}) {
  if (status === "PENDING") return null;
  const style =
    status === "LIVE"
      ? "bg-green-soft text-green-ink"
      : status === "FAILED"
        ? "bg-danger-tint text-danger"
        : status === "SUBMITTED"
          ? "bg-bg-elev text-ink-2"
          : status === "PENDING_REVIEW"
            ? "bg-warn-tint text-warn"
            : "bg-bg-elev text-ink-3";
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${style}`}
      >
        listing: {status}
      </span>
      {status === "LIVE" && liveUrl && (
        <a
          href={liveUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-green-ink hover:underline"
        >
          {asin ? `ASIN ${asin}` : "view"} ↗
        </a>
      )}
      {submissionId && status !== "LIVE" && (
        <span className="font-mono text-[9.5px] text-ink-3">{submissionId.slice(0, 14)}</span>
      )}
      {attempts > 1 && (
        <span className="text-[10px] text-ink-3">{attempts} attempts</span>
      )}
    </div>
  );
}

function PublishConfirmModal({
  pendingCount,
  channels,
  checked,
  onCheckedChange,
  onCancel,
  onConfirm,
  busy,
}: {
  pendingCount: number;
  channels: string[];
  checked: boolean;
  onCheckedChange: (b: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-[14px] border border-rule bg-surface p-5 shadow-2xl">
        <h3 className="text-[14px] font-semibold text-ink">
          Publish {pendingCount} live listing{pendingCount === 1 ? "" : "s"}?
        </h3>
        <p className="mt-2 text-[12px] text-ink-2">
          The following channels will receive a real PUT to Amazon / POST to
          Walmart. This is not a dry run — the listings will appear on the
          marketplace as soon as the platform finishes processing.
        </p>
        <ul className="mt-3 list-disc pl-5 text-[12px] text-ink-2">
          {channels.map((c) => (
            <li key={c} className="font-mono">{c}</li>
          ))}
        </ul>
        <label className="mt-4 flex items-start gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheckedChange(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I understand this will create live listings on Amazon / Walmart.
          </span>
        </label>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Btn variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={!checked || busy}
            loading={busy}
            onClick={onConfirm}
          >
            Publish now
          </Btn>
        </div>
      </div>
    </div>
  );
}

function safeParse<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
