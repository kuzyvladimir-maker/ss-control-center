"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface InviteInfo {
  ok: boolean;
  email?: string;
  role?: string;
  expiresAt?: string;
  error?: string;
}

export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((j: InviteInfo) => {
        if (!cancelled) setInfo(j);
      })
      .catch(() => {
        if (!cancelled) setInfo({ ok: false, error: "Failed to load invite" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/auth/invite/${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password,
            displayName: displayName || undefined,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">SS Control Center</h1>
          <p className="mt-1 text-sm text-gray-500">Accept invitation</p>
        </div>

        {!info && (
          <p className="text-center text-sm text-gray-500">Loading…</p>
        )}

        {info && !info.ok && (
          <div className="rounded-md bg-red-50 px-3 py-3 text-sm text-red-700">
            {info.error || "Invalid invite"}
          </div>
        )}

        {info?.ok && (
          <form onSubmit={submit} className="space-y-4">
            <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-800">
              You were invited as <b>{info.email}</b> ({info.role}).
            </div>

            <div>
              <label
                htmlFor="displayName"
                className="block text-sm font-medium text-gray-700"
              >
                Display name <span className="text-gray-400">(optional)</span>
              </label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Min 8 characters"
              />
            </div>

            <div>
              <label
                htmlFor="confirm"
                className="block text-sm font-medium text-gray-700"
              >
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {submitting ? "Creating account…" : "Create account & sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
