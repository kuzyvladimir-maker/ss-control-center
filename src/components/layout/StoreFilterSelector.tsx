"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { cn } from "@/lib/utils";

/**
 * Multi-select store filter used in the sidebar. Drives the global
 * {@link useStoreFilter} state — all Dashboard data updates live as the
 * user toggles checkboxes.
 *
 * Selection is intentionally not persisted: every session starts with all
 * stores selected (see StoreFilterContext for the rationale).
 */
export function StoreFilterSelector() {
  const {
    allStores,
    selectedStoreIds,
    selectedStores,
    isAllSelected,
    toggleStore,
    selectAll,
    clearAll,
    isLoading,
  } = useStoreFilter();

  const [open, setOpen] = useState(false);

  const amazonStores = allStores.filter((s) => s.channel === "Amazon");
  const walmartStores = allStores.filter((s) => s.channel === "Walmart");

  // Trigger label varies with selection size so the sidebar pill always
  // shows the most informative summary at a glance.
  let triggerLabel: string;
  let triggerBadge: number | null = null;
  if (isLoading) {
    triggerLabel = "Loading…";
  } else if (selectedStoreIds.length === 0) {
    triggerLabel = "No stores";
    triggerBadge = 0;
  } else if (selectedStoreIds.length === 1) {
    triggerLabel = selectedStores[0].name;
  } else if (isAllSelected) {
    triggerLabel = "All stores";
    triggerBadge = allStores.length;
  } else {
    triggerLabel = `${selectedStoreIds.length} of ${allStores.length} stores`;
  }

  // Master "All stores" checkbox state — boolean checked OR indeterminate
  // when only some are selected. base-ui's Checkbox uses separate props.
  const masterChecked = isAllSelected;
  const masterIndeterminate =
    selectedStoreIds.length > 0 && selectedStoreIds.length < allStores.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Select stores"
        className={cn(
          "flex w-full items-center gap-2 rounded-md border border-rule bg-surface-tint px-2.5 py-1.5 text-[12px] text-ink",
          "transition-colors hover:bg-bg-elev hover:border-silver-line",
          open && "border-silver-line bg-bg-elev"
        )}
      >
        <span className="live-dot" />
        <span className="flex-1 truncate text-left">{triggerLabel}</span>
        {triggerBadge !== null && (
          <span className="rounded bg-bg-elev px-1.5 text-[10px] font-semibold text-ink-2 tabular">
            {triggerBadge}
          </span>
        )}
        <ChevronDown
          size={13}
          className={cn(
            "text-ink-3 transition-transform",
            open && "rotate-180"
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[260px] gap-0 p-0 border border-rule rounded-md bg-surface"
      >
        {/* Master row */}
        <button
          type="button"
          onClick={() => (isAllSelected ? clearAll() : selectAll())}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-2",
            "text-[12.5px] font-medium text-ink",
            "hover:bg-surface-tint"
          )}
        >
          <Checkbox
            checked={masterChecked}
            indeterminate={masterIndeterminate}
            onCheckedChange={() =>
              isAllSelected ? clearAll() : selectAll()
            }
          />
          <span className="flex-1 text-left">All stores</span>
          <span className="text-[11px] font-mono text-ink-3 tabular">
            {allStores.length}
          </span>
        </button>

        <Separator className="bg-rule" />

        <ScrollArea className="max-h-[320px]">
          <div className="py-1.5">
            {amazonStores.length > 0 && (
              <>
                <SectionLabel>Amazon</SectionLabel>
                {amazonStores.map((store) => (
                  <StoreRow
                    key={store.id}
                    name={store.name}
                    checked={selectedStoreIds.includes(store.id)}
                    onToggle={() => toggleStore(store.id)}
                  />
                ))}
              </>
            )}
            {walmartStores.length > 0 && (
              <>
                <SectionLabel className={amazonStores.length > 0 ? "mt-1.5" : ""}>
                  Walmart
                </SectionLabel>
                {walmartStores.map((store) => (
                  <StoreRow
                    key={store.id}
                    name={store.name}
                    checked={selectedStoreIds.includes(store.id)}
                    onToggle={() => toggleStore(store.id)}
                  />
                ))}
              </>
            )}
            {allStores.length === 0 && !isLoading && (
              <div className="px-3 py-2 text-[12px] text-ink-3">
                No stores configured.
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-3 pb-1 pt-1.5 text-[10px] font-mono uppercase tracking-[0.14em] text-ink-3",
        className
      )}
    >
      {children}
    </div>
  );
}

function StoreRow({
  name,
  checked,
  onToggle,
}: {
  name: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left",
        "text-[12.5px] text-ink",
        "hover:bg-surface-tint"
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <span className="truncate flex-1">{name}</span>
    </button>
  );
}
