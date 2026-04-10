"use client";

interface StoreFilterProps {
  value: string;
  onChange: (value: string) => void;
}

export default function StoreFilter({ value, onChange }: StoreFilterProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
    >
      <option value="all">All Accounts</option>
      <option value="1">Salutem Solutions</option>
      <option value="2">Vladimir Personal</option>
    </select>
  );
}
