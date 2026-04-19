"use client";

import { Sun, Cloud, CloudRain, Snowflake, CloudFog } from "lucide-react";

interface WeatherBlockProps {
  label: string; // "Tampa, FL" or "Beverly Hills, CA"
  date: string | null;
  tempF: number | null;
  feelsLikeF?: number | null;
  highF?: number | null;
  description?: string | null;
}

function weatherIcon(desc: string | null) {
  if (!desc) return <Sun size={18} className="text-amber-500" />;
  const d = desc.toLowerCase();
  if (d.includes("rain") || d.includes("drizzle") || d.includes("shower"))
    return <CloudRain size={18} className="text-green-mid" />;
  if (d.includes("snow"))
    return <Snowflake size={18} className="text-blue-300" />;
  if (d.includes("fog"))
    return <CloudFog size={18} className="text-ink-3" />;
  if (d.includes("cloud") || d.includes("overcast"))
    return <Cloud size={18} className="text-ink-3" />;
  return <Sun size={18} className="text-amber-500" />;
}

function tempColor(tempF: number | null): string {
  if (tempF === null) return "text-ink-3";
  if (tempF >= 90) return "text-danger font-bold";
  if (tempF >= 85) return "text-orange-600 font-semibold";
  if (tempF >= 80) return "text-warn";
  if (tempF >= 75) return "text-yellow-600";
  return "text-green";
}

export default function WeatherBlock({
  label,
  date,
  tempF,
  feelsLikeF,
  highF,
  description,
}: WeatherBlockProps) {
  if (tempF === null && !description) {
    return (
      <div className="rounded-lg border border-rule bg-surface-tint p-3 text-xs text-ink-3">
        <p className="font-medium text-ink-3">{label}</p>
        <p>No weather data</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-rule bg-white p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-ink-3">{label}</span>
        {date && <span className="text-[10px] text-ink-3">{date}</span>}
      </div>
      <div className="flex items-center gap-2">
        {weatherIcon(description || null)}
        <span className={`text-lg ${tempColor(tempF)}`}>
          {tempF !== null ? `${Math.round(tempF)}F` : "—"}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-ink-3 space-y-0.5">
        {feelsLikeF !== null && feelsLikeF !== undefined && (
          <p>Feels like: {Math.round(feelsLikeF)}F</p>
        )}
        {highF !== null && highF !== undefined && (
          <p>High: {Math.round(highF)}F</p>
        )}
        {description && <p>{description}</p>}
      </div>
    </div>
  );
}
