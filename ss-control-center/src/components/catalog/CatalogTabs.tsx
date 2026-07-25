"use client";

import Link from "next/link";
import {
  Activity,
  BadgeDollarSign,
  Boxes,
  ClipboardCheck,
  Database,
  GitBranch,
  ListTree,
} from "lucide-react";

import { cn } from "@/lib/utils";

export const PRODUCT_TRUTH_CATALOG_VIEWS = [
  "overview",
  "products",
  "recipes",
  "offers",
  "runs",
  "quality",
  "readiness",
] as const;

export type ProductTruthCatalogView =
  (typeof PRODUCT_TRUTH_CATALOG_VIEWS)[number];

const TABS: Array<{
  view: ProductTruthCatalogView;
  label: string;
  hint: string;
  icon: typeof Activity;
}> = [
  {
    view: "overview",
    label: "Overview",
    hint: "Authoritative scope and coverage",
    icon: Activity,
  },
  {
    view: "products",
    label: "Products",
    hint: "Canonical variants and exact content",
    icon: Database,
  },
  {
    view: "recipes",
    label: "SKU Recipes",
    hint: "Exact listing scope to components",
    icon: ListTree,
  },
  {
    view: "offers",
    label: "Offers & COGS",
    hint: "Typed price evidence and cost",
    icon: BadgeDollarSign,
  },
  {
    view: "runs",
    label: "Queue & Runs",
    hint: "Sealed runs, budgets and blockers",
    icon: GitBranch,
  },
  {
    view: "quality",
    label: "Quality Review",
    hint: "Canonical blockers without false green",
    icon: ClipboardCheck,
  },
  {
    view: "readiness",
    label: "Consumer Readiness",
    hint: "Four independent consumer projections",
    icon: Boxes,
  },
];

export function isProductTruthCatalogView(
  value: unknown,
): value is ProductTruthCatalogView {
  return typeof value === "string"
    && PRODUCT_TRUTH_CATALOG_VIEWS.includes(value as ProductTruthCatalogView);
}

export function CatalogTabs({
  activeView,
}: {
  activeView: ProductTruthCatalogView;
}) {
  return (
    <nav
      aria-label="Product Truth catalog views"
      className="flex flex-wrap items-center gap-1 border-b border-rule"
    >
      {TABS.map((tab) => {
        const active = activeView === tab.view;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.view}
            href={`/catalog?view=${tab.view}`}
            title={tab.hint}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12.5px] font-medium transition",
              active
                ? "border-green text-green-ink"
                : "border-transparent text-ink-3 hover:border-rule hover:text-ink",
            )}
          >
            <Icon size={13} />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
