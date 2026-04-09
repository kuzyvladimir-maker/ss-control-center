"use client";

import type { CsAnalysisResult } from "@/types";

interface CarrierDelayAlertProps {
  result: CsAnalysisResult;
}

export default function CarrierDelayAlert({ result }: CarrierDelayAlertProps) {
  // Don't show for Walmart (different mechanics)
  if (result.channel === "Walmart") return null;
  if (!result.carrierDelayDetected) return null;

  const isProtected = result.carrierBadge === "Claims Protected";

  if (isProtected) {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
        <p className="flex items-center gap-2 font-semibold text-blue-800">
          CARRIER DELAY DETECTED
        </p>
        <div className="text-sm text-blue-700 space-y-1">
          {result.promisedEdd && result.actualDelivery && (
            <p>
              Promised EDD: {result.promisedEdd} &rarr; Actual:{" "}
              {result.actualDelivery}
              {result.daysLate ? ` (+${result.daysLate} day${result.daysLate > 1 ? "s" : ""})` : ""}
            </p>
          )}
          <p>Badge: Claims Protected</p>
          <div className="mt-2 rounded bg-blue-100 px-3 py-2 text-blue-800 font-medium">
            Amazon A-to-Z Guarantee applies — DO NOT issue direct refund
          </div>
        </div>
      </div>
    );
  }

  // Late Delivery Risk or Unknown
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
      <p className="flex items-center gap-2 font-semibold text-amber-800">
        CARRIER DELAY (no protection)
      </p>
      <div className="text-sm text-amber-700 space-y-1">
        {result.promisedEdd && result.actualDelivery && (
          <p>
            Promised EDD: {result.promisedEdd} &rarr; Actual:{" "}
            {result.actualDelivery}
            {result.daysLate ? ` (+${result.daysLate} day${result.daysLate > 1 ? "s" : ""})` : ""}
          </p>
        )}
        <p>
          Badge: {result.carrierBadge || "Unknown"}
        </p>
        <div className="mt-2 rounded bg-amber-100 px-3 py-2 text-amber-800 font-medium">
          Our responsibility — offer replacement/refund
        </div>
      </div>
    </div>
  );
}
