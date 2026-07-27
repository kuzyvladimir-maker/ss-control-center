"use client";

// Lightweight, dependency-free toast system.
//
// The app had no toast library at all — user feedback for actions like
// "Discard Label" went into a tiny grey page-level span that was trivially
// easy to miss (and for some order states wasn't rendered anywhere). This
// gives us an unmissable, app-wide notification surface with a sonner-like
// imperative API:
//
//   import { toast } from "@/components/ui/toast";
//   toast.success("Label discarded");
//   toast.error("Something went wrong");
//   const id = toast.loading("Working…");
//   toast.success("Done", { id }); // transforms the same toast in place
//
// Mount <Toaster /> exactly once (we do it in the root layout). Toasts live
// in a module-level store so any client component can fire one without
// threading context/providers through the tree.

import * as React from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Info,
  Loader2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastKind = "success" | "error" | "info" | "loading";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
  /** ms before auto-dismiss; Infinity = sticky (used by loading). */
  duration: number;
}

type Listener = (toasts: ToastItem[]) => void;

let store: ToastItem[] = [];
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  const snapshot = [...store];
  for (const l of listeners) l(snapshot);
}

function clearTimer(id: string) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function dismiss(id: string) {
  store = store.filter((t) => t.id !== id);
  clearTimer(id);
  emit();
}

interface PushOptions {
  /** Reuse an existing toast's id to transform it in place (loading → success). */
  id?: string;
  /** Override the default auto-dismiss delay. */
  duration?: number;
}

function defaultDuration(kind: ToastKind): number {
  if (kind === "loading") return Infinity;
  if (kind === "error") return 8000;
  return 4000;
}

function push(kind: ToastKind, message: string, opts?: PushOptions): string {
  const id =
    opts?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const duration = opts?.duration ?? defaultDuration(kind);
  const item: ToastItem = { id, kind, message, duration };

  const existing = store.findIndex((t) => t.id === id);
  if (existing >= 0) {
    store = store.map((t) => (t.id === id ? item : t));
  } else {
    store = [...store, item];
  }

  clearTimer(id);
  if (duration !== Infinity) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), duration),
    );
  }
  emit();
  return id;
}

export const toast = {
  success: (message: string, opts?: PushOptions) =>
    push("success", message, opts),
  error: (message: string, opts?: PushOptions) => push("error", message, opts),
  info: (message: string, opts?: PushOptions) => push("info", message, opts),
  loading: (message: string, opts?: PushOptions) =>
    push("loading", message, opts),
  dismiss,
};

const ICONS: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 size={16} className="text-green-ink" />,
  error: <AlertTriangle size={16} className="text-danger" />,
  info: <Info size={16} className="text-ink-3" />,
  loading: <Loader2 size={16} className="animate-spin text-ink-3" />,
};

/** Mount once near the root of the app. Renders the active toasts. */
export function Toaster() {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    listeners.add(setItems);
    setItems([...store]); // sync any toasts fired before mount
    return () => {
      listeners.delete(setItems);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          aria-live={t.kind === "error" ? "assertive" : "polite"}
          className={cn(
            "pointer-events-auto flex items-start gap-2.5 rounded-lg bg-popover px-3 py-2.5 text-[13px] text-popover-foreground shadow-lg ring-1 ring-foreground/10",
          )}
        >
          <span className="mt-px shrink-0">{ICONS[t.kind]}</span>
          <span className="flex-1 leading-snug break-words">{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            className="-mr-1 shrink-0 rounded p-0.5 text-ink-3 transition-colors hover:text-ink-1"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
