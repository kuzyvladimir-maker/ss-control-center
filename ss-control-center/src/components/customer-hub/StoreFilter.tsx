"use client";

import { useEffect, useState } from "react";

interface StoreFilterProps {
  value: string;
  onChange: (value: string) => void;
}

interface StoreOption {
  storeIndex: number;
  storeName: string;
  configured: boolean;
}

/**
 * Dynamic store dropdown — fetches the list of configured Gmail store
 * slots from /api/integrations/gmail so the 5 real stores show up
 * automatically after OAuth without hardcoding names.
 */
export default function StoreFilter({ value, onChange }: StoreFilterProps) {
  const [stores, setStores] = useState<StoreOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations/gmail")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const accounts = (data?.accounts || []) as Array<{
          storeIndex: number;
          storeName: string;
          configured: boolean;
        }>;
        // Show configured stores first, then pad with unconfigured ones so
        // the operator still sees the slot if they haven't connected yet.
        const sorted = [...accounts].sort((a, b) => {
          if (a.configured !== b.configured) {
            return a.configured ? -1 : 1;
          }
          return a.storeIndex - b.storeIndex;
        });
        setStores(sorted);
      })
      .catch(() => {
        // If the endpoint fails, leave the dropdown with just "All Accounts"
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
    >
      <option value="all">All Accounts</option>
      {stores.map((s) => (
        <option
          key={s.storeIndex}
          value={String(s.storeIndex)}
          disabled={!s.configured}
        >
          {s.storeName}
          {s.configured ? "" : " (not connected)"}
        </option>
      ))}
    </select>
  );
}
