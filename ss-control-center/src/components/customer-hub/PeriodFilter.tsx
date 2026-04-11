"use client";

// Shared period picker for Customer Hub stats + losses dashboard. Value is
// the number of days; pass through to any endpoint that takes `?period=N`.
interface PeriodFilterProps {
  value: number;
  onChange: (value: number) => void;
}

const options: Array<{ label: string; value: number }> = [
  { label: "Today", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

export default function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
      className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
