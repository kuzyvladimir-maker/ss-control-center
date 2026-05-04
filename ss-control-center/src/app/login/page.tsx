"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const rawText = await res.text();
      let data: { error?: string; ok?: boolean } = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        // non-JSON — keep rawText for the error message
      }

      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }

      const message =
        data.error ||
        (rawText ? rawText.slice(0, 200) : `Server returned HTTP ${res.status}`);
      setError(message);
      setLoading(false);
    } catch (err) {
      setError(
        err instanceof Error ? `Network: ${err.message}` : "Network error"
      );
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-bg to-bg-elev">
      <div className="w-full max-w-sm rounded-2xl border border-rule bg-surface p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-ink">SS Control Center</h1>
          <p className="mt-1 text-sm text-ink-3">Salutem Solutions</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium text-ink-2"
            >
              Email
            </label>
            <input
              id="username"
              type="email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              className="mt-1 block w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-ink shadow-sm placeholder:text-ink-4 focus:border-green-mid focus:outline-none focus:ring-1 focus:ring-green-mid"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-ink-2"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="mt-1 block w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-ink shadow-sm placeholder:text-ink-4 focus:border-green-mid focus:outline-none focus:ring-1 focus:ring-green-mid"
            />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-green px-4 py-2 text-sm font-medium text-green-cream hover:bg-green-deep focus:outline-none focus:ring-2 focus:ring-green-mid focus:ring-offset-2 focus:ring-offset-surface disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-4">
          Access is invite-only. Ask an admin to send you an invitation link.
        </p>
      </div>
    </div>
  );
}
