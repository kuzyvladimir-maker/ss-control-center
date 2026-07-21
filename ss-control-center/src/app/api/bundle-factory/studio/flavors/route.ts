/**
 * GET /api/bundle-factory/studio/flavors?theme=uncrustables
 *
 * Flavor readiness map for the self-service studio (owner 2026-07-21: "я
 * регулирую и вкусы, и количество"). For the requested theme/brand it returns
 * every flavor the donor reference catalog knows, with an honest per-flavor
 * readiness verdict, so the operator picks flavors from REAL catalog data
 * instead of guessing prose the engine may not match:
 *
 *   - eligible_now  — at least one donor row passes the studio's fail-closed
 *                     sourcing gate (UPC + ingredients + image + 1P direct
 *                     offer + parseable per-unit cost);
 *   - missing       — which fields block the remaining donors (feeds the
 *                     enrichment queue decision — enrichment itself stays
 *                     owner-gated, this endpoint only reports);
 *   - art_approved  — own-brand only: whether the flavor has exact reviewed
 *                     package art in the authenticity registry (without it the
 *                     MAIN image stage hard-stops by design).
 *
 * Read-only; no writes, no paid calls.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  brandTokens,
  canonicalFlavorKey,
  dedupeDonorFlavors,
} from "@/lib/bundle-factory/donor-dedup";
import { isOwnBrandPassthrough, textSaysUncrustables } from "@/lib/bundle-factory/own-brand";
import { PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY } from "@/lib/bundle-factory/audit/uncrustables-main-production-preflight";
import { resolveReviewedUncrustablesPackageArt } from "@/lib/bundle-factory/audit/uncrustables-main-authenticity";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler("studio-flavors", async (request: Request) => {
  const url = new URL(request.url);
  const theme = (url.searchParams.get("theme") ?? "").trim();
  if (theme.length < 3) {
    return NextResponse.json({ error: "Pass ?theme= (a brand or product words, ≥3 chars)." }, { status: 400 });
  }

  const tokens = theme
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 4);
  const or = tokens.flatMap((tok) => [
    { brand: { contains: tok } },
    { title: { contains: tok } },
    { productLine: { contains: tok } },
  ]);

  // Deliberately RELAXED versus the studio's sourcing gate: the whole point is
  // to show flavors that exist in the catalog but are not yet buildable, with
  // the reason. needsReview rows stay excluded — their identity is untrusted.
  const donors = await prisma.donorProduct.findMany({
    where: { ...(or.length > 0 ? { OR: or } : {}), needsReview: false },
    orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
    take: 400,
    select: {
      id: true,
      brand: true,
      productLine: true,
      flavor: true,
      title: true,
      upc: true,
      ingredients: true,
      bestPrice: true,
      mainImageUrl: true,
      offers: {
        where: { isFirstParty: true, via: "direct", price: { gt: 0 } },
        select: { price: true, packSizeSeen: true, pricePerUnit: true },
      },
    },
  });

  if (donors.length === 0) {
    return NextResponse.json({ theme, flavors: [], donors_total: 0 });
  }

  // Same grouping rule the engine uses (flavor column if present, else the
  // canonical key derived from the title with the shared brand vocabulary).
  const shared = brandTokens(...donors.flatMap((d) => [d.brand, d.productLine]));
  const keyOf = (d: (typeof donors)[number]): string =>
    (d.flavor ?? "").trim().toLowerCase() ||
    canonicalFlavorKey(d.title, { brand: d.brand, productLine: d.productLine, extraTokens: shared });

  const groups = new Map<string, Array<(typeof donors)[number]>>();
  for (const d of donors) {
    const key = keyOf(d);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(d);
    else groups.set(key, [d]);
  }

  // Labels / per-unit costs / pack sizes come from the same dedupe the engine
  // runs, so what the UI shows is exactly what the engine will build from.
  const entries = new Map(dedupeDonorFlavors(donors).map((e) => [e.key, e]));

  const flavors = Array.from(groups.entries()).map(([key, group]) => {
    const entry = entries.get(key) ?? null;
    const eligibleDonors = group.filter(
      (d) =>
        d.upc != null &&
        d.ingredients != null &&
        d.mainImageUrl != null &&
        (d.bestPrice ?? 0) > 0 &&
        d.offers.length > 0,
    );
    const missing = {
      upc: group.filter((d) => d.upc == null).length,
      ingredients: group.filter((d) => d.ingredients == null).length,
      image: group.filter((d) => d.mainImageUrl == null).length,
      first_party_offer: group.filter((d) => d.offers.length === 0).length,
    };
    const ownBrandish = group.some(
      (d) => isOwnBrandPassthrough(d.brand) || textSaysUncrustables(d.title),
    );
    let artApproved: boolean | null = null;
    if (ownBrandish) {
      artApproved = false;
      try {
        const label = entry?.label ?? group[0].title ?? key;
        artApproved =
          resolveReviewedUncrustablesPackageArt(
            PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
            label,
            "retail-carton",
          ) != null ||
          (group[0].title != null &&
            resolveReviewedUncrustablesPackageArt(
              PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
              group[0].title,
              "retail-carton",
            ) != null);
      } catch {
        artApproved = false;
      }
    }
    const costable = entry?.costable ?? false;
    return {
      key,
      label: entry?.label ?? key,
      donors: group.length,
      unit_price_cents: entry?.unit_price_cents ?? null,
      pack_sizes: entry?.pack_sizes ?? [],
      eligible_now: eligibleDonors.length > 0 && costable,
      costable,
      missing,
      art_approved: artApproved,
    };
  });

  flavors.sort((a, b) => {
    const rank = (f: (typeof flavors)[number]) =>
      (f.eligible_now ? 0 : 2) + (f.art_approved === false ? 1 : 0);
    return rank(a) - rank(b) || b.donors - a.donors || a.label.localeCompare(b.label);
  });

  return NextResponse.json({
    theme,
    donors_total: donors.length,
    ready_now: flavors.filter((f) => f.eligible_now && f.art_approved !== false).length,
    flavors,
  });
});
