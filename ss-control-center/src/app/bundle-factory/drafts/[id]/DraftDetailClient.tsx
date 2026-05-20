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

import { useState } from "react";
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
  validation_status: string; // PENDING | PASSED | NEEDS_REVIEW | FAILED
  validation_errors_json: string | null;
  validation_attempt_count: number;
}

interface ValidationErrorEntry {
  validator_id: string;
  severity: "error" | "warning";
  message: string;
  details?: unknown;
}

interface Props {
  draftId: string;
  canGenerate: boolean;
  targetChannels: string[];
  initialContent: GeneratedContentRow[];
  /** BundleDraft.status — used to gate the Generate All Images header
   *  button (only shown when status==='GENERATED' or beyond). */
  draftStatus: string;
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

      {rows.length === 0 ? (
        <div className="rounded-[14px] border border-rule bg-surface p-6 text-center text-[12.5px] text-ink-3">
          No content generated yet. Click <strong>Generate content</strong>
          {" "}above to call Claude Sonnet 4.5 across all channels.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rows.map((r) => (
            <ChannelCard
              key={r.id}
              row={r}
              busy={busy}
              onGenerateImage={() => generateImages([r.channel])}
              onRegenerateImage={() => regenerateImage(r.channel)}
              onValidateSku={
                r.channel_sku_id
                  ? () => validateSku(r.channel_sku_id!, r.channel)
                  : null
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ChannelCard({
  row,
  busy,
  onGenerateImage,
  onRegenerateImage,
  onValidateSku,
}: {
  row: GeneratedContentRow;
  busy: boolean;
  onGenerateImage: () => void;
  onRegenerateImage: () => void;
  onValidateSku: (() => void) | null;
}) {
  const bullets = safeParse<string[]>(row.bullets_json) ?? [];
  const failed = safeParse<string[]>(row.failed_rule_ids) ?? [];
  const validationErrors =
    safeParse<ValidationErrorEntry[]>(row.validation_errors_json) ?? [];
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

      <div className="mt-3">
        <Label>Title</Label>
        <p className="mt-1 text-[12.5px] leading-snug text-ink">{row.title}</p>
        <CharCounter value={row.title} />
      </div>

      <div className="mt-3">
        <Label>Bullets ({bullets.length})</Label>
        <ul className="mt-1 space-y-1 text-[11.5px] text-ink-2">
          {bullets.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-ink-3">{i + 1}.</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3">
        <Label>Description</Label>
        <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-2">
          {row.description}
        </p>
        <div className="mt-1 text-[10.5px] tabular-nums text-ink-3">
          {row.description.length} chars
        </div>
      </div>

      <div className="mt-3 border-t border-rule/40 pt-3">
        <Label>Main image</Label>
        {row.main_image_url ? (
          <div className="mt-2 space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={row.main_image_url}
              alt={`${row.channel} main`}
              className="aspect-square w-full max-w-[260px] rounded-md border border-rule object-cover"
            />
            <div className="flex items-center justify-between gap-2 text-[10.5px] tabular-nums text-ink-3">
              <span>
                attempts: {row.image_retry_count} · $
                {(row.image_generation_cost_cents / 100).toFixed(2)}
              </span>
              <Btn
                variant="ghost"
                disabled={busy}
                loading={busy}
                onClick={onRegenerateImage}
              >
                Re-roll
              </Btn>
            </div>
          </div>
        ) : canStartImage ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-ink-3">
              Text passed compliance — generate the main image to ship.
            </span>
            <Btn
              variant="primary"
              disabled={busy}
              loading={busy}
              onClick={onGenerateImage}
            >
              Generate image
            </Btn>
          </div>
        ) : (
          <p className="mt-2 text-[11.5px] text-ink-3">
            Image generation gated on text-compliance — pass Stage 4 first.
          </p>
        )}
      </div>

      {row.generation_cost_cents > 0 && (
        <div className="mt-3 border-t border-rule/40 pt-2 text-[10.5px] tabular-nums text-ink-3">
          text: ${(row.generation_cost_cents / 100).toFixed(3)} · cache R/W{" "}
          {row.cache_read_tokens}/{row.cache_write_tokens}
        </div>
      )}

      {onValidateSku && row.main_image_url && (
        <div className="mt-3 flex items-center justify-end">
          <Btn variant="ghost" disabled={busy} loading={busy} onClick={onValidateSku}>
            Re-validate
          </Btn>
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

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
      {children}
    </div>
  );
}

function CharCounter({ value }: { value: string }) {
  return (
    <div className="mt-1 text-[10.5px] tabular-nums text-ink-3">
      {value.length} chars
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
