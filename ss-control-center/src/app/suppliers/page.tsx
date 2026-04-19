"use client";
import { Package } from "lucide-react";
import { ComingSoon } from "@/components/kit";

export default function SuppliersPage() {
  return (
    <ComingSoon
      title="Suppliers"
      tagline="Track every wholesaler, their PO history, lead times, and reorder triggers in one place."
      icon={<Package size={20} />}
      bullets={[
        "Supplier directory with contact, terms, and lead time",
        "Open purchase orders with ETA + receive workflow",
        "Auto-reorder triggers based on Veeqo stock-on-hand",
        "Per-SKU sourcing history and cost trend",
      ]}
      eta="Phase 2 · planned for Q3"
    />
  );
}
