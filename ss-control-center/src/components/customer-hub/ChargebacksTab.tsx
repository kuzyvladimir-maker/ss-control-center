"use client";

import { useEffect, useState } from "react";
import { Loader2, CreditCard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import DefenseStrategyBadge from "@/components/claims/DefenseStrategyBadge";
import AtozDetail from "./AtozDetail";

interface Claim {
  id: string;
  amazonOrderId: string;
  claimType: string;
  claimReason: string | null;
  amount: number | null;
  deadline: string | null;
  strategyType: string | null;
  strategyConfidence: string | null;
  status: string;
}

const statusColors: Record<string, string> = {
  NEW: "bg-red-100 text-red-700",
  EVIDENCE_GATHERED: "bg-amber-100 text-amber-700",
  RESPONSE_READY: "bg-blue-100 text-blue-700",
  SUBMITTED: "bg-green-100 text-green-700",
  DECIDED: "bg-slate-100 text-slate-700",
  APPEALED: "bg-purple-100 text-purple-700",
  CLOSED: "bg-slate-100 text-slate-500",
};

// Compute days until reply-by deadline from a YYYY-MM-DD string on the client.
function daysUntil(deadline: string | null): number | null {
  if (!deadline) return null;
  const [y, m, d] = deadline.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || !d) return null;
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

export default function ChargebacksTab() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/customer-hub/chargebacks")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setClaims(data.claims || []);
        setTotal(data.total || 0);
      })
      .catch(() => {
        if (!cancelled) {
          setClaims([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-slate-400 mr-2" />
          <span className="text-sm text-slate-500">Loading chargebacks…</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100">
            <span className="text-xs text-slate-500">
              {total} chargeback{total !== 1 ? "s" : ""}
            </span>
          </div>

          {claims.length === 0 ? (
            <div className="py-12 text-center">
              <CreditCard size={32} className="mx-auto text-slate-300 mb-3" />
              <p className="text-sm font-medium text-slate-600">
                No chargebacks
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Chargebacks will appear here once detected from Amazon
                notifications.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Order ID</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Reply-By</TableHead>
                  <TableHead>Strategy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {claims.map((c) => {
                  const days = daysUntil(c.deadline);
                  const urgent = days !== null && days < 3;
                  return (
                    <TableRow
                      key={c.id}
                      className={`cursor-pointer hover:bg-slate-50 ${
                        selectedId === c.id ? "bg-blue-50" : ""
                      } ${urgent ? "bg-red-50/40" : ""}`}
                      onClick={() =>
                        setSelectedId(selectedId === c.id ? null : c.id)
                      }
                    >
                      <TableCell>
                        <Badge className={statusColors[c.status] || ""}>
                          {c.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {c.amazonOrderId}
                      </TableCell>
                      <TableCell className="text-xs">
                        {c.claimReason || "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs font-medium text-red-600">
                        {c.amount != null ? `$${c.amount.toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {c.deadline || "—"}
                        {days !== null && days < 3 && (
                          <Badge className="ml-1 bg-red-600 text-white text-[9px]">
                            {days}d left
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DefenseStrategyBadge
                          strategyType={c.strategyType}
                          confidence={c.strategyConfidence}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selectedId && (
        <div className="mt-4">
          <AtozDetail
            key={selectedId}
            claimId={selectedId}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </>
  );
}
