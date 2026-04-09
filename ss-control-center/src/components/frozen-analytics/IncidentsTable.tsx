"use client";

import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, ChevronRight } from "lucide-react";
import WeatherBlock from "./WeatherBlock";
import TransitTimeline from "./TransitTimeline";

interface Incident {
  id: string;
  createdAt: string;
  orderId: string;
  sku: string;
  productName: string;
  carrier: string;
  service: string;
  shipDate: string;
  promisedEdd: string | null;
  actualDelivery: string | null;
  daysInTransit: number | null;
  daysLate: number | null;
  originTempF: number | null;
  originFeelsLikeF: number | null;
  originTempHighF: number | null;
  originWeatherDesc: string | null;
  destTempF: number | null;
  destFeelsLikeF: number | null;
  destTempHighF: number | null;
  destWeatherDesc: string | null;
  destCity: string | null;
  destState: string | null;
  outcome: string;
  resolution: string | null;
  notes: string | null;
}

const outcomeConfig: Record<string, { icon: string; className: string }> = {
  thawed: { icon: "Thawed", className: "bg-red-100 text-red-700" },
  unclear: { icon: "Unclear", className: "bg-yellow-100 text-yellow-700" },
  ok: { icon: "OK", className: "bg-green-100 text-green-700" },
};

interface IncidentsTableProps {
  incidents: Incident[];
  total: number;
  filters: { carrier: string; service: string; days: string };
  onFiltersChange: (f: { carrier: string; service: string; days: string }) => void;
}

export default function IncidentsTable({
  incidents,
  total,
  filters,
  onFiltersChange,
}: IncidentsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filters.carrier}
          onChange={(e) =>
            onFiltersChange({ ...filters, carrier: e.target.value })
          }
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">All Carriers</option>
          <option value="ups">UPS</option>
          <option value="fedex">FedEx</option>
          <option value="usps">USPS</option>
        </select>
        <select
          value={filters.days}
          onChange={(e) =>
            onFiltersChange({ ...filters, days: e.target.value })
          }
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="30">Last 30 days</option>
          <option value="60">Last 60 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last year</option>
        </select>
        <span className="text-xs text-slate-500 ml-auto">
          {total} incident{total !== 1 ? "s" : ""}
        </span>
      </div>

      {incidents.length === 0 ? (
        <p className="text-sm text-slate-400 py-4 text-center">
          No incidents found
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Date</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Carrier / Service</TableHead>
              <TableHead>Transit</TableHead>
              <TableHead>Tampa</TableHead>
              <TableHead>Dest</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {incidents.map((inc) => {
              const expanded = expandedId === inc.id;
              const oc = outcomeConfig[inc.outcome] || outcomeConfig.thawed;
              return (
                <Fragment key={inc.id}>
                  <TableRow
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => setExpandedId(expanded ? null : inc.id)}
                  >
                    <TableCell className="px-2">
                      {expanded ? (
                        <ChevronDown size={14} className="text-slate-400" />
                      ) : (
                        <ChevronRight size={14} className="text-slate-400" />
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {new Date(inc.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {inc.sku}
                    </TableCell>
                    <TableCell className="text-xs">
                      {inc.carrier} {inc.service}
                    </TableCell>
                    <TableCell className="text-xs">
                      {inc.daysInTransit !== null ? `${inc.daysInTransit}d` : "—"}
                      {inc.daysLate && inc.daysLate > 0 && (
                        <span className="text-red-600 ml-1">+{inc.daysLate}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {inc.originTempF !== null
                        ? `${Math.round(inc.originTempF)}F`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {inc.destTempF !== null
                        ? `${Math.round(inc.destTempF)}F`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge className={oc.className}>{oc.icon}</Badge>
                    </TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow key={`${inc.id}-detail`}>
                      <TableCell colSpan={8} className="bg-slate-50 p-4">
                        <div className="space-y-4">
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <span className="text-slate-500">Order:</span>{" "}
                              {inc.orderId}
                            </div>
                            <div>
                              <span className="text-slate-500">Product:</span>{" "}
                              {inc.productName}
                            </div>
                          </div>

                          <TransitTimeline
                            shipDate={inc.shipDate}
                            promisedEdd={inc.promisedEdd}
                            actualDelivery={inc.actualDelivery}
                            daysInTransit={inc.daysInTransit}
                            daysLate={inc.daysLate}
                          />

                          <div className="grid grid-cols-2 gap-3">
                            <WeatherBlock
                              label="Tampa, FL (origin)"
                              date={inc.shipDate}
                              tempF={inc.originTempF}
                              feelsLikeF={inc.originFeelsLikeF}
                              highF={inc.originTempHighF}
                              description={inc.originWeatherDesc}
                            />
                            <WeatherBlock
                              label={
                                inc.destCity && inc.destState
                                  ? `${inc.destCity}, ${inc.destState}`
                                  : "Destination"
                              }
                              date={inc.actualDelivery}
                              tempF={inc.destTempF}
                              feelsLikeF={inc.destFeelsLikeF}
                              highF={inc.destTempHighF}
                              description={inc.destWeatherDesc}
                            />
                          </div>

                          {inc.notes && (
                            <p className="text-xs text-slate-500 bg-white rounded p-2 border">
                              {inc.notes}
                            </p>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
