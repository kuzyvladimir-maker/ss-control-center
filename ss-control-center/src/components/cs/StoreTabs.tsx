"use client";

import { Store, ShoppingCart } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface StoreInfo {
  index: number;
  configured: boolean;
  channel: string;
  name: string;
  comingSoon?: boolean;
  error?: string;
}

interface StoreTabsProps {
  stores: StoreInfo[];
  activeStore: number;
  onSelect: (index: number) => void;
}

export default function StoreTabs({
  stores,
  activeStore,
  onSelect,
}: StoreTabsProps) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-slate-200 pb-px">
      {stores.map((store) => {
        const isActive = store.index === activeStore;
        const isDisabled = !store.configured || store.comingSoon;
        const isWalmart = store.channel === "Walmart";

        return (
          <button
            key={store.index}
            onClick={() => !isDisabled && onSelect(store.index)}
            disabled={isDisabled}
            className={`relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors rounded-t-md ${
              isActive
                ? "text-blue-600 bg-blue-50/50 border-b-2 border-blue-600"
                : isDisabled
                  ? "text-slate-300 cursor-not-allowed"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
            }`}
          >
            {isWalmart ? (
              <ShoppingCart size={14} />
            ) : (
              <Store size={14} />
            )}
            <span className="max-w-[120px] truncate">{store.name}</span>
            {store.comingSoon && (
              <Badge
                variant="secondary"
                className="text-[9px] px-1 py-0 ml-0.5"
              >
                Soon
              </Badge>
            )}
            {!store.configured && !store.comingSoon && (
              <span className="text-[9px] text-slate-300 ml-0.5">
                (not set)
              </span>
            )}
            {store.error && (
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
            )}
          </button>
        );
      })}
    </div>
  );
}
