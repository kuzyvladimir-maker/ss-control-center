"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Snapshot {
  storeId: string;
  storeName: string;
  status: string;
  orderDefectRate: number | null;
  lateShipmentRate: number | null;
  validTrackingRate: number | null;
  onTimeDeliveryRate: number | null;
  alertCount: number;
  criticalCount: number;
}

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-700",
  AT_RISK: "bg-amber-100 text-amber-700",
  SUSPENDED: "bg-red-600 text-white",
  UNKNOWN: "bg-slate-100 text-slate-500",
};

function metricStatus(
  value: number | null,
  warnThreshold: number,
  critThreshold: number,
  higher: boolean
): string {
  if (value === null) return "text-slate-400";
  const isCrit = higher ? value > critThreshold : value < critThreshold;
  const isWarn = higher ? value > warnThreshold : value < warnThreshold;
  if (isCrit) return "text-red-600 font-bold";
  if (isWarn) return "text-amber-600 font-semibold";
  return "text-green-600";
}

export default function StoreHealthCard({ store }: { store: Snapshot }) {
  const isSuspended = store.status === "SUSPENDED";

  return (
    <Card className={isSuspended ? "border-red-500 border-2" : ""}>
      <CardContent className="py-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm text-slate-800">
            {store.storeName}
          </span>
          <Badge className={statusColors[store.status] || ""}>
            {store.status}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-1 text-xs">
          <div>
            <span className="text-slate-500">ODR: </span>
            <span className={metricStatus(store.orderDefectRate, 0.5, 1, true)}>
              {store.orderDefectRate !== null
                ? `${store.orderDefectRate}%`
                : "—"}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Late Ship: </span>
            <span
              className={metricStatus(store.lateShipmentRate, 3, 4, true)}
            >
              {store.lateShipmentRate !== null
                ? `${store.lateShipmentRate}%`
                : "—"}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Tracking: </span>
            <span
              className={metricStatus(store.validTrackingRate, 95, 90, false)}
            >
              {store.validTrackingRate !== null
                ? `${store.validTrackingRate}%`
                : "—"}
            </span>
          </div>
          <div>
            <span className="text-slate-500">OTDR: </span>
            <span
              className={metricStatus(store.onTimeDeliveryRate, 95, 90, false)}
            >
              {store.onTimeDeliveryRate !== null
                ? `${store.onTimeDeliveryRate}%`
                : "—"}
            </span>
          </div>
        </div>

        {store.alertCount > 0 && (
          <p className="text-[10px] text-amber-600">
            {store.criticalCount > 0
              ? `${store.criticalCount} critical, `
              : ""}
            {store.alertCount} alert{store.alertCount > 1 ? "s" : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
