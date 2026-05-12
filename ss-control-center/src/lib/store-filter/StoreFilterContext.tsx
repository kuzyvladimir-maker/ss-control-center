"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type StoreChannel = "Amazon" | "Walmart";

export interface StoreEntry {
  id: string;
  name: string;
  channel: StoreChannel;
  storeIndex: number | null;
  sellerId: string | null;
  active: boolean;
}

interface StoreFilterContextValue {
  allStores: StoreEntry[];
  selectedStoreIds: string[];
  selectedStores: StoreEntry[];
  hasAmazon: boolean;
  hasWalmart: boolean;
  isAllSelected: boolean;
  toggleStore: (id: string) => void;
  selectAll: () => void;
  clearAll: () => void;
  setSelected: (ids: string[]) => void;
  isLoading: boolean;
  error: string | null;
  // Convenience helper for any consumer building a `?storeIds=…` query.
  // Returns "" when every store is selected so callers can let the API
  // default to "all" (and skip unnecessary cache busting).
  toQueryString: () => string;
}

const StoreFilterContext = createContext<StoreFilterContextValue | null>(null);

export function StoreFilterProvider({ children }: { children: ReactNode }) {
  const [allStores, setAllStores] = useState<StoreEntry[]>([]);
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // No localStorage by design — every session starts with all stores selected.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/stores")
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data) => {
        if (cancelled) return;
        const stores: StoreEntry[] = data.stores || [];
        setAllStores(stores);
        setSelectedStoreIds(stores.map((s) => s.id));
        setIsLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleStore = useCallback((id: string) => {
    setSelectedStoreIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const selectAll = useCallback(
    () => setSelectedStoreIds(allStores.map((s) => s.id)),
    [allStores]
  );
  const clearAll = useCallback(() => setSelectedStoreIds([]), []);
  const setSelected = useCallback(
    (ids: string[]) => setSelectedStoreIds(ids),
    []
  );

  const value = useMemo<StoreFilterContextValue>(() => {
    const selectedStores = allStores.filter((s) =>
      selectedStoreIds.includes(s.id)
    );
    const hasAmazon = selectedStores.some((s) => s.channel === "Amazon");
    const hasWalmart = selectedStores.some((s) => s.channel === "Walmart");
    const isAllSelected =
      allStores.length > 0 && selectedStoreIds.length === allStores.length;
    const toQueryString = () =>
      selectedStoreIds.length === 0 || isAllSelected
        ? ""
        : `storeIds=${selectedStoreIds.join(",")}`;
    return {
      allStores,
      selectedStoreIds,
      selectedStores,
      hasAmazon,
      hasWalmart,
      isAllSelected,
      toggleStore,
      selectAll,
      clearAll,
      setSelected,
      isLoading,
      error,
      toQueryString,
    };
  }, [
    allStores,
    selectedStoreIds,
    toggleStore,
    selectAll,
    clearAll,
    setSelected,
    isLoading,
    error,
  ]);

  return (
    <StoreFilterContext.Provider value={value}>
      {children}
    </StoreFilterContext.Provider>
  );
}

export function useStoreFilter(): StoreFilterContextValue {
  const ctx = useContext(StoreFilterContext);
  if (!ctx)
    throw new Error("useStoreFilter must be used inside <StoreFilterProvider>");
  return ctx;
}
