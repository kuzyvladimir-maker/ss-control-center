"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PatternGroup {
  label: string;
  total: number;
  thawed: number;
  thawRate: number;
  recommendation: string;
  level: "safe" | "warning" | "danger";
}

interface BucketData {
  label: string;
  total: number;
  thawed: number;
  thawRate: number;
}

interface PatternsData {
  combinations: PatternGroup[];
  byTransitDays: BucketData[];
  byOriginTemp: BucketData[];
  totalIncidents: number;
}

const levelColors = {
  danger: "border-danger/20 bg-danger-tint",
  warning: "border-warn/20 bg-warn-tint",
  safe: "border-green-200 bg-green-soft",
};

const levelTextColors = {
  danger: "text-danger",
  warning: "text-warn-strong",
  safe: "text-green-ink",
};

export default function PatternsDashboard({ data }: { data: PatternsData }) {
  if (data.totalIncidents === 0) {
    return (
      <p className="text-sm text-ink-3 py-4 text-center">
        No pattern data yet. Patterns appear after multiple frozen incidents.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* High risk combinations */}
      {data.combinations.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">
            Carrier/Service Combinations
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {data.combinations.map((combo) => (
              <div
                key={combo.label}
                className={`rounded-lg border p-3 ${levelColors[combo.level]}`}
              >
                <p
                  className={`text-sm font-medium ${levelTextColors[combo.level]}`}
                >
                  {combo.label}
                </p>
                <p className="text-xs text-ink-2 mt-1">
                  {combo.thawed}/{combo.total} incidents ({combo.thawRate}% thaw
                  rate)
                </p>
                <p className="text-xs mt-1 text-ink-3">
                  {combo.recommendation}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Thaw rate by transit days */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Thaw Rate by Transit Days</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4">
            {data.byTransitDays.map((bucket) => (
              <div key={bucket.label} className="text-center">
                <div
                  className="mx-auto mb-1 flex h-12 w-12 items-center justify-center rounded-lg text-sm font-bold"
                  style={{
                    backgroundColor:
                      bucket.thawRate >= 50
                        ? "#fecaca"
                        : bucket.thawRate >= 20
                          ? "#fef3c7"
                          : "#dcfce7",
                    color:
                      bucket.thawRate >= 50
                        ? "#991b1b"
                        : bucket.thawRate >= 20
                          ? "#92400e"
                          : "#166534",
                  }}
                >
                  {bucket.thawRate}%
                </div>
                <p className="text-xs text-ink-2">{bucket.label}</p>
                <p className="text-[10px] text-ink-3">
                  {bucket.total > 0
                    ? `${bucket.thawed}/${bucket.total}`
                    : "no data"}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Thaw rate by origin temp */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Thaw Rate by Tampa Temperature
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4">
            {data.byOriginTemp.map((bucket) => (
              <div key={bucket.label} className="text-center">
                <div
                  className="mx-auto mb-1 flex h-12 w-12 items-center justify-center rounded-lg text-sm font-bold"
                  style={{
                    backgroundColor:
                      bucket.thawRate >= 50
                        ? "#fecaca"
                        : bucket.thawRate >= 20
                          ? "#fef3c7"
                          : "#dcfce7",
                    color:
                      bucket.thawRate >= 50
                        ? "#991b1b"
                        : bucket.thawRate >= 20
                          ? "#92400e"
                          : "#166534",
                  }}
                >
                  {bucket.thawRate}%
                </div>
                <p className="text-xs text-ink-2">{bucket.label}</p>
                <p className="text-[10px] text-ink-3">
                  {bucket.total > 0
                    ? `${bucket.thawed}/${bucket.total}`
                    : "no data"}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
