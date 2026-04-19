"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Scale, ShieldCheck, ShieldX, DollarSign } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import AtozTable from "@/components/claims/AtozTable";

interface ClaimStats {
  active: number;
  responseReady: number;
  won30d: number;
  lost30d: number;
  savedAmount: number;
  lostAmount: number;
}

export default function AtozClaimsPage() {
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [claims, setClaims] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<ClaimStats | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/claims/atoz?limit=50");
      const data = await res.json();
      setClaims(data.claims || []);
      setTotal(data.total || 0);

      // Calculate stats from data
      const all = data.claims || [];
      const active = all.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) => !["DECIDED", "CLOSED"].includes(c.status)
      ).length;
      const responseReady = all.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) => c.status === "RESPONSE_READY"
      ).length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const won = all.filter((c: any) =>
        ["IN_OUR_FAVOR", "AMAZON_FUNDED"].includes(c.amazonDecision)
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lost = all.filter((c: any) => c.amazonDecision === "AGAINST_US");

      setStats({
        active,
        responseReady,
        won30d: won.length,
        lost30d: lost.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        savedAmount: won.reduce((s: number, c: any) => s + (c.amountSaved || 0), 0),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lostAmount: lost.reduce((s: number, c: any) => s + (c.amountCharged || 0), 0),
      });
    } catch {
      console.error("Failed to fetch claims");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mounted) fetchClaims();
  }, [mounted, fetchClaims]);

  if (!mounted) return null;

  return (
    <div className="space-y-6">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-danger-tint p-2.5">
                <Scale size={18} className="text-danger" />
              </div>
              <div>
                <p className="text-xs text-ink-3">Active Claims</p>
                <p className="text-2xl font-bold text-ink">
                  {stats.active}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-green-soft p-2.5">
                <Loader2 size={18} className="text-green" />
              </div>
              <div>
                <p className="text-xs text-ink-3">Response Ready</p>
                <p className="text-2xl font-bold text-ink">
                  {stats.responseReady}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-green-soft p-2.5">
                <ShieldCheck size={18} className="text-green" />
              </div>
              <div>
                <p className="text-xs text-ink-3">Won / Saved</p>
                <p className="text-lg font-bold text-green">
                  ${stats.savedAmount.toFixed(2)}
                </p>
                <p className="text-[10px] text-ink-3">
                  {stats.won30d} claims
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-danger-tint p-2.5">
                <ShieldX size={18} className="text-danger" />
              </div>
              <div>
                <p className="text-xs text-ink-3">Lost</p>
                <p className="text-lg font-bold text-danger">
                  ${stats.lostAmount.toFixed(2)}
                </p>
                <p className="text-[10px] text-ink-3">
                  {stats.lost30d} claims
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Saved vs Lost summary */}
      {stats && (stats.savedAmount > 0 || stats.lostAmount > 0) && (
        <div className="flex items-center gap-4 text-sm">
          <DollarSign size={16} className="text-ink-3" />
          <span className="text-green font-medium">
            Saved: ${stats.savedAmount.toFixed(2)}
          </span>
          <span className="text-ink-4">|</span>
          <span className="text-danger font-medium">
            Lost: ${stats.lostAmount.toFixed(2)}
          </span>
        </div>
      )}

      {/* Claims table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Scale size={18} />
              A-to-Z & Chargeback Claims
            </span>
            {loading && (
              <Loader2 size={16} className="animate-spin text-ink-3" />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AtozTable claims={claims} total={total} />
        </CardContent>
      </Card>
    </div>
  );
}
