"use client";

import { useState } from "react";
import { Btn } from "@/components/kit";
import { relativeTime, useFetchOnce } from "./CompliancePageClient";

interface BrandConflictRow {
  id: string;
  asin: string | null;
  account: string | null;
  foreign_brand: string;
  product_keywords: string;
  incident_date: string;
  incident_type: string;
  amazon_action: string | null;
  notes: string | null;
  status: string;
  created_at: string;
}

function parseKeywords(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

interface BrandConflictsTabProps {
  refreshKey: number;
  onChange: () => void;
}

export function BrandConflictsTab({
  refreshKey,
  onChange,
}: BrandConflictsTabProps) {
  const [showForm, setShowForm] = useState(false);
  const { data, loading, error } = useFetchOnce<{
    conflicts: BrandConflictRow[];
  }>(
    "/api/bundle-factory/compliance/brand-conflicts?status=active",
    refreshKey,
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-ink-3">
          Permanent blocklist. Rule 7 (gate orchestrator) reads from this
          table on every run.
        </p>
        <Btn
          size="sm"
          variant="primary"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? "Cancel" : "Add conflict"}
        </Btn>
      </div>

      {showForm && (
        <AddConflictForm
          onSaved={() => {
            setShowForm(false);
            onChange();
          }}
        />
      )}

      {loading && <Empty label="Loading…" />}
      {error && <Empty label={`Error: ${error}`} error />}

      {!loading && !error && data && data.conflicts.length === 0 && (
        <Empty label="No active brand conflicts." />
      )}

      {!loading && !error && data && data.conflicts.length > 0 && (
        <div className="overflow-x-auto rounded-[14px] border border-rule bg-surface">
          <table className="min-w-full text-[12.5px] text-ink">
            <thead className="bg-surface-tint text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Foreign brand</th>
                <th className="px-3 py-2 text-left">Product keywords</th>
                <th className="px-3 py-2 text-left">ASIN</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Amazon action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.conflicts.map((c) => (
                <tr key={c.id} className="hover:bg-bg-elev/40">
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">
                    {new Date(c.incident_date).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-3 py-2 font-medium text-ink">
                    {c.foreign_brand}
                  </td>
                  <td className="px-3 py-2 text-ink-2">
                    {parseKeywords(c.product_keywords).join(", ")}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-ink-2">
                    {c.asin ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-ink-3">{c.incident_type}</td>
                  <td className="px-3 py-2 text-ink-3">
                    {c.amazon_action ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddConflictForm({ onSaved }: { onSaved: () => void }) {
  const [foreignBrand, setForeignBrand] = useState("");
  const [keywords, setKeywords] = useState("");
  const [asin, setAsin] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        foreign_brand: foreignBrand.trim(),
        product_keywords: keywords
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0),
        asin: asin.trim() || undefined,
        notes: notes.trim() || undefined,
        incident_type: "trademark_logo_misuse",
      };
      const r = await fetch(
        "/api/bundle-factory/compliance/brand-conflicts",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`${r.status} ${text}`);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[14px] border border-rule bg-surface p-4">
      <h3 className="mb-3 text-[13px] font-semibold text-ink">
        Add brand conflict
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Foreign brand (required)">
          <input
            value={foreignBrand}
            onChange={(e) => setForeignBrand(e.target.value)}
            placeholder="e.g. Kraft"
            className="w-full rounded-md border border-rule bg-bg-elev px-2 py-1.5 text-[12.5px] text-ink"
          />
        </Field>
        <Field label="Product keywords (comma-separated, required)">
          <input
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="spongebob mac & cheese, microwavable cups"
            className="w-full rounded-md border border-rule bg-bg-elev px-2 py-1.5 text-[12.5px] text-ink"
          />
        </Field>
        <Field label="ASIN (optional)">
          <input
            value={asin}
            onChange={(e) => setAsin(e.target.value)}
            placeholder="B0FBML98G3"
            className="w-full rounded-md border border-rule bg-bg-elev px-2 py-1.5 font-mono text-[12px] text-ink"
          />
        </Field>
        <Field label="Notes (optional)">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Context — incident report, etc."
            className="w-full rounded-md border border-rule bg-bg-elev px-2 py-1.5 text-[12.5px] text-ink"
          />
        </Field>
      </div>
      {err && (
        <p className="mt-3 text-[12px] text-danger">{err}</p>
      )}
      <div className="mt-3 flex justify-end">
        <Btn
          variant="primary"
          onClick={submit}
          disabled={busy || !foreignBrand.trim() || !keywords.trim()}
          loading={busy}
        >
          Save
        </Btn>
      </div>
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
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </span>
      {children}
    </label>
  );
}

function Empty({ label, error = false }: { label: string; error?: boolean }) {
  return (
    <div
      className={`rounded-[14px] border p-6 text-center text-[12.5px] ${
        error
          ? "border-danger/30 bg-danger-tint/40 text-danger"
          : "border-rule bg-surface text-ink-3"
      }`}
    >
      {label}
    </div>
  );
}
