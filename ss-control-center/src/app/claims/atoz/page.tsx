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
              <div className="rounded-lg bg-red-50 p-2.5">
                <Scale size={18} className="text-red-600" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Active Claims</p>
                <p className="text-2xl font-bold text-slate-800">
                  {stats.active}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-blue-50 p-2.5">
                <Loader2 size={18} className="text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Response Ready</p>
                <p className="text-2xl font-bold text-slate-800">
                  {stats.responseReady}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-green-50 p-2.5">
                <ShieldCheck size={18} className="text-green-600" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Won / Saved</p>
                <p className="text-lg font-bold text-green-600">
                  ${stats.savedAmount.toFixed(2)}
                </p>
                <p className="text-[10px] text-slate-400">
                  {stats.won30d} claims
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="rounded-lg bg-red-50 p-2.5">
                <ShieldX size={18} className="text-red-600" />
              </div>
              <div>
                <p className="text-xs text-slate-500">Lost</p>
                <p className="text-lg font-bold text-red-600">
                  ${stats.lostAmount.toFixed(2)}
                </p>
                <p className="text-[10px] text-slate-400">
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
          <DollarSign size={16} className="text-slate-400" />
          <span className="text-green-600 font-medium">
            Saved: ${stats.savedAmount.toFixed(2)}
          </span>
          <span className="text-slate-300">|</span>
          <span className="text-red-600 font-medium">
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
              <Loader2 size={16} className="animate-spin text-slate-400" />
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
