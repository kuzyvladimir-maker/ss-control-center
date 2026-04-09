"use client";

interface TransitTimelineProps {
  shipDate: string | null;
  promisedEdd: string | null;
  actualDelivery: string | null;
  daysInTransit: number | null;
  daysLate: number | null;
}

export default function TransitTimeline({
  shipDate,
  promisedEdd,
  actualDelivery,
  daysInTransit,
  daysLate,
}: TransitTimelineProps) {
  const isLate = daysLate !== null && daysLate > 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs font-medium text-slate-500 mb-2">Transit Timeline</p>
      <div className="flex items-center gap-1 text-xs">
        {/* Ship date */}
        <div className="flex flex-col items-center">
          <div className="h-3 w-3 rounded-full bg-green-500" />
          <span className="mt-1 text-[10px] text-slate-500">Ship</span>
          <span className="text-[10px] font-medium">{shipDate || "—"}</span>
        </div>

        {/* Line to EDD */}
        <div className="flex-1 h-0.5 bg-slate-200 mx-1" />

        {/* EDD */}
        <div className="flex flex-col items-center">
          <div className="h-3 w-3 rounded-full bg-blue-500" />
          <span className="mt-1 text-[10px] text-slate-500">EDD</span>
          <span className="text-[10px] font-medium">{promisedEdd || "—"}</span>
        </div>

        {/* Line to actual */}
        <div
          className={`flex-1 h-0.5 mx-1 ${isLate ? "bg-red-300" : "bg-green-200"}`}
        />

        {/* Actual delivery */}
        <div className="flex flex-col items-center">
          <div
            className={`h-3 w-3 rounded-full ${isLate ? "bg-red-500" : "bg-green-500"}`}
          />
          <span className="mt-1 text-[10px] text-slate-500">Actual</span>
          <span className="text-[10px] font-medium">
            {actualDelivery || "—"}
          </span>
        </div>
      </div>

      {/* Summary */}
      <div className="mt-2 flex gap-3 text-[10px]">
        {daysInTransit !== null && (
          <span className="text-slate-500">
            Transit: <strong>{daysInTransit}d</strong>
          </span>
        )}
        {isLate && (
          <span className="text-red-600 font-medium">
            Late: +{daysLate}d
          </span>
        )}
      </div>
    </div>
  );
}
