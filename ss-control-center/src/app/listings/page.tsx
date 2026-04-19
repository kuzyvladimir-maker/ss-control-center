"use client";
import { Tags } from "lucide-react";
import { ComingSoon } from "@/components/kit";

export default function ListingsPage() {
  return (
    <ComingSoon
      title="Product listings"
      tagline="Centralised view of every SKU across Amazon and Walmart, sourced from Sellbrite."
      icon={<Tags size={20} />}
      bullets={[
        "Live pricing, BSR, and review counts per ASIN",
        "Compare cross-marketplace listings for the same SKU",
        "Bulk edit titles, bullets, and prices through Sellbrite",
        "Flag listings missing dimensions, weight, or category tags",
      ]}
      eta="Sellbrite API connected · UI in design"
      cta={{ label: "Open Settings → Sellbrite", href: "/settings" }}
    />
  );
}
