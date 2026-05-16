"use client";

// One-click bootstrap for Frozen Analytics v2 — applies the schema
// migration to the live DB and seeds the default rule set. Idempotent;
// re-running is safe.

import Link from "next/link";
import { useState } from "react";
import { Btn, PageHead, Panel, PanelBody, PanelHeader } from "@/components/kit";
import { Check, AlertTriangle, ChevronLeft } from "lucide-react";

interface BootstrapResult {
  ok: boolean;
  mode?: string;
  schema?: {
    applied: string[];
    idempotentSkips: string[];
    failures: Array<{ label: string; error: string }>;
  } | null;
  rules?: {
    created: number;
    updated?: number;
    skippedExisting: number;
    error: string | null;
  };
}

type Mode = "default" | "reset-rules";

export default function BootstrapFrozenV2Page() {
  const [running, setRunning] = useState<Mode | null>(null);
  const [result, setResult] = useState<BootstrapResult | null>(null);

  async function run(mode: Mode) {
    setRunning(mode);
    setResult(null);
    try {
      const url =
        mode === "reset-rules"
          ? "/api/admin/bootstrap-frozen-v2?mode=reset-rules"
          : "/api/admin/bootstrap-frozen-v2";
      const res = await fetch(url, { method: "POST" });
      const data = (await res.json()) as BootstrapResult;
      setResult(data);
    } catch (err) {
      setResult({
        ok: false,
        schema: {
          applied: [],
          idempotentSkips: [],
          failures: [
            {
              label: "request",
              error: err instanceof Error ? err.message : String(err),
            },
          ],
        },
      });
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-5">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
      >
        <ChevronLeft size={13} /> Back to Settings
      </Link>
      <PageHead
        title="Bootstrap — Frozen Analytics v2"
        subtitle={
          <span>
            One-click DB migration + default rule seed. Run this once after the
            v2 code ships.
          </span>
        }
      />

      <Panel>
        <PanelHeader title="What this does" />
        <PanelBody>
          <ul className="space-y-2 text-[13px] text-ink-2">
            <li>
              1. Creates the <code className="font-mono">FrozenRiskAlert</code>{" "}
              and <code className="font-mono">FrozenRule</code> tables in the
              currently-connected database (Turso in production).
            </li>
            <li>
              2. Adds the <code className="font-mono">linkedAlertId</code>{" "}
              column to the existing{" "}
              <code className="font-mono">FrozenIncident</code> table for the
              learning loop.
            </li>
            <li>
              3. Seeds 10 default rules (R1-R6 base + M1-M4 modifiers) into{" "}
              <code className="font-mono">FrozenRule</code>.
            </li>
          </ul>
          <p className="mt-3 text-[12px] text-ink-3">
            Safe to re-run — every step is idempotent. Existing rows are not
            overwritten.
          </p>
          <div className="mt-4">
            <Btn
              variant="primary"
              onClick={() => run("default")}
              loading={running === "default"}
              disabled={running !== null}
              icon={running !== "default" ? <Check size={14} /> : undefined}
            >
              {running === "default" ? "Running…" : "Run bootstrap"}
            </Btn>
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Reset rules to v2 defaults" />
        <PanelBody>
          <p className="text-[13px] text-ink-2">
            Overwrites the 10 rules in <code className="font-mono">FrozenRule</code>{" "}
            with the current default thresholds shipped with the code. Use this
            after a code update that changes thresholds (e.g. switching to
            Vladimir&rsquo;s empirical 30°C / 32°C / 35°C boundaries). The
            schema is NOT touched — only the rule rows.
          </p>
          <p className="mt-2 text-[12px] text-ink-3">
            After reset, open{" "}
            <a className="underline" href="/frozen-analytics">
              /frozen-analytics
            </a>{" "}
            and press <b>Run analysis</b> so existing alerts get re-scored
            against the new thresholds.
          </p>
          <div className="mt-4">
            <Btn
              variant="danger"
              onClick={() => run("reset-rules")}
              loading={running === "reset-rules"}
              disabled={running !== null}
              icon={running !== "reset-rules" ? <AlertTriangle size={14} /> : undefined}
            >
              {running === "reset-rules" ? "Resetting…" : "Reset rules"}
            </Btn>
          </div>
        </PanelBody>
      </Panel>

      {result && (
        <Panel>
          <PanelHeader
            title="Result"
            right={
              result.ok ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider"
                  style={{
                    background: "var(--green-soft)",
                    color: "var(--green-ink)",
                  }}
                >
                  <Check size={12} /> Success
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider"
                  style={{
                    background: "var(--danger-tint)",
                    color: "var(--danger)",
                  }}
                >
                  <AlertTriangle size={12} /> Failed
                </span>
              )
            }
          />
          <PanelBody>
            {result.schema && (
              <div className="space-y-3 text-[13px]">
                {result.schema.applied.length > 0 && (
                  <div>
                    <div className="mb-1 text-[11px] font-mono uppercase tracking-wider text-ink-3">
                      Applied ({result.schema.applied.length})
                    </div>
                    <ul className="space-y-0.5">
                      {result.schema.applied.map((s) => (
                        <li
                          key={s}
                          className="font-mono text-[12px] text-green-ink"
                        >
                          + {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.schema.idempotentSkips.length > 0 && (
                  <div>
                    <div className="mb-1 text-[11px] font-mono uppercase tracking-wider text-ink-3">
                      Already in place (
                      {result.schema.idempotentSkips.length})
                    </div>
                    <ul className="space-y-0.5">
                      {result.schema.idempotentSkips.map((s) => (
                        <li
                          key={s}
                          className="font-mono text-[12px] text-ink-3"
                        >
                          · {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.schema.failures.length > 0 && (
                  <div>
                    <div
                      className="mb-1 text-[11px] font-mono uppercase tracking-wider"
                      style={{ color: "var(--danger)" }}
                    >
                      Failures ({result.schema.failures.length})
                    </div>
                    <ul className="space-y-1.5">
                      {result.schema.failures.map((f, i) => (
                        <li
                          key={i}
                          className="rounded-md border border-rule px-2.5 py-1.5 text-[12px]"
                          style={{ background: "var(--danger-tint)" }}
                        >
                          <div className="font-mono font-semibold">
                            {f.label}
                          </div>
                          <div
                            className="mt-0.5 text-[11.5px]"
                            style={{ color: "var(--danger)" }}
                          >
                            {f.error}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {result.rules && (
              <div className="mt-4 border-t border-rule pt-3 text-[13px]">
                <div className="mb-1 text-[11px] font-mono uppercase tracking-wider text-ink-3">
                  Rules
                </div>
                <div className="text-ink-2">
                  Created <b className="text-ink">{result.rules.created}</b>
                  {result.rules.updated != null && (
                    <>
                      {" "}· overwritten{" "}
                      <b className="text-ink">{result.rules.updated}</b>
                    </>
                  )}
                  {" "}· already present{" "}
                  <b className="text-ink">{result.rules.skippedExisting}</b>
                </div>
                {result.rules.error && (
                  <div
                    className="mt-1 text-[12px]"
                    style={{ color: "var(--danger)" }}
                  >
                    {result.rules.error}
                  </div>
                )}
              </div>
            )}
            {result.ok && (
              <div className="mt-4 rounded-md border border-rule bg-green-soft px-3 py-2 text-[12.5px] text-green-ink">
                Готово. Открой{" "}
                <a
                  href="/frozen-analytics"
                  className="font-semibold underline"
                >
                  /frozen-analytics
                </a>{" "}
                — таб &ldquo;Today&rsquo;s risk&rdquo; должен теперь работать.
                Нажми &ldquo;Run analysis&rdquo; чтобы прогнать первый pipeline.
              </div>
            )}
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}
