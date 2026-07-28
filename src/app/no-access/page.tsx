"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Lock } from "lucide-react";
import { moduleForPath } from "@/lib/rbac/modules";
import { useMe } from "@/lib/auth/use-me";

export default function NoAccessPage() {
  return (
    <Suspense fallback={null}>
      <NoAccessInner />
    </Suspense>
  );
}

function NoAccessInner() {
  const params = useSearchParams();
  const from = params.get("from") || "";
  const mod = from ? moduleForPath(from) : null;
  const { user } = useMe();

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-warn-tint text-warn-strong">
        <Lock size={22} strokeWidth={1.8} />
      </div>
      <h1 className="text-lg font-semibold text-ink">Access restricted</h1>
      <p className="mt-2 text-sm text-ink-2">
        {mod ? (
          <>
            Your role doesn&apos;t have access to the{" "}
            <span className="font-medium text-ink">{mod.label}</span> module.
          </>
        ) : (
          <>You don&apos;t have access to that page.</>
        )}
      </p>
      <p className="mt-1 text-xs text-ink-3">
        Ask an administrator to grant your role
        {user ? <> (&ldquo;{user.role}&rdquo;)</> : null} this module.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center rounded-md bg-green px-4 py-2 text-sm font-medium text-green-cream hover:bg-green-deep"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
