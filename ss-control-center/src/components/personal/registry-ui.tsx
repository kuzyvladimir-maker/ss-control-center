"use client";

// Shared bits of the Personal Finance pages: section nav, status badges, the
// "as of · source" line every number carries, and the warnings panel.

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { STANDING_META, asStanding, type RegistryAlert } from "@/lib/finance/registry";

export const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const usd2 = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** null → "not set" (never print an unknown as $0). */
export const money = (n: number | null | undefined, cents = true) => (n == null ? "not set" : cents ? usd2(n) : usd(n));
export const dateShort = (iso: string | null | undefined) =>
  iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—";
export const dateLong = (iso: string | null | undefined) =>
  iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
export const monthLabel = (ym: string | null | undefined) =>
  ym ? new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "—";

const TABS = [
  { href: "/personal", label: "Overview" },
  { href: "/personal/obligations", label: "Obligations" },
  { href: "/personal/plan", label: "Payoff plan" },
  { href: "/personal/net-worth", label: "Net worth" },
  { href: "/personal/cards", label: "Cards" },
];

export function PersonalNav({ active }: { active: string }) {
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-rule">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href}
          className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-[13px] transition-colors",
            active === t.href ? "border-green font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink")}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

const TONE: Record<string, string> = {
  danger: "bg-danger-tint text-danger",
  warn: "bg-warn-tint text-warn-strong",
  purple: "bg-purple-tint text-purple",
  info: "bg-info-tint text-info",
  green: "bg-green-soft text-green-ink",
  neutral: "bg-bg-elev text-ink-3",
};

export function StandingBadge({ standing, className }: { standing: string | null | undefined; className?: string }) {
  const meta = STANDING_META[asStanding(standing)];
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium uppercase tracking-wide", TONE[meta.tone], className)}>
      {meta.label}
    </span>
  );
}

/** "as of Oct 27, 2026 · Plaid 2026-10-27" — every amount shows how fresh it is. */
export function AsOf({ asOf, source, className }: { asOf: string | null | undefined; source: string | null | undefined; className?: string }) {
  return (
    <div className={cn("text-[11px] text-ink-4", className)}>
      {asOf ? `as of ${dateLong(asOf)}` : "date not set"}
      {source ? <span> · {source}</span> : <span> · source not set</span>}
    </div>
  );
}

export function AlertsPanel({ alerts }: { alerts: RegistryAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="rounded-lg border border-danger/30 bg-danger-tint/60 px-3.5 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-danger">
        <AlertTriangle className="h-4 w-4" /> Warnings · {alerts.length}
      </div>
      <ul className="space-y-1">
        {alerts.map((a) => (
          <li key={`${a.refType}-${a.refId}`} className="text-[13px] text-ink-2">
            <Link href={a.refType === "asset" ? "/personal/net-worth" : `/personal/obligations#${a.refId}`} className="hover:underline">
              <span className="font-medium text-ink">{a.label}:</span> {a.text}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Kpi({ label, value, hint, tone, href }: { label: string; value: string; hint?: string; tone?: "danger" | "green"; href?: string }) {
  const body = (
    <div className={cn("h-full rounded-lg border border-rule bg-surface px-3.5 py-3", href && "transition-colors hover:border-ink-4/40")}>
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={cn("mt-0.5 text-[20px] font-semibold tabular", tone === "danger" ? "text-danger" : tone === "green" ? "text-green-ink" : "text-ink")}>{value}</div>
      {hint && <div className="text-[11px] text-ink-4">{hint}</div>}
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

export function OwnerTag({ owner }: { owner: string | null | undefined }) {
  return <span className={cn("text-[12px]", owner ? "text-ink-2" : "text-danger")}>{owner ?? "owner not set"}</span>;
}
