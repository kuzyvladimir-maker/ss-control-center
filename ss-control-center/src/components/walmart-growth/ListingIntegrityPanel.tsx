"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  FileSearch,
  Image as ImageIcon,
  LockKeyhole,
} from "lucide-react";

import { Panel, PanelBody, PanelHeader } from "@/components/kit";
import type {
  ListingIntegrityShadowCase,
  ListingIntegrityShadowData,
} from "@/lib/walmart/listing-integrity-shadow-contract";
import { cn } from "@/lib/utils";

function Gate({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[12px] text-ink-2">
      {done
        ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[var(--green-ink)]" />
        : <span className="mt-0.5 size-3.5 shrink-0 rounded-full border border-rule" />}
      <span>{children}</span>
    </div>
  );
}

function StatusPill({ tone, children }: { tone: "danger" | "success" | "neutral"; children: React.ReactNode }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
      tone === "danger" && "border-[var(--danger)]/25 bg-[var(--danger-tint)] text-[var(--danger)]",
      tone === "success" && "border-[var(--green)]/25 bg-[var(--green-soft)] text-[var(--green-ink)]",
      tone === "neutral" && "border-rule bg-bg-elev text-ink-3",
    )}>
      {children}
    </span>
  );
}

function formatCapturedAt(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function ImageStage({ control }: { control: ListingIntegrityShadowCase }) {
  const [selectedSlot, setSelectedSlot] = useState("MAIN");
  const selected = control.currentImages.find((image) => image.slot === selectedSlot)
    ?? control.currentImages[0];
  return (
    <div className="space-y-3">
      <div className="aspect-square overflow-hidden rounded-lg border border-rule bg-white">
        {selected && (
          // Buyer image hosts are dynamic evidence sources, so next/image cannot
          // safely predeclare every hostname/path. Exact URLs remain visible below.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={selected.url}
            alt={`${control.sku} ${selected.slot} before repair`}
            className="h-full w-full object-contain"
          />
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {control.currentImages.map((image) => (
          <button
            type="button"
            key={image.slot}
            onClick={() => setSelectedSlot(image.slot)}
            className={cn(
              "relative size-14 shrink-0 overflow-hidden rounded-md border bg-white",
              selectedSlot === image.slot ? "border-[var(--danger)] ring-2 ring-[var(--danger)]/15" : "border-rule",
            )}
            aria-label={`Show ${image.slot}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.url} alt="" className="h-full w-full object-contain" />
            <span className="absolute inset-x-0 bottom-0 bg-black/65 py-0.5 text-[8px] font-semibold text-white">
              {image.slot}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function IntegrityCase({ control }: { control: ListingIntegrityShadowCase }) {
  const pdpUrl = `https://www.walmart.com/ip/${control.itemId}`;
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title={
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{control.sku}</span>
            <StatusPill tone="danger">{control.beforeVerdict}</StatusPill>
            <StatusPill tone="neutral">{control.publishedStatus}</StatusPill>
            <StatusPill tone="neutral">{control.lifecycleStatus}</StatusPill>
          </div>
        }
        right={
          <a
            href={pdpUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--green-ink)] hover:underline"
          >
            Buyer PDP <ExternalLink className="size-3" />
          </a>
        }
      />
      <PanelBody className="space-y-5">
        <div>
          <div className="text-[15px] font-semibold leading-snug text-ink">{control.title}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
            <span>Item {control.itemId}</span>
            <span>Captured {formatCapturedAt(control.capturedAt)} UTC</span>
            <span>Change scope: {control.changedFields.join(", ")}</span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-xl border border-[var(--danger)]/25 bg-[var(--danger-tint)]/35 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--danger)]">До · live buyer surface</div>
                <div className="mt-1 text-[13px] font-semibold text-ink">
                  Показана {control.observedMainUnits} упаковка из {control.expectedOuterUnits}
                </div>
              </div>
              <AlertTriangle className="size-5 text-[var(--danger)]" />
            </div>
            <ImageStage control={control} />
            <div className="mt-3 rounded-md bg-white/75 px-3 py-2 text-[11px] text-[var(--danger)]">
              {control.beforeReason}
            </div>
          </section>

          <section className="rounded-xl border border-[var(--green)]/25 bg-[var(--green-soft)]/45 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--green-ink)]">Предлагаемое исправление · ещё не live</div>
                <div className="mt-1 text-[13px] font-semibold text-ink">
                  Показаны все {control.proposedMain.representedOuterUnits} упаковок
                </div>
              </div>
              <StatusPill tone="success">MAIN {control.proposedMainVerdict}</StatusPill>
            </div>
            <div className="aspect-square overflow-hidden rounded-lg border border-rule bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={control.proposedMain.url}
                alt={`${control.sku} proposed six-package MAIN`}
                className="h-full w-full object-contain"
              />
            </div>
            <div className="mt-3 rounded-md border border-dashed border-[var(--green)]/35 bg-white/70 px-3 py-2 text-[11px] text-ink-2">
              Это точный repair candidate, а не выдуманное «После». Фактическое
              buyer-facing «После» появится здесь только после canary, propagation
              и свежего Qualification.
            </div>
          </section>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <section className="rounded-lg border border-rule">
            <div className="flex items-center gap-2 border-b border-rule px-3 py-2.5">
              <ImageIcon className="size-4 text-ink-3" />
              <span className="text-[12px] font-semibold text-ink">Exact diff</span>
            </div>
            <div className="grid grid-cols-[100px_1fr_1fr] text-[11px]">
              <div className="border-b border-rule px-3 py-2 font-mono uppercase text-ink-3">Field</div>
              <div className="border-b border-l border-rule px-3 py-2 font-mono uppercase text-ink-3">Before</div>
              <div className="border-b border-l border-rule px-3 py-2 font-mono uppercase text-ink-3">Target</div>
              <div className="px-3 py-3 font-semibold text-ink">MAIN</div>
              <div className="border-l border-rule px-3 py-3 text-[var(--danger)]">1 package visible</div>
              <div className="border-l border-rule px-3 py-3 text-[var(--green-ink)]">6 exact packages visible</div>
              <div className="border-t border-rule px-3 py-3 font-semibold text-ink">Text</div>
              <div className="border-l border-t border-rule px-3 py-3 text-ink-2">Already says Pack of 6</div>
              <div className="border-l border-t border-rule px-3 py-3 text-ink-2">No text mutation planned</div>
            </div>
          </section>

          <section className="rounded-lg border border-rule p-3">
            <div className="mb-3 flex items-center gap-2">
              <FileSearch className="size-4 text-ink-3" />
              <span className="text-[12px] font-semibold text-ink">Qualification chain</span>
            </div>
            <div className="space-y-2">
              <Gate done>Exact seller SKU → numeric buyer item</Gate>
              <Gate done>Product Truth = 6 × exact 8-count product</Gate>
              <Gate done>Current MAIN detected as 1-vs-6 BAD</Gate>
              <Gate done>Proposed MAIN component rechecks as PASS</Gate>
              <Gate done>Current MAIN + gallery exact-byte custody verified</Gate>
              <Gate done={false}>Source-aware visual attestation</Gate>
              <Gate done={false}>One-SKU live apply</Gate>
              <Gate done={false}>Fresh buyer reread + full Qualification PASS</Gate>
              <Gate done={false}>Published and indexing preserved</Gate>
            </div>
          </section>
        </div>

        <details className="rounded-lg border border-rule bg-bg-elev/45 px-3 py-2 text-[11px] text-ink-2">
          <summary className="cursor-pointer font-semibold text-ink">Evidence and honest limitations</summary>
          <div className="mt-2 space-y-1">
            <div className="font-mono text-[10px] text-ink-3">{control.evidencePath}</div>
            <div className="font-mono text-[10px] text-ink-3">{control.canaryPreviewPath}</div>
            {control.limitations.map((limitation) => <p key={limitation}>• {limitation}</p>)}
          </div>
        </details>
      </PanelBody>
    </Panel>
  );
}

export function ListingIntegrityPanel({ data }: { data: ListingIntegrityShadowData }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--warn)]/35 bg-[var(--warn-tint)] px-4 py-3">
        <div className="flex items-start gap-3">
          <Eye className="mt-0.5 size-5 shrink-0 text-[var(--warn-strong)]" />
          <div>
            <div className="text-[13px] font-semibold text-ink">Shadow mode · только наблюдение</div>
            <div className="mt-0.5 text-[11px] text-ink-2">
              Движок читает evidence и строит точный repair target. Walmart writes отключены.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone="neutral"><LockKeyhole className="mr-1 size-3" />Canary locked</StatusPill>
          <StatusPill tone="neutral"><LockKeyhole className="mr-1 size-3" />Mass run locked</StatusPill>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Closed-loop tests", `${data.engine.closedLoopTestsPassed}/${data.engine.closedLoopTestsPassed}`],
          ["Fresh detector tests", `${data.engine.focusedTestsPassed}/${data.engine.focusedTestsPassed}`],
          ["Shadow UI tests", `${data.engine.shadowTestsPassed}/${data.engine.shadowTestsPassed}`],
          ["Historical controls", String(data.engine.historicalCases)],
          ["Walmart writes", String(data.engine.walmartWrites)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-rule bg-surface p-3">
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-3">{label}</div>
            <div className="mt-1 text-[22px] font-semibold tabular text-ink">{value}</div>
          </div>
        ))}
      </div>

      {data.cases.length ? data.cases.map((control) => (
        <IntegrityCase key={control.controlId} control={control} />
      )) : (
        <Panel>
          <PanelBody className="flex items-center gap-3 text-[13px] text-ink-2">
            <FileSearch className="size-5 text-ink-3" />
            No fresh shadow controls have been captured yet.
          </PanelBody>
        </Panel>
      )}

      <div className="rounded-lg border border-dashed border-rule px-4 py-3 text-[11px] text-ink-2">
        <span className="font-semibold text-ink">Next gate:</span> {data.gates.next}
      </div>
    </div>
  );
}
