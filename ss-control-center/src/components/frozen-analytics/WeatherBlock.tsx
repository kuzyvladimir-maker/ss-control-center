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
    return <CloudRain size={18} className="text-blue-500" />;
  if (d.includes("snow"))
    return <Snowflake size={18} className="text-blue-300" />;
  if (d.includes("fog"))
    return <CloudFog size={18} className="text-slate-400" />;
  if (d.includes("cloud") || d.includes("overcast"))
    return <Cloud size={18} className="text-slate-400" />;
  return <Sun size={18} className="text-amber-500" />;
}

function tempColor(tempF: number | null): string {
  if (tempF === null) return "text-slate-500";
  if (tempF >= 90) return "text-red-600 font-bold";
  if (tempF >= 85) return "text-orange-600 font-semibold";
  if (tempF >= 80) return "text-amber-600";
  if (tempF >= 75) return "text-yellow-600";
  return "text-blue-600";
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
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-400">
        <p className="font-medium text-slate-500">{label}</p>
        <p>No weather data</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        {date && <span className="text-[10px] text-slate-400">{date}</span>}
      </div>
      <div className="flex items-center gap-2">
        {weatherIcon(description || null)}
        <span className={`text-lg ${tempColor(tempF)}`}>
          {tempF !== null ? `${Math.round(tempF)}F` : "—"}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-slate-400 space-y-0.5">
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
