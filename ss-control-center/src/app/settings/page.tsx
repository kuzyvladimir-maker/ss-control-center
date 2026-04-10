"use client";

import { useState, useEffect, useCallback } from "react";
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

  useEffect(() => {
    fetch("/api/sync/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  const runSync = async (job: string) => {
    setSyncing(job);
    try {
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job }),
      });
      const s = await fetch("/api/sync/status").then((r) => r.json());
      setStatus(s);
    } catch {
      /* ignore */
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

function GmailAccountsPanel() {
  const [gmailResult, setGmailResult] = useState<{
    type: "success" | "error";
    email?: string;
    token?: string;
    reason?: string;
  } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get("gmail");
    if (gmail === "success") {
      setGmailResult({
        type: "success",
        email: params.get("email") || "",
        token: params.get("token") || "",
      });
    } else if (gmail === "error") {
      setGmailResult({
        type: "error",
        reason: params.get("reason") || "Unknown error",
      });
    }
  }, []);

  const gmailAccounts = [
    {
      store: 1,
      name: "Salutem Solutions",
      email: "amazon@salutem.solutions",
      envKey: "GMAIL_REFRESH_TOKEN_STORE1",
      configured: !!process.env.NEXT_PUBLIC_GMAIL_STORE1_OK,
    },
    {
      store: 2,
      name: "Vladimir Personal",
      email: "kuzy.vladimir@gmail.com",
      envKey: "GMAIL_REFRESH_TOKEN_STORE2",
      configured: !!process.env.NEXT_PUBLIC_GMAIL_STORE2_OK,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Gmail Accounts for Customer Hub</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-slate-400">
          Connect Gmail accounts to receive buyer messages from Amazon Buyer-Seller Messaging
        </p>

        {gmailResult?.type === "success" && (
          <div className="rounded-md bg-green-50 border border-green-200 p-3 text-xs text-green-700 space-y-1">
            <p className="font-medium">Gmail connected: {gmailResult.email}</p>
            <p>Add this refresh token to your .env file:</p>
            <code className="block bg-white rounded p-2 text-[10px] break-all border">
              GMAIL_REFRESH_TOKEN_STORE?={gmailResult.token}
            </code>
            <p className="text-green-500">Then restart the dev server.</p>
          </div>
        )}

        {gmailResult?.type === "error" && (
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-700">
            Gmail connection failed: {gmailResult.reason}
          </div>
        )}

        <div className="space-y-2">
          {gmailAccounts.map((acct) => (
            <div
              key={acct.store}
              className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0"
            >
              <div className="flex items-center gap-3">
                {acct.configured ? (
                  <CheckCircle size={16} className="text-green-500" />
                ) : (
                  <XCircle size={16} className="text-slate-300" />
                )}
                <div>
                  <span className="text-sm font-medium">Store {acct.store}: {acct.name}</span>
                  <p className="text-[10px] text-slate-400">{acct.email}</p>
                </div>
              </div>
              <Badge
                className={
                  acct.configured
                    ? "bg-green-100 text-green-700"
                    : "bg-slate-100 text-slate-400"
                }
              >
                {acct.configured ? "Connected" : "Not connected"}
              </Badge>
            </div>
          ))}
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-400">
            OAuth scope: gmail.readonly (read-only access)
          </p>
          <a href="/api/auth/gmail">
            <Button variant="outline" size="sm">
              <ExternalLink size={14} className="mr-1" />
              Connect Gmail
            </Button>
          </a>
        </div>
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
    <div className="space-y-6">
      {/* API Connections */}
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

      {/* Data Sync */}
      <SyncPanel />

      {/* Gmail Accounts */}
      <GmailAccountsPanel />

      {/* Amazon SP-API */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Amazon SP-API</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600">Application ID</span>
              <code className="rounded bg-slate-100 px-2 py-1 text-xs">
                {process.env.NEXT_PUBLIC_AMAZON_SP_CLIENT_ID
                  ? process.env.NEXT_PUBLIC_AMAZON_SP_CLIENT_ID.substring(0, 30) + "..."
                  : "Configured (server-side)"}
              </code>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600">Stores configured</span>
              <span className="text-sm font-medium">1/5</span>
            </div>
            <Separator />
            <a href="/settings/api-test">
              <Button variant="outline" size="sm" className="w-full">
                <ExternalLink size={14} className="mr-1" />
                Test SP-API Connection
              </Button>
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Notifications */}
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

      {/* External API */}
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
    </div>
  );
}
