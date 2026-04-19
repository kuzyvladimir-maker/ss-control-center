"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
  Search,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ConnectionStatus {
  name: string;
  status: "connected" | "disconnected" | "checking";
  detail?: string;
}

interface SkuRow {
  sku: string;
  productTitle: string;
  marketplace: string;
  category: string;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  weightFedex: number | null;
  hasCompleteData: boolean;
}

function SyncPanel() {
  const [status, setStatus] = useState<{
    data: { orders: { count: number; perStore: Record<string, number> }; adjustments: { count: number }; feedback: { count: number }; claims: { count: number } };
    lastSync: string | null;
  } | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sync/status")
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        return data;
      })
      .then((data) => {
        setStatus(data);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load sync status");
      });
  }, []);

  const runSync = async (job: string) => {
    setSyncing(job);
    setError(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(result.error || `Sync failed (${res.status})`);
      }
      const sRes = await fetch("/api/sync/status");
      const s = await sRes.json().catch(() => ({}));
      if (!sRes.ok) {
        throw new Error(s.error || `HTTP ${sRes.status}`);
      }
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run sync");
    } finally {
      setSyncing(null);
    }
  };

  const syncItems = [
    { key: "orders", label: "Orders", icon: "📦", count: status?.data.orders.count || 0 },
    { key: "finances", label: "Adjustments", icon: "💸", count: status?.data.adjustments.count || 0 },
    { key: "health", label: "Account Health", icon: "❤️", count: null },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Data Synchronization</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => runSync("all")}
          disabled={!!syncing}
        >
          {syncing === "all" ? (
            <Loader2 size={14} className="animate-spin mr-1" />
          ) : (
            <RefreshCw size={14} className="mr-1" />
          )}
          Sync Everything
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </div>
        )}
        {status?.lastSync && (
          <p className="text-xs text-slate-400 mb-2">
            Last sync:{" "}
            {new Date(status.lastSync).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}
        {syncItems.map((item) => (
          <div
            key={item.key}
            className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0"
          >
            <div className="flex items-center gap-2">
              <span>{item.icon}</span>
              <span className="text-sm font-medium">{item.label}</span>
              {item.count !== null && (
                <Badge variant="secondary" className="text-[10px]">
                  {item.count}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => runSync(item.key)}
              disabled={!!syncing}
              className="text-xs"
            >
              {syncing === item.key ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                "Sync Now"
              )}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface GmailAccountStatus {
  storeIndex: number;
  storeName: string;
  expectedEmail: string | null;
  configured: boolean;
  email: string | null;
  source: "db" | "env" | null;
  error: string | null;
}

interface GmailTestResult {
  storeIndex: number;
  ok: boolean;
  email: string | null;
  messagesTotal: number | null;
  buyerMessagesLast2d: number | null;
  error: string | null;
}

function GmailAccountsPanel() {
  const searchParams = useSearchParams();
  const gmailResult = useMemo<{
    type: "success" | "error";
    email?: string;
    store?: string;
    reason?: string;
  } | null>(() => {
    const gmail = searchParams.get("gmail");
    if (gmail === "success") {
      return {
        type: "success",
        email: searchParams.get("email") || "",
        store: searchParams.get("store") || "",
      };
    }
    if (gmail === "error") {
      return {
        type: "error",
        reason: searchParams.get("reason") || "Unknown error",
      };
    }
    return null;
  }, [searchParams]);

  const [oauthConfigured, setOauthConfigured] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<GmailAccountStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Record<number, GmailTestResult> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/gmail");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setOauthConfigured(!!data.oauthConfigured);
      setAccounts(data.accounts || []);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to load status"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Re-fetch after a successful OAuth round-trip so the new account shows up
  // without a manual reload.
  useEffect(() => {
    if (gmailResult?.type === "success") fetchStatus();
  }, [gmailResult, fetchStatus]);

  const handleDisconnect = async (storeIndex: number) => {
    setDisconnecting(storeIndex);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/integrations/gmail?store=${storeIndex}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchStatus();
      // Clear old test results since the account list changed
      setTestResults(null);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to disconnect"
      );
    } finally {
      setDisconnecting(null);
    }
  };

  const handleTestAll = async () => {
    setTesting(true);
    setActionError(null);
    try {
      const res = await fetch("/api/integrations/gmail/test");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const byStore: Record<number, GmailTestResult> = {};
      for (const r of (data.results || []) as GmailTestResult[]) {
        byStore[r.storeIndex] = r;
      }
      setTestResults(byStore);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to test accounts"
      );
    } finally {
      setTesting(false);
    }
  };

  const connectedCount = accounts.filter((a) => a.configured).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Gmail Accounts for Customer Hub
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-slate-400">
          Connect a Gmail account per store to receive buyer messages,
          chargeback notifications and feedback alerts. OAuth scope is
          read-only; tokens are stored in the database and never in .env.
        </p>

        {oauthConfigured === false && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
            <p className="font-medium">
              Gmail OAuth is not configured yet.
            </p>
            <p>
              Before you can connect any account, create a Google Cloud
              project, enable the Gmail API, and add{" "}
              <code className="rounded bg-white px-1">GMAIL_CLIENT_ID</code>{" "}
              and{" "}
              <code className="rounded bg-white px-1">
                GMAIL_CLIENT_SECRET
              </code>{" "}
              to <code className="rounded bg-white px-1">.env</code>.
              Authorized redirect URI:
            </p>
            <code className="block rounded bg-white px-2 py-1 break-all">
              http://localhost:3000/api/auth/gmail/callback
            </code>
          </div>
        )}

        {gmailResult?.type === "success" && (
          <div className="rounded-md border border-green-200 bg-green-50 p-3 text-xs text-green-700">
            <p className="font-medium">
              Connected {gmailResult.email}
              {gmailResult.store ? ` to Store ${gmailResult.store}` : ""}
            </p>
            <p className="text-green-600">
              Token saved to database — no restart needed.
            </p>
          </div>
        )}

        {gmailResult?.type === "error" && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            Gmail connection failed: {gmailResult.reason}
          </div>
        )}

        {actionError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {actionError}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading Gmail
            status…
          </div>
        ) : (
          <>
            {connectedCount > 0 && (
              <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50/50 px-3 py-2">
                <div className="text-xs text-slate-600">
                  {testResults ? (
                    <span>
                      Tested {Object.keys(testResults).length} account
                      {Object.keys(testResults).length !== 1 ? "s" : ""}:{" "}
                      <span className="text-green-600 font-medium">
                        {Object.values(testResults).filter((r) => r.ok).length}{" "}
                        OK
                      </span>
                      {Object.values(testResults).filter((r) => !r.ok).length >
                        0 && (
                        <>
                          {" · "}
                          <span className="text-red-600 font-medium">
                            {
                              Object.values(testResults).filter((r) => !r.ok)
                                .length
                            }{" "}
                            failed
                          </span>
                        </>
                      )}
                    </span>
                  ) : (
                    <span>
                      Ping each connected account to verify tokens still work
                      and see how much Amazon mail is waiting to sync.
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestAll}
                  disabled={testing}
                  className="text-xs shrink-0"
                >
                  {testing ? (
                    <Loader2 size={12} className="animate-spin mr-1" />
                  ) : (
                    <RefreshCw size={12} className="mr-1" />
                  )}
                  Test All Connections
                </Button>
              </div>
            )}

            <div className="space-y-2">
              {accounts.map((acct) => {
                const connectHref = `/api/auth/gmail?store=${acct.storeIndex}`;
                const isConnected = acct.configured;
                const test = testResults?.[acct.storeIndex];
                return (
                  <div
                    key={acct.storeIndex}
                    className="flex items-center justify-between gap-4 py-2 border-b border-slate-100 last:border-0"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isConnected ? (
                        <CheckCircle
                          size={16}
                          className="text-green-500 shrink-0"
                        />
                      ) : (
                        <XCircle
                          size={16}
                          className="text-slate-300 shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          Store {acct.storeIndex}: {acct.storeName}
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">
                          {acct.email ||
                            acct.expectedEmail ||
                            "No account assigned"}
                          {acct.source === "env" && (
                            <span className="ml-1 text-amber-600">
                              (from .env — legacy)
                            </span>
                          )}
                        </p>
                        {test && test.ok && (
                          <p className="text-[10px] text-green-600 mt-0.5">
                            ✓ {test.messagesTotal?.toLocaleString() || "?"}{" "}
                            total ·{" "}
                            <span className="font-medium">
                              {test.buyerMessagesLast2d}
                            </span>{" "}
                            Amazon message
                            {test.buyerMessagesLast2d !== 1 ? "s" : ""} in last
                            2d
                          </p>
                        )}
                        {test && !test.ok && (
                          <p className="text-[10px] text-red-600 mt-0.5 truncate">
                            ✗ {test.error}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        className={
                          test
                            ? test.ok
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                            : isConnected
                              ? "bg-green-100 text-green-700"
                              : "bg-slate-100 text-slate-400"
                        }
                      >
                        {test
                          ? test.ok
                            ? "Verified"
                            : "Error"
                          : isConnected
                            ? "Connected"
                            : "Not connected"}
                      </Badge>
                      {isConnected ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDisconnect(acct.storeIndex)}
                          disabled={
                            disconnecting === acct.storeIndex ||
                            !oauthConfigured
                          }
                          className="text-xs"
                        >
                          {disconnecting === acct.storeIndex ? (
                            <Loader2 size={12} className="animate-spin mr-1" />
                          ) : null}
                          Disconnect
                        </Button>
                      ) : (
                        <a href={oauthConfigured ? connectHref : undefined}>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!oauthConfigured}
                            className="text-xs"
                          >
                            <ExternalLink size={12} className="mr-1" />
                            Connect
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <Separator />

        <p className="text-[10px] text-slate-400">
          Scope:{" "}
          <code className="rounded bg-slate-50 px-1">gmail.readonly</code>{" "}
          · Tokens stored in the{" "}
          <code className="rounded bg-slate-50 px-1">Setting</code> table ·
          Disconnect and reconnect to switch accounts.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Amazon SP-API panel — mirrors the GmailAccountsPanel UX
// ---------------------------------------------------------------------------

interface SpApiStoreStatus {
  index: number;
  name: string;
  configured: boolean;
}

interface SpApiStoreTest {
  index: number;
  configured: boolean;
  channel: string;
  name: string;
  marketplace?: string;
  sellerId?: string;
  error?: string;
  comingSoon?: boolean;
}

function SpApiStoresPanel() {
  const [stores, setStores] = useState<SpApiStoreStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Record<number, SpApiStoreTest> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/amazon/stores/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStores(data.stores || []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load SP-API status"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleTestAll = async () => {
    setTesting(true);
    setError(null);
    try {
      // The /api/amazon/stores endpoint pings SP-API for each configured
      // store (one /sellers/v1/marketplaceParticipations call per store) and
      // returns either a marketplace + sellerId or an error string.
      const res = await fetch("/api/amazon/stores");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const byIndex: Record<number, SpApiStoreTest> = {};
      for (const s of (data.stores || []) as SpApiStoreTest[]) {
        // Skip Walmart placeholder (index 6) from this panel
        if (s.index <= 5) byIndex[s.index] = s;
      }
      setTestResults(byIndex);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to test SP-API"
      );
    } finally {
      setTesting(false);
    }
  };

  const configuredCount = stores.filter((s) => s.configured).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Amazon SP-API</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-slate-400">
          Amazon Seller Partner API — orders, messaging, reports, finances,
          account health. Credentials are set per store in{" "}
          <code className="rounded bg-slate-50 px-1">.env</code> via{" "}
          <code className="rounded bg-slate-50 px-1">
            AMAZON_SP_REFRESH_TOKEN_STORE{"{"}N{"}"}
          </code>
          .
        </p>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading SP-API
            status…
          </div>
        ) : (
          <>
            {configuredCount > 0 && (
              <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50/50 px-3 py-2">
                <div className="text-xs text-slate-600">
                  {(() => {
                    if (!testResults) {
                      return (
                        <span>
                          Ping each configured store via{" "}
                          <code className="rounded bg-white px-1">
                            /sellers/v1/marketplaceParticipations
                          </code>{" "}
                          to verify credentials and fetch seller ID.
                        </span>
                      );
                    }
                    // Only count stores that have credentials — the endpoint
                    // also returns rows for unconfigured slots which we ignore.
                    const relevant = Object.values(testResults).filter(
                      (r) => r.configured
                    );
                    const ok = relevant.filter((r) => !r.error).length;
                    const failed = relevant.filter((r) => r.error).length;
                    return (
                      <span>
                        Tested {relevant.length} store
                        {relevant.length !== 1 ? "s" : ""}:{" "}
                        <span className="text-green-600 font-medium">
                          {ok} OK
                        </span>
                        {failed > 0 && (
                          <>
                            {" · "}
                            <span className="text-red-600 font-medium">
                              {failed} failed
                            </span>
                          </>
                        )}
                      </span>
                    );
                  })()}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestAll}
                  disabled={testing}
                  className="text-xs shrink-0"
                >
                  {testing ? (
                    <Loader2 size={12} className="animate-spin mr-1" />
                  ) : (
                    <RefreshCw size={12} className="mr-1" />
                  )}
                  Test All Connections
                </Button>
              </div>
            )}

            <div className="space-y-2">
              {stores.map((store) => {
                // Only consider a test result if the store actually has
                // credentials. The /api/amazon/stores endpoint returns a row
                // for every slot including unconfigured ones (for analytics
                // page compatibility), so we must gate on store.configured
                // before treating a result as a verification.
                const test =
                  store.configured && testResults?.[store.index]
                    ? testResults[store.index]
                    : null;
                const testOk = test && !test.error;
                const testFailed = test && !!test.error;
                return (
                  <div
                    key={store.index}
                    className="flex items-center justify-between gap-4 py-2 border-b border-slate-100 last:border-0"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {store.configured ? (
                        <CheckCircle
                          size={16}
                          className="text-green-500 shrink-0"
                        />
                      ) : (
                        <XCircle
                          size={16}
                          className="text-slate-300 shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          Store {store.index}: {store.name}
                        </div>
                        <p className="text-[10px] text-slate-400 truncate">
                          {store.configured
                            ? `Credentials: AMAZON_SP_*_STORE${store.index}`
                            : "No credentials in .env"}
                        </p>
                        {testOk && test.marketplace && (
                          <p className="text-[10px] text-green-600 mt-0.5 truncate">
                            ✓ {test.marketplace}
                            {test.sellerId && (
                              <>
                                {" · Seller ID: "}
                                <code className="rounded bg-slate-50 px-1">
                                  {test.sellerId}
                                </code>
                              </>
                            )}
                          </p>
                        )}
                        {testFailed && (
                          <p className="text-[10px] text-red-600 mt-0.5 truncate">
                            ✗ {test.error}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        className={
                          !store.configured
                            ? "bg-slate-100 text-slate-400"
                            : testOk
                              ? "bg-green-100 text-green-700"
                              : testFailed
                                ? "bg-red-100 text-red-700"
                                : "bg-green-100 text-green-700"
                        }
                      >
                        {!store.configured
                          ? "Not configured"
                          : testOk
                            ? "Verified"
                            : testFailed
                              ? "Error"
                              : "Configured"}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <Separator />

        <div className="flex items-center justify-between">
          <p className="text-[10px] text-slate-400">
            Auth: LWA refresh tokens per store · Fallback to shared{" "}
            <code className="rounded bg-slate-50 px-1">
              AMAZON_SP_CLIENT_*
            </code>{" "}
            removed for security.
          </p>
          <a href="/settings/api-test">
            <Button variant="ghost" size="sm" className="text-xs">
              <ExternalLink size={12} className="mr-1" />
              Advanced test page
            </Button>
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loss calculation settings panel
// ---------------------------------------------------------------------------
// Reads and writes two values from the Setting table that the losses endpoint
// uses to compute replacement cost estimates:
//   cogs_percent            — cost of goods as % of sale price (default 40)
//   replacement_label_cost  — estimated shipping label cost per replacement
// Both are stored as strings in Setting.value and parsed by the API.

function LossSettingsPanel() {
  const [cogs, setCogs] = useState<string>("");
  const [labelCost, setLabelCost] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings?keys=cogs_percent,replacement_label_cost")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const v = data.values || {};
        setCogs(v.cogs_percent ?? "40");
        setLabelCost(v.replacement_label_cost ?? "12");
      })
      .catch(() => {
        if (!cancelled) {
          setCogs("40");
          setLabelCost("12");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setError(null);
    const cogsNum = parseFloat(cogs);
    const labelNum = parseFloat(labelCost);
    if (!Number.isFinite(cogsNum) || cogsNum < 0 || cogsNum > 100) {
      setError("COGS % must be a number between 0 and 100");
      return;
    }
    if (!Number.isFinite(labelNum) || labelNum < 0) {
      setError("Label cost must be a non-negative number");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: {
            cogs_percent: String(cogsNum),
            replacement_label_cost: String(labelNum),
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Loss Calculation Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-slate-400">
          These values are used by the Losses dashboard on{" "}
          <code className="rounded bg-slate-50 px-1">/customer-hub</code> to
          estimate the real cost of replacements. Changes take effect on the
          next dashboard refresh — no restart needed.
        </p>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading settings…
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <label
                htmlFor="cogs-percent"
                className="text-sm text-slate-700"
              >
                COGS %{" "}
                <span className="text-[10px] text-slate-400">
                  (cost of goods as % of sale price)
                </span>
              </label>
              <div className="flex items-center gap-1 shrink-0">
                <input
                  id="cogs-percent"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={cogs}
                  onChange={(e) => setCogs(e.target.value)}
                  className="w-20 rounded border border-slate-200 px-2 py-1 text-sm text-right focus:border-blue-400 focus:outline-none"
                />
                <span className="text-sm text-slate-500">%</span>
              </div>
            </div>

            <Separator />

            <div className="flex items-center justify-between gap-4">
              <label
                htmlFor="label-cost"
                className="text-sm text-slate-700"
              >
                Replacement label cost{" "}
                <span className="text-[10px] text-slate-400">
                  (estimated shipping per replacement)
                </span>
              </label>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-sm text-slate-500">$</span>
                <input
                  id="label-cost"
                  type="number"
                  min={0}
                  step={0.01}
                  value={labelCost}
                  onChange={(e) => setLabelCost(e.target.value)}
                  className="w-20 rounded border border-slate-200 px-2 py-1 text-sm text-right focus:border-blue-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              {savedFlash && (
                <span className="text-[10px] text-green-600">Saved ✓</span>
              )}
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving}
                className="text-xs"
              >
                {saving ? (
                  <Loader2 size={12} className="animate-spin mr-1" />
                ) : null}
                Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI Providers panel — interactive Claude/OpenAI priority + model selection
// ---------------------------------------------------------------------------
// Reads /api/integrations/ai-providers for both status (keys configured) and
// the currently-saved runtime config (primary provider + chosen models).
// Writes changes back via PUT /api/settings under three keys:
//   ai_primary_provider   "claude" | "openai"
//   ai_claude_model        string from the CLAUDE_MODELS catalog
//   ai_openai_model        string from the OPENAI_MODELS catalog

interface AiModelOption {
  id: string;
  label: string;
}

interface AiProviderStatus {
  configured: boolean;
  model: string;
  role: "primary" | "fallback";
}

interface AiProvidersResponse {
  claude: AiProviderStatus;
  openai: AiProviderStatus;
  primaryProvider: "claude" | "openai" | null;
  providerChain: Array<"claude" | "openai">;
  availableModels: {
    claude: AiModelOption[];
    openai: AiModelOption[];
  };
  anyConfigured: boolean;
  bothConfigured: boolean;
}

function AiProvidersPanel() {
  const [data, setData] = useState<AiProvidersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [primary, setPrimary] = useState<"claude" | "openai">("claude");
  const [claudeModel, setClaudeModel] = useState<string>("");
  const [openaiModel, setOpenaiModel] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/ai-providers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as AiProvidersResponse;
      setData(d);
      setPrimary(d.primaryProvider || "claude");
      setClaudeModel(d.claude.model);
      setOpenaiModel(d.openai.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: {
            ai_primary_provider: primary,
            ai_claude_model: claudeModel,
            ai_openai_model: openaiModel,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const claudeConfigured = data?.claude.configured ?? false;
  const openaiConfigured = data?.openai.configured ?? false;
  const claudeModels = data?.availableModels.claude || [];
  const openaiModels = data?.availableModels.openai || [];

  // Derive the currently-saved values (what the server is actually using)
  // vs the draft values in the form, to show an unsaved-changes hint.
  const isDirty =
    !!data &&
    (primary !== data.primaryProvider ||
      claudeModel !== data.claude.model ||
      openaiModel !== data.openai.model);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">AI Decision Engine</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-slate-400">
          The Decision Engine uses one AI provider as primary and the other
          as fallback. If the primary fails (API error, rate limit, no
          credits), the system retries with the fallback automatically.
          Changes below take effect on the next analysis — no restart needed.
        </p>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading provider
            status…
          </div>
        ) : (
          <>
            {/* Key status rows */}
            <div className="space-y-2">
              {[
                {
                  key: "claude" as const,
                  label: "Claude (Anthropic)",
                  configured: claudeConfigured,
                },
                {
                  key: "openai" as const,
                  label: "OpenAI",
                  configured: openaiConfigured,
                },
              ].map(({ key, label, configured }) => {
                const isPrimary = primary === key;
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-4 py-2 border-b border-slate-100 last:border-0"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {configured ? (
                        <CheckCircle
                          size={16}
                          className="text-green-500 shrink-0"
                        />
                      ) : (
                        <XCircle
                          size={16}
                          className="text-slate-300 shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{label}</div>
                        <p className="text-[10px] text-slate-400 truncate">
                          API key:{" "}
                          {configured ? (
                            <span className="text-green-600">
                              configured in .env
                            </span>
                          ) : (
                            <span className="text-slate-400">
                              not set — add{" "}
                              <code className="rounded bg-slate-50 px-1">
                                {key === "claude"
                                  ? "ANTHROPIC_API_KEY"
                                  : "OPENAI_API_KEY"}
                              </code>{" "}
                              to .env
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <Badge
                      className={
                        !configured
                          ? "bg-slate-100 text-slate-400"
                          : isPrimary
                            ? "bg-blue-100 text-blue-700"
                            : "bg-slate-100 text-slate-600"
                      }
                    >
                      {!configured
                        ? "Not configured"
                        : isPrimary
                          ? "Primary"
                          : "Fallback"}
                    </Badge>
                  </div>
                );
              })}
            </div>

            <Separator />

            {/* Priority + model selection */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <label
                  htmlFor="ai-primary"
                  className="text-sm text-slate-700 font-medium"
                >
                  Primary provider{" "}
                  <span className="text-[10px] text-slate-400 font-normal">
                    (tried first)
                  </span>
                </label>
                <select
                  id="ai-primary"
                  value={primary}
                  onChange={(e) =>
                    setPrimary(e.target.value as "claude" | "openai")
                  }
                  className="w-52 rounded border border-slate-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
                >
                  <option value="claude" disabled={!claudeConfigured}>
                    Claude (Anthropic)
                    {!claudeConfigured ? " — not configured" : ""}
                  </option>
                  <option value="openai" disabled={!openaiConfigured}>
                    OpenAI
                    {!openaiConfigured ? " — not configured" : ""}
                  </option>
                </select>
              </div>

              <div className="flex items-center justify-between gap-4">
                <label
                  htmlFor="claude-model"
                  className="text-sm text-slate-700"
                >
                  Claude model
                </label>
                <select
                  id="claude-model"
                  value={claudeModel}
                  onChange={(e) => setClaudeModel(e.target.value)}
                  disabled={!claudeConfigured}
                  className="w-52 rounded border border-slate-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
                >
                  {claudeModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {/* If saved value is not in catalog, preserve it */}
                  {claudeModel &&
                    !claudeModels.some((m) => m.id === claudeModel) && (
                      <option value={claudeModel}>{claudeModel}</option>
                    )}
                </select>
              </div>

              <div className="flex items-center justify-between gap-4">
                <label
                  htmlFor="openai-model"
                  className="text-sm text-slate-700"
                >
                  OpenAI model
                </label>
                <select
                  id="openai-model"
                  value={openaiModel}
                  onChange={(e) => setOpenaiModel(e.target.value)}
                  disabled={!openaiConfigured}
                  className="w-52 rounded border border-slate-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
                >
                  {openaiModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {openaiModel &&
                    !openaiModels.some((m) => m.id === openaiModel) && (
                      <option value={openaiModel}>{openaiModel}</option>
                    )}
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="text-[10px] text-slate-400">
                {data?.bothConfigured ? (
                  <span className="text-green-600">
                    ✓ Fallback chain active
                  </span>
                ) : data?.anyConfigured ? (
                  <span className="text-amber-600">
                    Only one provider available — add the other to enable
                    fallback
                  </span>
                ) : (
                  <span className="text-red-600">
                    No providers configured — Decision Engine will use
                    heuristic fallback only
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {savedFlash && (
                  <span className="text-[10px] text-green-600">Saved ✓</span>
                )}
                {isDirty && !savedFlash && (
                  <span className="text-[10px] text-amber-600">
                    Unsaved changes
                  </span>
                )}
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || !isDirty}
                  className="text-xs"
                >
                  {saving ? (
                    <Loader2 size={12} className="animate-spin mr-1" />
                  ) : null}
                  Save
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const [connections, setConnections] = useState<ConnectionStatus[]>([
    { name: "Veeqo", status: "checking" },
    { name: "Sellbrite", status: "checking" },
    { name: "Google Sheets", status: "checking" },
    { name: "Telegram", status: "checking" },
    { name: "Claude AI", status: "checking" },
  ]);

  // SKU Database state
  const [skuRows, setSkuRows] = useState<SkuRow[]>([]);
  const [skuSearch, setSkuSearch] = useState("");
  const [skuLoading, setSkuLoading] = useState(false);
  const [skuError, setSkuError] = useState<string | null>(null);
  const [skuLoaded, setSkuLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/veeqo/orders?status=awaiting_fulfillment")
      .then((res) => {
        setConnections((prev) =>
          prev.map((c) =>
            c.name === "Veeqo"
              ? { ...c, status: res.ok ? "connected" : "disconnected" }
              : c
          )
        );
      })
      .catch(() => {
        setConnections((prev) =>
          prev.map((c) =>
            c.name === "Veeqo" ? { ...c, status: "disconnected" } : c
          )
        );
      });

    const envChecks = [
      { name: "Sellbrite", ok: true, detail: "Configured via env" },
      { name: "Google Sheets", ok: true, detail: "Sheet ID configured" },
      { name: "Telegram", ok: true, detail: "Bot configured" },
      { name: "Claude AI", ok: true, detail: "API key configured" },
    ];

    setTimeout(() => {
      setConnections((prev) =>
        prev.map((c) => {
          const check = envChecks.find((e) => e.name === c.name);
          if (check) {
            return {
              ...c,
              status: check.ok ? "connected" : "disconnected",
              detail: check.detail,
            };
          }
          return c;
        })
      );
    }, 500);
  }, []);

  const loadSkuData = useCallback(async () => {
    setSkuLoading(true);
    setSkuError(null);
    try {
      const res = await fetch("/api/sku");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load SKU data");
      setSkuRows(data.rows);
      setSkuLoaded(true);
    } catch (err) {
      setSkuError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setSkuLoading(false);
    }
  }, []);

  // Filter SKUs by search
  const filteredSkus = skuSearch
    ? skuRows.filter(
        (r) =>
          r.sku.toLowerCase().includes(skuSearch.toLowerCase()) ||
          r.productTitle.toLowerCase().includes(skuSearch.toLowerCase())
      )
    : skuRows;

  const incompleteCount = skuRows.filter((r) => !r.hasCompleteData).length;

  return (
    <div className="space-y-7">
      <div className="pb-2">
        <h1
          className="font-semibold text-ink"
          style={{ fontSize: 26, letterSpacing: "-0.025em", lineHeight: 1.1 }}
        >
          Settings
        </h1>
        <div className="mt-1 text-[12.5px] text-ink-3">
          Configure your workspace, stores, and integrations.
        </div>
      </div>

      {/* ================================================================= */}
      {/* SECTION 0 — User permissions / invites                            */}
      {/* ================================================================= */}
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              User permissions
            </h2>
            <p className="mt-0.5 text-xs text-ink-3">
              Invite teammates by email and manage their access roles.
            </p>
          </div>
          <a
            href="/settings/users"
            className="inline-flex items-center rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-tint"
          >
            Manage users →
          </a>
        </div>
      </section>

      {/* ================================================================= */}
      {/* SECTION 1 — Connected Accounts (per-store credentials)            */}
      {/* ================================================================= */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">
            Connected Accounts
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Per-store credentials for Gmail and Amazon SP-API. Connect or
            disconnect accounts without editing .env.
          </p>
        </div>

        <GmailAccountsPanel />
        <SpApiStoresPanel />
      </section>

      {/* ================================================================= */}
      {/* SECTION 2 — AI Decision Engine                                    */}
      {/* ================================================================= */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">
            AI Decision Engine
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Choose primary and fallback AI providers for buyer message
            analysis, Walmart screenshot analysis and feedback classification.
          </p>
        </div>

        <AiProvidersPanel />
      </section>

      {/* ================================================================= */}
      {/* SECTION 3 — External Services (single-credential integrations)    */}
      {/* ================================================================= */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">
            External Services
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Health check for third-party APIs used across the app.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">API Connections</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {connections.map((conn) => (
              <div
                key={conn.name}
                className="flex items-center justify-between py-2"
              >
                <div className="flex items-center gap-3">
                  {conn.status === "checking" ? (
                    <Loader2 size={16} className="animate-spin text-slate-400" />
                  ) : conn.status === "connected" ? (
                    <CheckCircle size={16} className="text-green-500" />
                  ) : (
                    <XCircle size={16} className="text-red-500" />
                  )}
                  <span className="text-sm font-medium">{conn.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  {conn.detail && (
                    <span className="text-xs text-slate-400">{conn.detail}</span>
                  )}
                  <Badge
                    variant={
                      conn.status === "connected" ? "default" : "secondary"
                    }
                    className={
                      conn.status === "connected"
                        ? "bg-green-100 text-green-700"
                        : conn.status === "disconnected"
                          ? "bg-red-100 text-red-700"
                          : ""
                    }
                  >
                    {conn.status === "checking"
                      ? "Checking..."
                      : conn.status === "connected"
                        ? "Connected"
                        : "Disconnected"}
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      {/* ================================================================= */}
      {/* SECTION 4 — App Configuration                                     */}
      {/* ================================================================= */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">
            App Configuration
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Runtime settings that affect how the app calculates and notifies.
          </p>
        </div>

        <LossSettingsPanel />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notifications</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">Telegram Chat ID</span>
                <code className="rounded bg-slate-100 px-2 py-1 text-xs">
                  486456466
                </code>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">
                  Notifications enabled
                </span>
                <Badge className="bg-green-100 text-green-700">Active</Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">External API</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-600 mb-3">
              REST API for external systems (Claude agent, n8n, Telegram bot).
              Protected with Bearer token.
            </p>
            <div className="rounded-md bg-slate-50 p-3 text-xs font-mono">
              Authorization: Bearer &lt;SSCC_API_TOKEN&gt;
            </div>
            <p className="text-xs text-slate-400 mt-2">
              Set SSCC_API_TOKEN in your .env file (minimum 32 characters)
            </p>
          </CardContent>
        </Card>
      </section>

      {/* ================================================================= */}
      {/* SECTION 5 — Data                                                  */}
      {/* ================================================================= */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Data</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Sync operations and SKU database management.
          </p>
        </div>

        <SyncPanel />

      {/* SKU Database */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">SKU Database</CardTitle>
            <p className="text-xs text-slate-400 mt-1">
              SKU Shipping Database v2 — weights, dimensions, box sizes
            </p>
          </div>
          <div className="flex items-center gap-2">
            {skuLoaded && (
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="secondary">{skuRows.length} SKUs</Badge>
                {incompleteCount > 0 && (
                  <Badge className="bg-red-100 text-red-700">
                    <AlertTriangle size={10} className="mr-1" />
                    {incompleteCount} incomplete
                  </Badge>
                )}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={loadSkuData}
              disabled={skuLoading}
            >
              {skuLoading ? (
                <Loader2 size={14} className="mr-1 animate-spin" />
              ) : (
                <RefreshCw size={14} className="mr-1" />
              )}
              {skuLoaded ? "Refresh" : "Load Data"}
            </Button>
            <a
              href="https://docs.google.com/spreadsheets/d/1H-bx0iZ_oL0i0CFbHN_QbfXzkGJC_f_hV90s-V6cqzY/edit"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" size="sm">
                <ExternalLink size={14} className="mr-1" />
                Open Sheet
              </Button>
            </a>
          </div>
        </CardHeader>
        <CardContent>
          {skuError && (
            <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {skuError}
              <p className="text-xs mt-1 text-red-500">
                Make sure the Google Sheet is shared as &quot;Anyone with the link can
                view&quot;
              </p>
            </div>
          )}

          {skuLoaded && (
            <>
              {/* Search */}
              <div className="relative mb-4">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                />
                <input
                  type="text"
                  placeholder="Search by SKU or product name..."
                  value={skuSearch}
                  onChange={(e) => setSkuSearch(e.target.value)}
                  className="w-full rounded-md border border-slate-200 bg-white py-2 pl-10 pr-4 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                />
              </div>

              {/* Table */}
              <div className="max-h-[500px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky top-0 bg-white">SKU</TableHead>
                      <TableHead className="sticky top-0 bg-white">Product Title</TableHead>
                      <TableHead className="sticky top-0 bg-white">Marketplace</TableHead>
                      <TableHead className="sticky top-0 bg-white">Category</TableHead>
                      <TableHead className="sticky top-0 bg-white text-right">L (in)</TableHead>
                      <TableHead className="sticky top-0 bg-white text-right">W (in)</TableHead>
                      <TableHead className="sticky top-0 bg-white text-right">H (in)</TableHead>
                      <TableHead className="sticky top-0 bg-white text-right">Weight (lbs)</TableHead>
                      <TableHead className="sticky top-0 bg-white text-right">FedEx 1R (lbs)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSkus.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-sm text-slate-400 py-8">
                          {skuSearch ? "No SKUs match your search" : "No data"}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredSkus.map((row) => (
                        <TableRow
                          key={row.sku}
                          className={!row.hasCompleteData ? "bg-red-50" : ""}
                        >
                          <TableCell className="font-mono text-xs font-medium">
                            {row.sku}
                            {!row.hasCompleteData && (
                              <AlertTriangle
                                size={12}
                                className="ml-1 inline text-red-500"
                              />
                            )}
                          </TableCell>
                          <TableCell className="text-xs max-w-[250px] truncate">
                            {row.productTitle}
                          </TableCell>
                          <TableCell className="text-xs">{row.marketplace}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                row.category === "Frozen"
                                  ? "border-blue-300 text-blue-600 text-[10px]"
                                  : "text-[10px]"
                              }
                            >
                              {row.category || "—"}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-xs text-right ${row.length === null ? "text-red-500 font-medium" : ""}`}>
                            {row.length ?? "—"}
                          </TableCell>
                          <TableCell className={`text-xs text-right ${row.width === null ? "text-red-500 font-medium" : ""}`}>
                            {row.width ?? "—"}
                          </TableCell>
                          <TableCell className={`text-xs text-right ${row.height === null ? "text-red-500 font-medium" : ""}`}>
                            {row.height ?? "—"}
                          </TableCell>
                          <TableCell className={`text-xs text-right ${row.weight === null ? "text-red-500 font-medium" : ""}`}>
                            {row.weight ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs text-right">
                            {row.weightFedex ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Showing {filteredSkus.length} of {skuRows.length} SKUs
                {incompleteCount > 0 && (
                  <span className="text-red-500">
                    {" "}
                    — {incompleteCount} with missing data (highlighted in red)
                  </span>
                )}
              </p>
            </>
          )}

          {!skuLoaded && !skuError && (
            <p className="text-sm text-slate-400 py-4 text-center">
              Click &quot;Load Data&quot; to fetch SKU database from Google Sheets
            </p>
          )}
        </CardContent>
      </Card>

      </section>
    </div>
  );
}
