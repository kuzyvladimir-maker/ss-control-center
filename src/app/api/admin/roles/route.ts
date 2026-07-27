/**
 * GET  /api/admin/roles   — list all roles + how many users hold each (admin)
 * POST /api/admin/roles   — create a custom role (admin)
 *   body: { name: string, modules?: string[] }
 *
 * A role's `key` is derived from its name (slugified) and is what
 * User.role / Invite.role reference. Module keys are validated against the
 * grantable set in src/lib/rbac/modules.ts — unknown/always-on/admin-only
 * keys are silently dropped.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";
import { GRANTABLE_MODULE_KEYS } from "@/lib/rbac/modules";
import { parseModules } from "@/lib/rbac/access";

/** Lowercase, hyphenate, strip junk → a URL-/code-safe role key. */
export function slugifyRoleKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Keep only real, grantable module keys (drops dashboard/settings/unknown). */
export function sanitizeModules(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const set = new Set(GRANTABLE_MODULE_KEYS);
  return [...new Set(input.filter((k): k is string => typeof k === "string" && set.has(k)))];
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const [roles, counts] = await Promise.all([
    prisma.role.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] }),
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
  ]);

  const countByKey = new Map(counts.map((c) => [c.role, c._count._all]));

  const items = roles.map((r) => ({
    key: r.key,
    name: r.name,
    modules: parseModules(r.modules),
    isSystem: r.isSystem,
    userCount: countByKey.get(r.key) ?? 0,
    createdAt: r.createdAt,
  }));

  return NextResponse.json({ items });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: { name?: string; modules?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Role name required" }, { status: 400 });
  }

  const baseKey = slugifyRoleKey(name);
  if (!baseKey) {
    return NextResponse.json(
      { error: "Name must contain letters or numbers" },
      { status: 400 }
    );
  }

  // Ensure a unique key — append -2, -3… on collision.
  let key = baseKey;
  for (let n = 2; n < 100; n++) {
    const exists = await prisma.role.findUnique({ where: { key }, select: { id: true } });
    if (!exists) break;
    key = `${baseKey}-${n}`;
  }

  const modules = sanitizeModules(body.modules);

  const role = await prisma.role.create({
    data: { key, name, modules: JSON.stringify(modules), isSystem: false },
  });

  return NextResponse.json({
    ok: true,
    role: { key: role.key, name: role.name, modules, isSystem: false, userCount: 0 },
  });
}
