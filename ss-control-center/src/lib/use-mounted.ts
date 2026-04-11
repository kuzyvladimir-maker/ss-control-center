"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getServerSnapshot = () => false;
const getClientSnapshot = () => true;

/**
 * Returns `false` during SSR and the first render, `true` after hydration.
 * Use this instead of the `useState(false) + useEffect(() => setMounted(true))`
 * idiom — that pattern trips the `react-hooks/set-state-in-effect` lint rule
 * and causes a cascading render on every mount.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
