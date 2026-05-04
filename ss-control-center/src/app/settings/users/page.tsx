"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Trash2,
  Copy,
  Check,
  UserPlus,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface UserItem {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  createdAt: string;
}

interface InviteItem {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  link: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

interface MeResponse {
  user?: { id: string; role: string };
}

export default function UsersSettingsPage() {
  const [me, setMe] = useState<MeResponse["user"] | null>(null);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"member" | "admin">("member");
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setPageError(null);
    try {
      const [meRes, usersRes, invitesRes] = await Promise.all([
        fetch("/api/auth/me"),
        fetch("/api/admin/users"),
        fetch("/api/admin/invites"),
      ]);
      if (meRes.status === 401) {
        setPageError("Not signed in");
        setLoading(false);
        return;
      }
      const meJ = await meRes.json();
      setMe(meJ.user);
      if (usersRes.status === 403 || invitesRes.status === 403) {
        setPageError("Admin permission required");
        setLoading(false);
        return;
      }
      const usersJ = await usersRes.json();
      const invitesJ = await invitesRes.json();
      setUsers(usersJ.items ?? []);
      setInvites(invitesJ.items ?? []);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail.trim(), role: newRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(data.error || `HTTP ${res.status}`);
        setCreating(false);
        return;
      }
      setNewEmail("");
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Network error");
    } finally {
      setCreating(false);
    }
  }

  async function revokeInvite(id: string) {
    if (!confirm("Revoke this invite?")) return;
    const res = await fetch(`/api/admin/invites/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error || `Revoke failed (${res.status})`);
      return;
    }
    await load();
  }

  async function deleteUser(u: UserItem) {
    if (!confirm(`Delete user ${u.username}? This cannot be undone.`)) return;
    const res = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error || `Delete failed (${res.status})`);
      return;
    }
    await load();
  }

  async function changeRole(u: UserItem, role: "admin" | "member") {
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error || `Update failed (${res.status})`);
      return;
    }
    await load();
  }

  async function copyLink(invite: InviteItem) {
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopiedId(invite.id);
      setTimeout(() => setCopiedId((c) => (c === invite.id ? null : c)), 2000);
    } catch {
      // ignore — clipboard not available
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={20} className="mr-2 animate-spin text-ink-3" />
        <span className="text-sm text-ink-3">Loading…</span>
      </div>
    );
  }

  if (pageError) {
    return (
      <Card className="border-danger/20 bg-danger-tint">
        <CardContent className="py-6 text-sm text-danger">
          <AlertTriangle size={16} className="mr-1 inline" /> {pageError}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">User Permissions</h1>
          <p className="text-xs text-ink-3">
            Add new users by email — they receive a link to set their password.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw size={14} className="mr-1" /> Refresh
        </Button>
      </div>

      {/* Create invite */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <UserPlus size={16} className="mr-1 inline" /> Invite a user
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={createInvite}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1">
              <label className="block text-xs text-ink-3" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="user@example.com"
                className="mt-1 block w-full rounded-md border border-silver-line px-3 py-2 text-sm shadow-sm focus:border-green focus:outline-none focus:ring-1 focus:ring-green-mid"
              />
            </div>
            <div>
              <label className="block text-xs text-ink-3" htmlFor="role">
                Role
              </label>
              <select
                id="role"
                value={newRole}
                onChange={(e) =>
                  setNewRole(e.target.value as "admin" | "member")
                }
                className="mt-1 block rounded-md border border-silver-line px-3 py-2 text-sm shadow-sm focus:border-green focus:outline-none focus:ring-1 focus:ring-green-mid"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <Button type="submit" disabled={creating || !newEmail}>
              {creating && <Loader2 size={14} className="mr-1 animate-spin" />}
              Create invite
            </Button>
          </form>
          {createError && (
            <p className="mt-2 text-xs text-danger">{createError}</p>
          )}
          <p className="mt-3 text-xs text-ink-3">
            Email delivery isn&apos;t wired yet — copy the invite link from the
            list below and send it manually.
          </p>
        </CardContent>
      </Card>

      {/* Existing users */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Active users ({users.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-rule text-left text-xs text-ink-3">
              <tr>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Display name</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <tr key={u.id} className="border-b border-rule">
                    <td className="px-4 py-2 font-medium">{u.username}</td>
                    <td className="px-4 py-2">{u.displayName || "—"}</td>
                    <td className="px-4 py-2">
                      <select
                        value={u.role}
                        disabled={isMe}
                        onChange={(e) =>
                          changeRole(u, e.target.value as "admin" | "member")
                        }
                        className="rounded border border-silver-line px-2 py-1 text-xs disabled:opacity-50"
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                      {u.role === "admin" && (
                        <ShieldCheck
                          size={12}
                          className="ml-1 inline text-green-mid"
                        />
                      )}
                      {isMe && (
                        <span className="ml-2 text-xs text-ink-3">(you)</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-3">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteUser(u)}
                        disabled={isMe}
                        title={isMe ? "Cannot delete yourself" : "Delete user"}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Invites */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Invitations ({invites.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {invites.length === 0 && (
            <p className="px-4 py-3 text-sm text-ink-3">No invites yet.</p>
          )}
          {invites.length > 0 && (
            <table className="w-full text-sm">
              <thead className="border-b border-rule text-left text-xs text-ink-3">
                <tr>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Expires</th>
                  <th className="px-4 py-2">Link</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id} className="border-b border-rule">
                    <td className="px-4 py-2">{i.email}</td>
                    <td className="px-4 py-2">{i.role}</td>
                    <td className="px-4 py-2">
                      <span
                        className={
                          i.status === "pending"
                            ? "text-warn"
                            : i.status === "accepted"
                              ? "text-green"
                              : "text-ink-3"
                        }
                      >
                        {i.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-3">
                      {new Date(i.expiresAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      {i.status === "pending" ? (
                        <button
                          onClick={() => copyLink(i)}
                          className="inline-flex items-center gap-1 rounded border border-silver-line px-2 py-1 text-xs hover:bg-surface-tint"
                        >
                          {copiedId === i.id ? (
                            <>
                              <Check size={12} className="text-green" /> Copied
                            </>
                          ) : (
                            <>
                              <Copy size={12} /> Copy link
                            </>
                          )}
                        </button>
                      ) : (
                        <span className="text-xs text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {i.status === "pending" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => revokeInvite(i.id)}
                          title="Revoke invite"
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
