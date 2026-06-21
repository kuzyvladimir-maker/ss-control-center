"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Trash2,
  Plus,
  ShieldCheck,
  AlertTriangle,
  Check,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface ModuleDef {
  key: string;
  label: string;
}

interface RoleItem {
  key: string;
  name: string;
  modules: string[];
  isSystem: boolean;
  userCount: number;
}

export default function RolesSettingsPage() {
  const [modules, setModules] = useState<ModuleDef[]>([]);
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // Create-role form
  const [newName, setNewName] = useState("");
  const [newModules, setNewModules] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Per-role pending edits (key → module set), tracked so we can show Save.
  const [edits, setEdits] = useState<Record<string, Set<string>>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setPageError(null);
    try {
      const [modRes, rolesRes] = await Promise.all([
        fetch("/api/rbac/modules"),
        fetch("/api/admin/roles"),
      ]);
      if (modRes.status === 401 || rolesRes.status === 401) {
        setPageError("Not signed in");
        return;
      }
      if (modRes.status === 403 || rolesRes.status === 403) {
        setPageError("Admin permission required");
        return;
      }
      const modJ = await modRes.json();
      const rolesJ = await rolesRes.json();
      setModules(modJ.items ?? []);
      setRoles(rolesJ.items ?? []);
      // Reset any pending edits to match freshly loaded state.
      const fresh: Record<string, Set<string>> = {};
      for (const r of rolesJ.items ?? []) {
        fresh[r.key] = new Set<string>(r.modules);
      }
      setEdits(fresh);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const roleByKey = useMemo(
    () => Object.fromEntries(roles.map((r) => [r.key, r])),
    [roles]
  );

  function toggleNew(key: string) {
    setNewModules((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleEdit(roleKey: string, moduleKey: string) {
    setEdits((prev) => {
      const cur = new Set(prev[roleKey] ?? []);
      cur.has(moduleKey) ? cur.delete(moduleKey) : cur.add(moduleKey);
      return { ...prev, [roleKey]: cur };
    });
  }

  function isDirty(role: RoleItem): boolean {
    const edited = edits[role.key];
    if (!edited) return false;
    const orig = new Set(role.modules);
    if (edited.size !== orig.size) return true;
    for (const k of edited) if (!orig.has(k)) return true;
    return false;
  }

  async function createRole(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          modules: [...newModules],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(data.error || `HTTP ${res.status}`);
        return;
      }
      setNewName("");
      setNewModules(new Set());
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Network error");
    } finally {
      setCreating(false);
    }
  }

  async function saveRole(role: RoleItem) {
    setSavingKey(role.key);
    try {
      const res = await fetch(`/api/admin/roles/${role.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modules: [...(edits[role.key] ?? [])] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error || `Save failed (${res.status})`);
        return;
      }
      setSavedKey(role.key);
      setTimeout(() => setSavedKey((k) => (k === role.key ? null : k)), 1800);
      await load();
    } finally {
      setSavingKey(null);
    }
  }

  async function deleteRole(role: RoleItem) {
    if (!confirm(`Delete role "${role.name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/admin/roles/${role.key}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error || `Delete failed (${res.status})`);
      return;
    }
    await load();
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
          <h1 className="text-lg font-semibold text-ink">
            Roles &amp; permissions
          </h1>
          <p className="text-xs text-ink-3">
            Create roles and choose which modules each one can open. Assign a
            role to a user on the{" "}
            <a href="/settings/users" className="text-green hover:underline">
              Manage users
            </a>{" "}
            page.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw size={14} className="mr-1" /> Refresh
        </Button>
      </div>

      {/* Create a role */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <Plus size={16} className="mr-1 inline" /> Create a role
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createRole} className="space-y-4">
            <div className="max-w-sm">
              <label className="block text-xs text-ink-3" htmlFor="roleName">
                Role name
              </label>
              <input
                id="roleName"
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Procurement, Customer Service…"
                className="mt-1 block w-full rounded-md border border-silver-line px-3 py-2 text-sm shadow-sm focus:border-green focus:outline-none focus:ring-1 focus:ring-green-mid"
              />
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-ink-2">
                Modules this role can open
              </div>
              <ModuleGrid
                modules={modules}
                selected={newModules}
                onToggle={toggleNew}
              />
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={creating || !newName.trim()}>
                {creating && (
                  <Loader2 size={14} className="mr-1 animate-spin" />
                )}
                Create role
              </Button>
              {createError && (
                <span className="text-xs text-danger">{createError}</span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Existing roles */}
      <div className="space-y-4">
        {roles.map((role) => {
          const isAdmin = role.key === "admin";
          const dirty = isDirty(role);
          return (
            <Card key={role.key}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {role.name}
                    {role.isSystem && (
                      <span className="inline-flex items-center gap-1 rounded bg-green-soft px-1.5 py-px text-[10px] font-medium text-green-ink">
                        <ShieldCheck size={11} /> System
                      </span>
                    )}
                    <span className="text-xs font-normal text-ink-3">
                      {role.userCount} user{role.userCount === 1 ? "" : "s"}
                    </span>
                  </CardTitle>
                  {!role.isSystem && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteRole(role)}
                      title="Delete role"
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {isAdmin ? (
                  <p className="text-sm text-ink-3">
                    The administrator role always has full access to every
                    module, including Settings. It can&apos;t be edited.
                  </p>
                ) : (
                  <>
                    <ModuleGrid
                      modules={modules}
                      selected={edits[role.key] ?? new Set()}
                      onToggle={(k) => toggleEdit(role.key, k)}
                    />
                    <div className="mt-4 flex items-center gap-3">
                      <Button
                        size="sm"
                        disabled={!dirty || savingKey === role.key}
                        onClick={() => saveRole(role)}
                      >
                        {savingKey === role.key && (
                          <Loader2 size={14} className="mr-1 animate-spin" />
                        )}
                        Save changes
                      </Button>
                      {savedKey === role.key && (
                        <span className="inline-flex items-center text-xs text-green">
                          <Check size={13} className="mr-1" /> Saved
                        </span>
                      )}
                      {dirty && savedKey !== role.key && (
                        <span className="text-xs text-ink-3">
                          Unsaved changes
                        </span>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ModuleGrid({
  modules,
  selected,
  onToggle,
}: {
  modules: ModuleDef[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {modules.map((m) => {
        const checked = selected.has(m.key);
        return (
          <label
            key={m.key}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-sm hover:bg-surface-tint"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(m.key)}
              className="h-4 w-4 rounded border-silver-line text-green focus:ring-green-mid"
            />
            <span className={checked ? "text-ink" : "text-ink-2"}>
              {m.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
