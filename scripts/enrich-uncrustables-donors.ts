/**
 * Guarded, DB-only repair for the reviewed Uncrustables donor blockers.
 *
 * Safety properties:
 *   - read-only dry-run by default;
 *   - manifest and source ledger are SHA-256 pinned;
 *   - exact title/UPC/Target-offer preconditions;
 *   - fills blank facts and replaces only exact SHA-pinned ingredient snapshots;
 *   - rewrites only reviewed IDs in selected VariationMatrix variants;
 *   - one optimistic transaction, no marketplace client imports or calls.
 *
 * Apply requires:
 *   npx tsx scripts/enrich-uncrustables-donors.ts \
 *     --apply --confirm=ENRICH_UNCRUSTABLES_DONORS_AND_ALIAS
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";

import { config } from "dotenv";

import {
  donorManifestMap,
  parseDonorEnrichmentManifest,
  projectDonorEnrichment,
  projectSelectedVariantAliases,
  rewriteSelectedVariantAliases,
  textSha256,
  UNCRUSTABLES_DONOR_MANIFEST_PATH,
  UNCRUSTABLES_DONOR_MANIFEST_SHA256,
  type DonorEnrichmentEntry,
  type DonorEnrichmentManifest,
} from "@/lib/bundle-factory/donor-enrichment";
import {
  buildCanonicalRecipe,
  selectedVariantFromJson,
  type RepairDonor,
} from "@/lib/bundle-factory/recipe-repair";

config({ path: ".env.local" });
config({ path: ".env" });

const CONFIRMATION = "ENRICH_UNCRUSTABLES_DONORS_AND_ALIAS";

type RootPrisma = Awaited<typeof import("@/lib/prisma")>["prisma"];
type RepairDataClient = Pick<
  RootPrisma,
  "donorProduct" | "variationMatrix" | "bundleDraft"
>;

interface Options {
  apply: boolean;
  confirm: string | null;
  verbose: boolean;
}

interface CatalogRow {
  id: string;
  title: string | null;
  upc: string | null;
  ingredients: string | null;
  updatedAt: Date;
  offers: Array<{
    retailerProductId: string;
    productUrl: string | null;
    fetchedAt: string | null;
    isFirstParty: boolean;
    via: string;
  }>;
}

interface DonorChange {
  row: CatalogRow;
  entry: DonorEnrichmentEntry;
  setUpc: boolean;
  setIngredients: boolean;
}

interface MatrixChange {
  id: string;
  bundleDraftId: string;
  updatedAt: Date;
  selectedVariantIdx: number | null;
  before: string;
  after: string;
  replacements: number;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/enrich-uncrustables-donors.ts [options]",
    "",
    "Options:",
    "  --verbose       Print every verified donor and postflight blocker.",
    "  --apply         Enable the reviewed database-only transaction.",
    `  --confirm=${CONFIRMATION}`,
    "                  Mandatory exact phrase together with --apply.",
    "  --help          Show this help.",
    "",
    `Pinned manifest: ${UNCRUSTABLES_DONOR_MANIFEST_PATH}`,
    "Without --apply this command is read-only. It never calls Amazon or Walmart.",
  ].join("\n");
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, confirm: null, verbose: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg.startsWith("--confirm=")) {
      options.confirm = arg.slice("--confirm=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (options.apply && options.confirm !== CONFIRMATION) {
    throw new Error(
      `Writes are locked. Re-run with --apply --confirm=${CONFIRMATION}`,
    );
  }
  if (!options.apply && options.confirm) {
    throw new Error("--confirm is only valid together with --apply");
  }
  return options;
}

function digest(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function fileStamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/**
 * Persist the exact rows about to change before opening the remote transaction.
 * If this local, mode-0600 artifact cannot be created, apply aborts with zero
 * database writes. It is deliberately limited to the reviewed mutation set.
 */
async function writePreApplySnapshot(args: {
  manifest: DonorEnrichmentManifest;
  donorChanges: DonorChange[];
  matrixChanges: MatrixChange[];
}): Promise<{ path: string; sha256: string }> {
  const created = new Date();
  const body = {
    schema_version: "bundle-factory.uncrustables-donor-enrichment-snapshot/v1",
    immutable: true,
    external_mutations: false,
    created_at: created.toISOString(),
    manifest: {
      path: UNCRUSTABLES_DONOR_MANIFEST_PATH,
      sha256: UNCRUSTABLES_DONOR_MANIFEST_SHA256,
      ledger: args.manifest.ledger,
    },
    donors_before: args.donorChanges
      .filter((change) => change.setUpc || change.setIngredients)
      .map((change) => ({
        id: change.row.id,
        title: change.row.title,
        upc: change.row.upc,
        ingredients: change.row.ingredients,
        updated_at: change.row.updatedAt.toISOString(),
      })),
    matrices_before: args.matrixChanges.map((change) => ({
      id: change.id,
      bundle_draft_id: change.bundleDraftId,
      selected_variant_idx: change.selectedVariantIdx,
      variants_json: change.before,
      updated_at: change.updatedAt.toISOString(),
      replacements: change.replacements,
    })),
  };
  const sha256 = digest(JSON.stringify(body));
  const outputDir = resolve(process.cwd(), "data/audits");
  await mkdir(outputDir, { recursive: true });
  const path = resolve(
    outputDir,
    `uncrustables-donor-enrichment-pre-apply-${fileStamp(created)}.json`,
  );
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ ...body, sha256 }, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return { path, sha256 };
}

function loadPinnedManifest(): DonorEnrichmentManifest {
  const path = resolve(process.cwd(), UNCRUSTABLES_DONOR_MANIFEST_PATH);
  const raw = readFileSync(path);
  const actualDigest = digest(raw);
  if (actualDigest !== UNCRUSTABLES_DONOR_MANIFEST_SHA256) {
    throw new Error(
      `Reviewed manifest digest mismatch: expected ${UNCRUSTABLES_DONOR_MANIFEST_SHA256}, ` +
        `got ${actualDigest}`,
    );
  }
  const manifest = parseDonorEnrichmentManifest(JSON.parse(raw.toString("utf8")));
  const ledgerPath = resolve(process.cwd(), manifest.ledger.path);
  const ledgerDigest = digest(readFileSync(ledgerPath));
  if (ledgerDigest !== manifest.ledger.sha256) {
    throw new Error(
      `Source ledger digest mismatch: expected ${manifest.ledger.sha256}, got ${ledgerDigest}`,
    );
  }
  return manifest;
}

function isBlank(value: string | null | undefined): boolean {
  return !value?.trim();
}

function targetProductIdFromUrl(value: string | null): string | null {
  if (!value) return null;
  return value.match(/(?:A-|\/)(\d{8})(?:[/?#]|$)/i)?.[1] ?? null;
}

function validateCatalogRow(
  row: CatalogRow,
  entry: DonorEnrichmentEntry,
): DonorChange {
  if (row.title !== entry.expected_title) {
    throw new Error(
      `${entry.donor_id}: title changed; expected ${JSON.stringify(entry.expected_title)}, ` +
        `got ${JSON.stringify(row.title)}`,
    );
  }
  const snapshotUpc = entry.catalog_snapshot.upc;
  if (row.upc !== entry.reviewed.upc && row.upc !== snapshotUpc.value) {
    throw new Error(
      `${entry.donor_id}: UPC changed; expected exact snapshot ` +
        `${snapshotUpc.value ?? "NULL"} or reviewed ${entry.reviewed.upc}, ` +
        `got ${row.upc ?? "NULL"}`,
    );
  }
  const snapshotIngredients = entry.catalog_snapshot.ingredients;
  if (
    row.ingredients !== entry.reviewed.ingredients &&
    row.ingredients !== snapshotIngredients.value
  ) {
    throw new Error(
      `${entry.donor_id}: ingredients changed outside the exact reviewed snapshot`,
    );
  }
  if (
    row.ingredients !== null &&
    row.ingredients === snapshotIngredients.value &&
    textSha256(row.ingredients) !== snapshotIngredients.sha256
  ) {
    throw new Error(`${entry.donor_id}: ingredients snapshot digest mismatch`);
  }
  const setUpc =
    row.upc !== entry.reviewed.upc && snapshotUpc.action === "fill_if_missing";
  const setIngredients =
    row.ingredients !== entry.reviewed.ingredients &&
    (snapshotIngredients.action === "fill_if_missing" ||
      snapshotIngredients.action === "replace_exact");
  if (
    row.upc !== entry.reviewed.upc &&
    snapshotUpc.action === "verify_exact_no_write"
  ) {
    throw new Error(`${entry.donor_id}: verification-only UPC cannot be changed`);
  }
  if (
    row.ingredients !== entry.reviewed.ingredients &&
    snapshotIngredients.action === "verify_exact_no_write"
  ) {
    throw new Error(`${entry.donor_id}: verification-only ingredients cannot be changed`);
  }

  const expectedOffer = entry.catalog_snapshot.target_offer;
  if (!expectedOffer) {
    if (row.offers.length > 0) {
      throw new Error(
        `${entry.donor_id}: Target offer set changed after review; rerun source review`,
      );
    }
  } else {
    if (row.offers.length !== 1) {
      throw new Error(
        `${entry.donor_id}: expected exactly one Target offer, got ${row.offers.length}`,
      );
    }
    const offer = row.offers[0];
    if (
      offer.retailerProductId !== expectedOffer.retailer_product_id ||
      targetProductIdFromUrl(offer.productUrl) !== expectedOffer.retailer_product_id ||
      offer.fetchedAt !== expectedOffer.fetched_at ||
      !offer.isFirstParty ||
      offer.via !== "direct"
    ) {
      throw new Error(
        `${entry.donor_id}: Target source snapshot changed after review ` +
          `(TCIN=${offer.retailerProductId}, URL=${offer.productUrl}, ` +
          `fetchedAt=${offer.fetchedAt}, firstParty=${offer.isFirstParty}, via=${offer.via})`,
      );
    }
  }
  return {
    row,
    entry,
    setUpc,
    setIngredients,
  };
}

async function catalogPreflight(
  prisma: RepairDataClient,
  manifest: DonorEnrichmentManifest,
  verbose: boolean,
): Promise<DonorChange[]> {
  const ids = manifest.donors.map((entry) => entry.donor_id);
  const rows = await prisma.donorProduct.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      title: true,
      upc: true,
      ingredients: true,
      updatedAt: true,
      offers: {
        where: { retailer: "target" },
        select: {
          retailerProductId: true,
          productUrl: true,
          fetchedAt: true,
          isFirstParty: true,
          via: true,
        },
      },
    },
  });
  if (rows.length !== manifest.donors.length) {
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new Error(`Reviewed donor rows missing: ${missing.join(", ")}`);
  }
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const changes = manifest.donors.map((entry) =>
    validateCatalogRow(rowById.get(entry.donor_id)!, entry)
  );

  for (const reviewedAlias of manifest.aliases) {
    const oldDonor = await prisma.donorProduct.findUnique({
      where: { id: reviewedAlias.from_donor_id },
      select: { id: true },
    });
    if (oldDonor) {
      throw new Error(
        `Alias source ${reviewedAlias.from_donor_id} unexpectedly exists; rerun identity review`,
      );
    }
  }
  if (verbose) {
    for (const change of changes) {
      console.log(
        `VERIFY donor=${change.row.id} upc=${change.row.upc ?? "NULL"} ` +
          `ingredients=${isBlank(change.row.ingredients) ? "MISSING" : "PRESENT"}`,
      );
    }
  }
  return changes;
}

async function matrixPreflight(
  prisma: RepairDataClient,
  manifest: DonorEnrichmentManifest,
): Promise<{ scanned: number; occurrences: number; changes: MatrixChange[] }> {
  const matrices = await prisma.variationMatrix.findMany({
    where: {
      bundle_draft: {
        brand: { contains: "Uncrustables" },
        master_bundle_id: { not: null },
      },
    },
    select: {
      id: true,
      bundle_draft_id: true,
      updated_at: true,
      selected_variant_idx: true,
      variants_json: true,
    },
  });
  const reviewedAlias = manifest.aliases[0];
  const targetByMatrixId = new Map(
    reviewedAlias.targets.map((target) => [target.variation_matrix_id, target]),
  );
  const foundTargetIds = new Set<string>();
  const changes: MatrixChange[] = [];
  let occurrences = 0;
  for (const matrix of matrices) {
    const target = targetByMatrixId.get(matrix.id);
    if (!target) {
      const stray = rewriteSelectedVariantAliases({
        variantsJson: matrix.variants_json,
        selectedVariantIdx: matrix.selected_variant_idx,
        manifest,
      });
      if (stray.replacements > 0) {
        throw new Error(
          `Unreviewed alias occurrence in matrix ${matrix.id}; immutable target set drifted`,
        );
      }
      continue;
    }
    foundTargetIds.add(matrix.id);
    if (
      matrix.bundle_draft_id !== target.bundle_draft_id ||
      matrix.selected_variant_idx !== target.selected_variant_idx
    ) {
      throw new Error(
        `Pinned alias matrix ${matrix.id} changed draft/selected index after review`,
      );
    }
    const currentSha = textSha256(matrix.variants_json);
    if (
      currentSha !== target.pre_variants_sha256 &&
      currentSha !== target.post_variants_sha256
    ) {
      throw new Error(
        `Pinned alias matrix ${matrix.id} variants_json digest drifted: ${currentSha}`,
      );
    }
    const selected = selectedVariantFromJson(
      matrix.variants_json,
      matrix.selected_variant_idx,
    );
    if (!selected || selected.idx !== target.expected_variant_idx) {
      throw new Error(`Pinned alias matrix ${matrix.id} selected variant identity drifted`);
    }
    const expectedId = currentSha === target.pre_variants_sha256
      ? reviewedAlias.from_donor_id
      : reviewedAlias.to_donor_id;
    const selectedMatches = selected.composition.filter(
      (component) =>
        component.research_pool_id === expectedId &&
        component.product_name === reviewedAlias.expected_selected_product_name &&
        component.qty === target.expected_qty,
    ).length;
    if (selectedMatches !== target.expected_occurrences) {
      throw new Error(
        `Pinned alias matrix ${matrix.id} expected ${target.expected_occurrences} ` +
          `reviewed component, got ${selectedMatches}`,
      );
    }
    const rewritten = rewriteSelectedVariantAliases({
      variantsJson: matrix.variants_json,
      selectedVariantIdx: matrix.selected_variant_idx,
      manifest,
    });
    const pending = currentSha === target.pre_variants_sha256;
    if (rewritten.replacements !== (pending ? 1 : 0)) {
      throw new Error(`Pinned alias matrix ${matrix.id} replacement count drifted`);
    }
    if (pending && textSha256(rewritten.variantsJson) !== target.post_variants_sha256) {
      throw new Error(`Pinned alias matrix ${matrix.id} projected digest mismatch`);
    }
    occurrences += rewritten.replacements;
    if (rewritten.replacements > 0) {
      changes.push({
        id: matrix.id,
        bundleDraftId: matrix.bundle_draft_id,
        updatedAt: matrix.updated_at,
        selectedVariantIdx: matrix.selected_variant_idx,
        before: matrix.variants_json,
        after: rewritten.variantsJson,
        replacements: rewritten.replacements,
      });
    }
  }
  const missingTargets = reviewedAlias.targets.filter(
    (target) => !foundTargetIds.has(target.variation_matrix_id),
  );
  if (missingTargets.length > 0) {
    throw new Error(
      `Pinned alias matrices missing: ${missingTargets.map((target) => target.variation_matrix_id).join(", ")}`,
    );
  }
  if (
    occurrences !== 0 &&
    occurrences !== reviewedAlias.expected_occurrences
  ) {
    throw new Error(
      `Alias state is partial: expected 0 or ${reviewedAlias.expected_occurrences} ` +
        `pending occurrences, got ${occurrences}`,
    );
  }
  return { scanned: matrices.length, occurrences, changes };
}

async function projectedRecipePostflight(
  prisma: RepairDataClient,
  manifest: DonorEnrichmentManifest,
  verbose: boolean,
): Promise<{ scanned: number; ready: number; blocked: number }> {
  const drafts = await prisma.bundleDraft.findMany({
    where: {
      brand: { contains: "Uncrustables" },
      master_bundle_id: { not: null },
    },
    orderBy: { created_at: "asc" },
    select: {
      id: true,
      draft_name: true,
      pack_count: true,
      variation_matrix: {
        select: { variants_json: true, selected_variant_idx: true },
      },
    },
  });
  const projected = drafts.map((draft) => {
    const selected = draft.variation_matrix
      ? selectedVariantFromJson(
          draft.variation_matrix.variants_json,
          draft.variation_matrix.selected_variant_idx,
        )
      : null;
    return {
      draft,
      variant: projectSelectedVariantAliases(selected, manifest).variant,
    };
  });
  const donorIds = Array.from(new Set(projected.flatMap(({ variant }) =>
    (variant?.composition ?? []).map((component) => component.research_pool_id)
  )));
  const donors = donorIds.length
    ? await prisma.donorProduct.findMany({
        where: { id: { in: donorIds } },
        select: {
          id: true,
          brand: true,
          productLine: true,
          flavor: true,
          title: true,
          category: true,
          upc: true,
          ingredients: true,
          bestPrice: true,
          mainImageUrl: true,
          imageUrls: true,
          needsReview: true,
          offers: {
            where: { isFirstParty: true, via: "direct" },
            orderBy: { price: "asc" },
            select: {
              productUrl: true,
              price: true,
              packSizeSeen: true,
              pricePerUnit: true,
            },
          },
        },
      })
    : [];
  const donorMap = new Map<string, RepairDonor>(donors.map((donor) => {
    const base: RepairDonor = {
      ...donor,
      sourceUrl: donor.offers[0]?.productUrl ?? null,
      offers: donor.offers,
    };
    return [donor.id, projectDonorEnrichment(base, manifest)];
  }));
  let ready = 0;
  let blocked = 0;
  for (const { draft, variant } of projected) {
    const recipe = buildCanonicalRecipe({
      variant,
      packCount: draft.pack_count,
      donors: donorMap,
    });
    if (recipe.ok) {
      ready += 1;
    } else {
      blocked += 1;
      if (verbose) {
        console.log(`POSTFLIGHT BLOCK ${draft.id} ${draft.draft_name}: ${recipe.errors.join(" | ")}`);
      }
    }
  }
  return { scanned: drafts.length, ready, blocked };
}

async function applyTransaction(
  prisma: RootPrisma,
  manifest: DonorEnrichmentManifest,
  donorChanges: DonorChange[],
  matrixChanges: MatrixChange[],
): Promise<{
  donorsUpdated: number;
  matricesUpdated: number;
  aliasesUpdated: number;
  recipesVerified: number;
}> {
  return prisma.$transaction(async (tx) => {
    // Repeat every source and identity precondition after the transaction has
    // started. This closes the race between the outer dry-run/snapshot and the
    // first write, including Target-offer provenance changes.
    const lockedDonorChanges = await catalogPreflight(tx, manifest, false);
    const lockedMatrixPlan = await matrixPreflight(tx, manifest);
    const expectedDonorState = new Map(
      donorChanges.map((change) => [
        change.row.id,
        `${change.row.updatedAt.toISOString()}|${change.setUpc}|${change.setIngredients}`,
      ]),
    );
    if (
      lockedDonorChanges.length !== donorChanges.length ||
      lockedDonorChanges.some(
        (change) =>
          expectedDonorState.get(change.row.id) !==
          `${change.row.updatedAt.toISOString()}|${change.setUpc}|${change.setIngredients}`,
      )
    ) {
      throw new Error("Donor plan changed after the pre-apply snapshot; transaction rolled back");
    }
    const expectedMatrixState = new Map(
      matrixChanges.map((change) => [
        change.id,
        `${change.updatedAt.toISOString()}|${textSha256(change.before)}|${textSha256(change.after)}`,
      ]),
    );
    if (
      lockedMatrixPlan.changes.length !== matrixChanges.length ||
      lockedMatrixPlan.changes.some(
        (change) =>
          expectedMatrixState.get(change.id) !==
          `${change.updatedAt.toISOString()}|${textSha256(change.before)}|${textSha256(change.after)}`,
      )
    ) {
      throw new Error("Alias plan changed after the pre-apply snapshot; transaction rolled back");
    }

    let donorsUpdated = 0;
    for (const change of lockedDonorChanges) {
      if (!change.setUpc && !change.setIngredients) continue;
      const result = await tx.donorProduct.updateMany({
        where: {
          id: change.row.id,
          updatedAt: change.row.updatedAt,
          upc: change.row.upc,
          ingredients: change.row.ingredients,
          title: change.row.title,
        },
        data: {
          ...(change.setUpc ? { upc: change.entry.reviewed.upc } : {}),
          ...(change.setIngredients
            ? { ingredients: change.entry.reviewed.ingredients }
            : {}),
        },
      });
      if (result.count !== 1) {
        throw new Error(
          `${change.row.id}: optimistic donor update failed; transaction rolled back`,
        );
      }
      donorsUpdated += 1;
    }

    let matricesUpdated = 0;
    let aliasesUpdated = 0;
    for (const change of lockedMatrixPlan.changes) {
      const result = await tx.variationMatrix.updateMany({
        where: {
          id: change.id,
          updated_at: change.updatedAt,
          selected_variant_idx: change.selectedVariantIdx,
          variants_json: change.before,
        },
        data: { variants_json: change.after },
      });
      if (result.count !== 1) {
        throw new Error(
          `${change.id}: optimistic VariationMatrix update failed; transaction rolled back`,
        );
      }
      matricesUpdated += 1;
      aliasesUpdated += change.replacements;
    }

    // First-line postflight remains inside the same transaction: actual donor
    // rows and pinned matrices must now be fully reviewed, and every projected
    // canonical recipe must still build. Any failure rolls back all updates.
    const verifiedDonors = await catalogPreflight(tx, manifest, false);
    const verifiedMatrices = await matrixPreflight(tx, manifest);
    const residualFacts = verifiedDonors.filter(
      (change) => change.setUpc || change.setIngredients,
    ).length;
    const recipes = await projectedRecipePostflight(tx, manifest, false);
    if (
      residualFacts > 0 ||
      verifiedMatrices.occurrences > 0 ||
      recipes.blocked > 0
    ) {
      throw new Error(
        `Transactional postflight failed: residual_donors=${residualFacts} ` +
          `residual_aliases=${verifiedMatrices.occurrences} blocked=${recipes.blocked}`,
      );
    }
    return {
      donorsUpdated,
      matricesUpdated,
      aliasesUpdated,
      recipesVerified: recipes.ready,
    };
  }, {
    maxWait: 10_000,
    timeout: 120_000,
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadPinnedManifest();
  const { prisma } = await import("@/lib/prisma");
  try {
    const donorChanges = await catalogPreflight(prisma, manifest, options.verbose);
    const matrixPlan = await matrixPreflight(prisma, manifest);
    const upcsFilled = donorChanges.filter((change) => change.setUpc).length;
    const ingredientsFilled = donorChanges.filter(
      (change) =>
        change.setIngredients &&
        change.entry.catalog_snapshot.ingredients.action === "fill_if_missing",
    ).length;
    const ingredientsReplaced = donorChanges.filter(
      (change) =>
        change.setIngredients &&
        change.entry.catalog_snapshot.ingredients.action === "replace_exact",
    ).length;
    const projected = await projectedRecipePostflight(
      prisma,
      manifest,
      options.verbose,
    );

    console.log(
      `Uncrustables donor enrichment: mode=${options.apply ? "APPLY" : "DRY-RUN"} ` +
        `donors=16 upc_fills=${upcsFilled} ingredient_fills=${ingredientsFilled} ` +
        `ingredient_exact_replacements=${ingredientsReplaced} ` +
        `matrices_scanned=${matrixPlan.scanned} alias_rows=${matrixPlan.changes.length} ` +
        `alias_occurrences=${matrixPlan.occurrences}`,
    );
    console.log(
      `Projected recipe postflight: scanned=${projected.scanned} ready=${projected.ready} ` +
        `blocked=${projected.blocked}`,
    );
    if (projected.blocked > 0) {
      throw new Error("Projected recipe postflight is not zero-blocked; no writes allowed");
    }
    if (!options.apply) {
      console.log("Dry-run complete: no database or marketplace writes were made.");
      return;
    }

    const snapshot = await writePreApplySnapshot({
      manifest,
      donorChanges,
      matrixChanges: matrixPlan.changes,
    });
    console.log(`Pre-apply snapshot: ${snapshot.path}`);
    console.log(`Pre-apply snapshot SHA-256: ${snapshot.sha256}`);
    const result = await applyTransaction(
      prisma,
      manifest,
      donorChanges,
      matrixPlan.changes,
    );
    const afterDonors = await catalogPreflight(prisma, manifest, options.verbose);
    const afterMatrices = await matrixPreflight(prisma, manifest);
    const afterRecipes = await projectedRecipePostflight(
      prisma,
      manifest,
      options.verbose,
    );
    const residualFacts = afterDonors.filter(
      (change) => change.setUpc || change.setIngredients,
    ).length;
    if (
      residualFacts > 0 ||
      afterMatrices.occurrences > 0 ||
      afterRecipes.blocked > 0
    ) {
      throw new Error(
        `Postflight failed: residual_donors=${residualFacts} ` +
          `residual_aliases=${afterMatrices.occurrences} blocked=${afterRecipes.blocked}`,
      );
    }
    console.log(
      `Applied: donors_updated=${result.donorsUpdated} matrices_updated=${result.matricesUpdated} ` +
        `aliases_updated=${result.aliasesUpdated} recipes_verified_in_tx=${result.recipesVerified}`,
    );
    console.log(
      `Postflight: scanned=${afterRecipes.scanned} ready=${afterRecipes.ready} ` +
        `blocked=${afterRecipes.blocked} residual_donors=0 residual_aliases=0`,
    );
    console.log("Marketplace writes: 0 (the CLI has no marketplace integration)." );
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ?? "";
if (/enrich-uncrustables-donors\.(?:ts|js)$/.test(invokedPath)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
