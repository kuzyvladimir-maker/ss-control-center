/**
 * /api/bundle-factory/uncrustables/runs
 *
 * POST — create an Uncrustables Studio run: every recipe is validated by the
 *   box-planner, art + donor resolved fail-closed, copy and price built by
 *   the proven libs; candidates are created in state PLANNED. Any invalid
 *   recipe rejects the whole request (nothing is created).
 * GET — list runs with per-state candidate counts.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  loadUncrustablesDonorPool,
  planStudioRecipe,
} from "@/lib/bundle-factory/uncrustables-studio-run";

export const dynamic = "force-dynamic";

interface CreateRunBody {
  name?: string;
  owner_order?: string;
  created_by?: string;
  recipes?: { slug?: string; comps?: { flavor?: string; qty?: number }[] }[];
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,80}$/;

export const POST = withErrorHandler("uncrustables-runs-create", async (request: Request) => {
  const body = await readJson<CreateRunBody>(request);
  if (!body) return badRequest("Invalid JSON body");

  const name = body.name?.trim();
  if (!name) return badRequest("name is required");
  const recipes = body.recipes;
  if (!Array.isArray(recipes) || recipes.length === 0) {
    return badRequest("recipes must be a non-empty array");
  }

  // Structural validation before any DB work.
  const seenSlugs = new Set<string>();
  for (const r of recipes) {
    const slug = r.slug?.trim() ?? "";
    if (!SLUG_PATTERN.test(slug)) {
      return badRequest(`recipe slug "${slug}" is invalid (lowercase letters, digits, dashes)`);
    }
    if (seenSlugs.has(slug)) return badRequest(`duplicate recipe slug "${slug}"`);
    seenSlugs.add(slug);
    if (!Array.isArray(r.comps) || r.comps.length === 0) {
      return badRequest(`recipe "${slug}" has no components`);
    }
    for (const c of r.comps) {
      if (typeof c.flavor !== "string" || !Number.isInteger(c.qty) || (c.qty as number) <= 0) {
        return badRequest(`recipe "${slug}" has a malformed component`);
      }
    }
  }

  const donors = await loadUncrustablesDonorPool();
  const planned: {
    slug: string;
    plan: NonNullable<ReturnType<typeof planStudioRecipe>["plan"]>;
  }[] = [];
  const recipeErrors: Record<string, string[]> = {};
  for (const r of recipes) {
    const comps = (r.comps ?? []).map((c) => ({ flavor: c.flavor as string, qty: c.qty as number }));
    const { errors, plan } = planStudioRecipe(comps, donors);
    if (errors.length || !plan) recipeErrors[r.slug as string] = errors;
    else planned.push({ slug: r.slug as string, plan });
  }
  if (Object.keys(recipeErrors).length > 0) {
    return NextResponse.json(
      { error: "One or more recipes failed planning", recipe_errors: recipeErrors },
      { status: 400 },
    );
  }

  const run = await prisma.uncrustablesStudioRun.create({
    data: {
      name,
      owner_order: body.owner_order?.trim() || `Uncrustables Studio web run: ${name}`,
      created_by: body.created_by?.trim() || "studio-web",
      candidates: {
        create: planned.map(({ slug, plan }) => ({
          slug,
          state: "PLANNED",
          recipe_json: JSON.stringify(plan.recipe),
          title: plan.title,
          bullets_json: JSON.stringify(plan.bullets),
          description: plan.description,
          price_cents: plan.price_cents,
          cost_cents: plan.cost_cents,
          pack_count: plan.pack_count,
        })),
      },
    },
    include: { candidates: { select: { id: true, slug: true, state: true } } },
  });

  return NextResponse.json(
    { run_id: run.id, name: run.name, candidates: run.candidates },
    { status: 201 },
  );
});

export const GET = withErrorHandler("uncrustables-runs-list", async () => {
  const runs = await prisma.uncrustablesStudioRun.findMany({
    orderBy: { created_at: "desc" },
    take: 100,
    include: { candidates: { select: { state: true } } },
  });
  return NextResponse.json({
    runs: runs.map((run) => {
      const stateCounts: Record<string, number> = {};
      for (const c of run.candidates) {
        stateCounts[c.state] = (stateCounts[c.state] ?? 0) + 1;
      }
      return {
        id: run.id,
        name: run.name,
        status: run.status,
        created_by: run.created_by,
        created_at: run.created_at,
        updated_at: run.updated_at,
        candidate_count: run.candidates.length,
        state_counts: stateCounts,
      };
    }),
  });
});
