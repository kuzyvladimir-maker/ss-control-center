"use client";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ExternalLink, Truck } from "lucide-react";
import type { CsAnalysisResult } from "@/types";
import ActionBadge from "./ActionBadge";
import CarrierDelayAlert from "./CarrierDelayAlert";

const priorityColors: Record<string, string> = {
  LOW: "bg-slate-100 text-slate-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
  CRITICAL: "bg-red-600 text-white",
};

interface AnalysisPanelProps {
  result: CsAnalysisResult & { trackingUrl?: string | null };
}

export default function AnalysisPanel({ result }: AnalysisPanelProps) {
  return (
    <div className="space-y-3 text-sm">
      {/* CRITICAL priority banner */}
      {result.priority === "CRITICAL" && (
        <div className="rounded-lg bg-red-600 px-4 py-2 text-white font-semibold text-center">
          CRITICAL PRIORITY — Respond Immediately
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="text-slate-500">Channel:</span>{" "}
          <span className="font-medium">{result.channel}</span>
        </div>
        <div>
          <span className="text-slate-500">Store:</span>{" "}
          <span className="font-medium">{result.store || "—"}</span>
        </div>
        <div>
          <span className="text-slate-500">Order:</span>{" "}
          <span className="font-medium">{result.orderId || "—"}</span>
        </div>
        <div>
          <span className="text-slate-500">Customer:</span>{" "}
          <span className="font-medium">{result.customerName || "—"}</span>
        </div>
        <div>
          <span className="text-slate-500">Product:</span>{" "}
          <span className="font-medium">{result.product || "—"}</span>
        </div>
        <div>
          <span className="text-slate-500">Type:</span>{" "}
          <Badge variant="outline">
            {result.productType === "Frozen"
              ? "Frozen"
              : result.productType === "Dry"
                ? "Dry"
                : "Unknown"}
          </Badge>
        </div>
        <div>
          <span className="text-slate-500">Category:</span>{" "}
          <span className="font-medium">
            {result.category} - {result.categoryName}
          </span>
        </div>
        <div>
          <span className="text-slate-500">Language:</span>{" "}
          <span className="font-medium">{result.language}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-slate-500">Priority:</span>
        <Badge className={priorityColors[result.priority] || ""}>
          {result.priority}
        </Badge>
      </div>

      {result.branch && (
        <div>
          <span className="text-slate-500">Branch:</span>{" "}
          <span className="font-medium">
            {result.branch} - {result.branchName}
          </span>
        </div>
      )}

      {/* Carrier Delay Alert */}
      {result.carrierDelayDetected && (
        <>
          <Separator />
          <CarrierDelayAlert result={result} />
        </>
      )}

      {/* Tracking & Shipping */}
      {(result.trackingNumber || result.shippingTimeline) && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="flex items-center gap-1 font-medium text-slate-700">
              <Truck size={14} /> Shipping & Tracking
            </p>
            {result.trackingNumber && (
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Tracking:</span>
                <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                  {result.trackingNumber}
                </code>
                {result.trackingCarrier && (
                  <Badge variant="outline" className="text-[10px]">
                    {result.trackingCarrier}
                  </Badge>
                )}
                {result.trackingUrl && (
                  <a
                    href={result.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    <ExternalLink size={12} />
                  </a>
                )}
              </div>
            )}
            {result.shippingTimeline && (
              <div className="rounded-md bg-slate-50 p-3 text-xs space-y-1">
                {result.shippingTimeline.shipDate && (
                  <div>
                    <span className="text-slate-500">Shipped:</span>{" "}
                    {result.shippingTimeline.shipDate}
                  </div>
                )}
                {result.shippingTimeline.edd && (
                  <div>
                    <span className="text-slate-500">EDD:</span>{" "}
                    {result.shippingTimeline.edd}
                  </div>
                )}
                {result.shippingTimeline.actualDelivery && (
                  <div>
                    <span className="text-slate-500">Delivered:</span>{" "}
                    {result.shippingTimeline.actualDelivery}
                  </div>
                )}
                {result.shippingTimeline.status && (
                  <div>
                    <span className="text-slate-500">Status:</span>{" "}
                    {result.shippingTimeline.status}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <Separator />

      {/* Action + Urgency */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Action:</span>
          <ActionBadge action={result.action} />
        </div>
        <div>
          <span className="text-slate-500">Urgency:</span>{" "}
          <span className="font-medium">{result.urgency}</span>
        </div>
      </div>
    </div>
  );
}
