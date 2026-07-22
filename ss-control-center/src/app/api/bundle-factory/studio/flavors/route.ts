/**
 * GET /api/bundle-factory/studio/flavors?theme=uncrustables[&image_mode=…]
 *
 * Flavor readiness map for the self-service studio (owner 2026-07-21: "я
 * регулирую и вкусы, и количество").
 *
 * IDENTITY CONTRACT (review 2026-07-21): the *selectable* list is computed
 * from the ENGINE'S OWN sourcing + dedupe (`sourceDonors` → `dedupeDonorFlavors`
 * over the identical strict pool), so the keys/labels shown here are exactly
 * the entries `tickBatch` will match. Computing them over a different donor
 * pool changes the shared brand vocabulary and silently shifts labels — that
 * bug shipped once and is why this route now imports the engine's sourcing.
 *
 * A second, RELAXED query reports flavors that exist in the catalog but are
 * not buildable yet (missing ingredients/UPC/offer) — returned with
 * `buildable: false` so the UI renders them disabled, and with the missing
 * fields so the owner can order enrichment (enrichment itself stays
 * owner-gated; this endpoint only reports). Read-only, no paid calls.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  sourceDonors,
  normalizeFlavorToken,
} from "@/lib/bundle-factory/studio-engine";
import {
  brandTokens,
  canonicalFlavorKey,
  dedupeDonorFlavors,
} from "@/lib/bundle-factory/donor-dedup";
import { isOwnBrandPassthrough, textSaysUncrustables } from "@/lib/bundle-factory/own-brand";
import { resolveMergedUncrustablesPackageArt } from "@/lib/bundle-factory/audit/uncrustables-authenticity-merged";

export const dynamic = "force-dynamic";

type PackMode = "retail-carton" | "individual-wrapper";

function artApprovedFor(labels: Array<string | null | undefined>, packMode: PackMode): boolean {
  for (const label of labels) {
    if (!label) continue;
    try {
      if (resolveMergedUncrustablesPackageArt(label, packMode) != null) {
        return true;
      }
    } catch {
      /* registry invalid → treat as not approved; fail-closed */
    }
  }
  return false;
}

export const GET = withErrorHandler("studio-flavors", async (request: Request) => {
  const url = new URL(request.url);
  const theme = (url.searchParams.get("theme") ?? "").trim();
  // Same tokenization rule the engine's sourcing applies: only ≥3-char tokens
  // count. "a b" passes a raw length check but sources nothing — reject early.
  const tokens = theme.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 3);
  if (tokens.length === 0) {
    return NextResponse.json(
      { error: "Pass ?theme= with at least one word of 3+ characters (e.g. Uncrustables)." },
      { status: 400 },
    );
  }
  const packMode: PackMode =
    url.searchParams.get("image_mode") === "individual_wraps"
      ? "individual-wrapper"
      : "retail-carton";

  // ── 1. BUILDABLE set: the engine's exact pool, dedupe, keys and labels. ──
  const strictDonors = await sourceDonors(theme);
  const strictEntries = dedupeDonorFlavors(strictDonors);
  const strictBySku = new Map(strictEntries.map((e) => [e.key, e]));
  const strictNorms = new Set(
    strictEntries.flatMap((e) => [normalizeFlavorToken(e.key), normalizeFlavorToken(e.label)]),
  );

  const buildableRows = strictEntries.map((e) => {
    const ownBrandish =
      isOwnBrandPassthrough(e.donor.brand) || textSaysUncrustables(e.donor.title);
    return {
      key: e.key,
      label: e.label,
      buildable: e.costable,
      donors: 1, // refined from the per-key census right below
      unit_price_cents: e.unit_price_cents,
      pack_sizes: e.pack_sizes,
      missing: { upc: 0, ingredients: 0, image: 0, first_party_offer: 0, unit_cost: e.costable ? 0 : 1 },
      art_approved: ownBrandish ? artApprovedFor([e.label, e.donor.title], packMode) : null,
    };
  });

  // Per-key donor counts for the strict pool (same grouping rule as dedupe).
  {
    const shared = brandTokens(...strictDonors.flatMap((d) => [d.brand, d.productLine]));
    const counts = new Map<string, number>();
    for (const d of strictDonors) {
      const key =
        (d.flavor ?? "").trim().toLowerCase() ||
        canonicalFlavorKey(d.title, { brand: d.brand, productLine: d.productLine, extraTokens: shared });
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const row of buildableRows) row.donors = counts.get(row.key) ?? 1;
  }

  // ── 2. GAPS: catalog flavors not buildable yet (relaxed pool), for the
  //       enrichment decision. Skip anything already covered by a buildable
  //       entry (compare via the same normalizer the engine matches with). ──
  const or = tokens.slice(0, 4).flatMap((tok) => [
    { brand: { contains: tok } },
    { title: { contains: tok } },
    { productLine: { contains: tok } },
  ]);
  const relaxedDonors = await prisma.donorProduct.findMany({
    where: { OR: or, needsReview: false },
    orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
    take: 400,
    select: {
      id: true, brand: true, productLine: true, flavor: true, title: true,
      upc: true, ingredients: true, bestPrice: true, mainImageUrl: true,
      offers: {
        where: { isFirstParty: true, via: "direct", price: { gt: 0 } },
        select: { price: true, packSizeSeen: true, pricePerUnit: true },
      },
    },
  });
  const gapRows: typeof buildableRows = [];
  if (relaxedDonors.length > 0) {
    const shared = brandTokens(...relaxedDonors.flatMap((d) => [d.brand, d.productLine]));
    const groups = new Map<string, Array<(typeof relaxedDonors)[number]>>();
    for (const d of relaxedDonors) {
      const key =
        (d.flavor ?? "").trim().toLowerCase() ||
        canonicalFlavorKey(d.title, { brand: d.brand, productLine: d.productLine, extraTokens: shared });
      if (!key) continue;
      const g = groups.get(key);
      if (g) g.push(d);
      else groups.set(key, [d]);
    }
    const relaxedEntries = new Map(dedupeDonorFlavors(relaxedDonors).map((e) => [e.key, e]));
    for (const [key, group] of groups) {
      const entry = relaxedEntries.get(key) ?? null;
      const label = entry?.label ?? key;
      if (
        strictNorms.has(normalizeFlavorToken(key)) ||
        strictNorms.has(normalizeFlavorToken(label))
      ) {
        continue; // already selectable via the buildable set
      }
      const ownBrandish = group.some(
        (d) => isOwnBrandPassthrough(d.brand) || textSaysUncrustables(d.title),
      );
      gapRows.push({
        key,
        label,
        buildable: false,
        donors: group.length,
        unit_price_cents: entry?.unit_price_cents ?? null,
        pack_sizes: entry?.pack_sizes ?? [],
        missing: {
          upc: group.filter((d) => d.upc == null).length,
          ingredients: group.filter((d) => d.ingredients == null).length,
          image: group.filter((d) => d.mainImageUrl == null).length,
          first_party_offer: group.filter((d) => d.offers.length === 0).length,
          unit_cost: entry?.costable ? 0 : 1,
        },
        art_approved: ownBrandish
          ? artApprovedFor([label, group[0]?.title], packMode)
          : null,
      });
    }
  }

  const flavors = [...buildableRows, ...gapRows];
  flavors.sort((a, b) => {
    const rank = (f: (typeof flavors)[number]) =>
      (f.buildable ? 0 : 2) + (f.art_approved === false ? 1 : 0);
    return rank(a) - rank(b) || b.donors - a.donors || a.label.localeCompare(b.label);
  });

  return NextResponse.json({
    theme,
    image_mode: packMode,
    donors_strict: strictDonors.length,
    donors_total: relaxedDonors.length,
    ready_now: flavors.filter((f) => f.buildable && f.art_approved !== false).length,
    flavors,
  });
});
