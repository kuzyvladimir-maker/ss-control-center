"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/register")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setRegistrationEnabled(data.enabled === true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRegistrationEnabled(false);
          setMode("login");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    const body =
      mode === "login"
        ? { username, password }
        : { username, password, displayName: displayName || username };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // Read body once as text, then try to parse as JSON. This way an empty
      // or non-JSON body still produces a useful error instead of swallowing
      // it as a generic "Network error".
      const rawText = await res.text();
      let data: { error?: string; ok?: boolean } = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        // non-JSON response — keep rawText for the error message below
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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">SS Control Center</h1>
          <p className="mt-1 text-sm text-gray-500">Salutem Solutions</p>
        </div>

        {/* Toggle between Login / Register */}
        <div className="mb-6 flex rounded-lg bg-gray-100 p-1">
          <button
            type="button"
            onClick={() => { setMode("login"); setError(""); }}
            className={`rounded-md py-2 text-sm font-medium transition ${
              mode === "login"
                ? "bg-white text-gray-900 shadow"
                : "text-gray-500 hover:text-gray-700"
            } ${registrationEnabled ? "flex-1" : "w-full"}`}
          >
            Sign In
          </button>
          {registrationEnabled && (
            <button
              type="button"
              onClick={() => { setMode("register"); setError(""); }}
              className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                mode === "register"
                  ? "bg-white text-gray-900 shadow"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Create Account
            </button>
          )}
        </div>

        {!registrationEnabled && (
          <p className="mb-4 text-center text-xs text-gray-500">
            Registration is disabled after the initial account is created.
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-700">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Enter username"
            />
          </div>

          {mode === "register" && registrationEnabled && (
            <div>
              <label htmlFor="displayName" className="block text-sm font-medium text-gray-700">
                Display Name <span className="text-gray-400">(optional)</span>
              </label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Vladimir"
              />
            </div>
          )}

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder={mode === "register" ? "Min 6 characters" : "Enter password"}
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
          >
            {loading
              ? mode === "login" ? "Signing in..." : "Creating account..."
              : mode === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>
      </div>
    </div>
  );
}
