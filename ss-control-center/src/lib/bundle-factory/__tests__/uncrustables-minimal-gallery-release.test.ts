// node --import tsx --test src/lib/bundle-factory/__tests__/uncrustables-minimal-gallery-release.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  verifyPreChangeSnapshot,
  type SnapshotFieldState,
  type UncrustablesPreChangeSnapshot,
} from "../repair/uncrustables-amazon-rollback";
import {
  sealMinimalGalleryArtifact,
  verifyMinimalGalleryCasRow,
  verifyMinimalGalleryHeldSelection,
  verifyMinimalGalleryReleaseBundle,
  type MinimalGalleryCasRow,
  type MinimalGalleryHeldSelection,
  type MinimalGalleryReleaseBundle,
} from "../repair/uncrustables-minimal-gallery-release";
import {
  GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS,
  GALLERY_MEDIA_ONLY_PROFILE,
  UNCRUSTABLES_APP_ROOT,
  readRepairExecutionSelection,
  readRepairPlan,
  stableJson,
} from "../repair/uncrustables-surgical";

const OUTPUT_DIRECTORY =
  "data/repairs/gallery-minimal/uncrustables-minimal-gallery-repair-3-20260719-v1";
const OUTPUT_ROOT = path.join(UNCRUSTABLES_APP_ROOT, OUTPUT_DIRECTORY);
const MANIFEST_PATH = path.join(
  OUTPUT_ROOT,
  "uncrustables-minimal-gallery-desired-manifest-3-20260719-v1.json",
);

function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function oneFile(directory: string, prefix: string): Promise<string> {
  const matches = (await readdir(directory)).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".json"),
  );
  assert.equal(matches.length, 1, `Expected one ${prefix}*.json in ${directory}.`);
  return path.join(directory, matches[0]);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function assertSidecar(file: string): Promise<void> {
  const bytes = await readFile(file);
  assert.equal(
    await readFile(`${file}.sha256`, "utf8"),
    `${fileSha256(bytes)}  ${path.basename(file)}\n`,
  );
}

function reseal<T extends Record<string, unknown>>(value: T): T & { sha256: string } {
  const body = structuredClone(value) as Record<string, unknown>;
  delete body.sha256;
  return sealMinimalGalleryArtifact(body) as T & { sha256: string };
}

test("minimal gallery bundle is exact, immutable, CAS-bound, and gallery-only", async () => {
  const planPath = await oneFile(OUTPUT_ROOT, "URP-");
  const releasePath = await oneFile(OUTPUT_ROOT, "UMGRB-");
  const canaryPath = await oneFile(path.join(OUTPUT_ROOT, "canary-ua-vc"), "URES-");
  const heldPath = await oneFile(path.join(OUTPUT_ROOT, "held-sz"), "UGHES-");
  await Promise.all(
    [planPath, releasePath, canaryPath, heldPath, MANIFEST_PATH].map(assertSidecar),
  );

  const plan = await readRepairPlan(planPath);
  const canary = await readRepairExecutionSelection(canaryPath, plan);
  const held = await readJson<MinimalGalleryHeldSelection>(heldPath);
  const release = await readJson<MinimalGalleryReleaseBundle>(releasePath);
  verifyMinimalGalleryHeldSelection(held);
  verifyMinimalGalleryReleaseBundle(release);

  assert.equal(release.repair_plan.file_sha256, fileSha256(await readFile(planPath)));
  assert.equal(release.repair_plan.canonical_sha256, plan.sha256);
  assert.equal(release.canary.selection_file_sha256, fileSha256(await readFile(canaryPath)));
  assert.equal(release.canary.selection_sha256, canary.sha256);
  assert.equal(release.held_sz.selection_file_sha256, fileSha256(await readFile(heldPath)));
  assert.equal(release.held_sz.selection_sha256, held.sha256);

  assert.deepEqual(plan.entries.map(({ sku }) => sku), [
    "SZ-ASPI-JFAT",
    "UA-ASAO-RE7Q",
    "VC-ASV1-378P",
  ]);
  assert.equal(plan.entries.length, 3);
  assert.equal(plan.entries.flatMap(({ actions }) => actions).length, 3);
  const exactSlots = new Map<string, number[]>([
    ["SZ-ASPI-JFAT", [2, 3, 4, 5]],
    ["UA-ASAO-RE7Q", [1, 7]],
    ["VC-ASV1-378P", [1, 7]],
  ]);
  for (const entry of plan.entries) {
    assert.equal(entry.actions.length, 1);
    const action = entry.actions[0];
    assert.equal(action.action_id, `${entry.sku}:media`);
    assert.equal(action.kind, "MEDIA");
    assert.equal(action.desired.kind, "MEDIA");
    if (action.desired.kind !== "MEDIA") assert.fail("MEDIA union narrowing failed.");
    assert.deepEqual(
      action.desired.value.gallery_slots.map(({ slot }) => slot),
      exactSlots.get(entry.sku),
    );
    assert.equal(action.desired.value.main_image_url, undefined);
    assert.equal(action.desired.value.delete_gallery_slots, undefined);
  }

  assert.equal(canary.profile, GALLERY_MEDIA_ONLY_PROFILE);
  assert.deepEqual(canary.requested_action_kinds, ["MEDIA"]);
  assert.deepEqual(canary.selected_skus, ["UA-ASAO-RE7Q", "VC-ASV1-378P"]);
  assert.deepEqual(canary.selected_action_ids, [
    "UA-ASAO-RE7Q:media",
    "VC-ASV1-378P:media",
  ]);
  assert.deepEqual(canary.forbidden_patch_paths, GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS);
  assert.ok(canary.forbidden_patch_paths.includes("/attributes/main_product_image_locator"));
  assert.ok(canary.forbidden_patch_paths.includes("/attributes/purchasable_offer"));
  assert.ok(canary.forbidden_patch_paths.includes("/attributes/item_name"));

  assert.equal(release.canary.execution_authorized_now, false);
  assert.equal(release.fresh_rollback_prerequisite.status, "REQUIRED_NOT_PRESENT");
  assert.equal(release.fresh_rollback_prerequisite.exact_scope, 164);
  assert.equal(release.current_cas.apply_eligible_for_this_plan, false);
  assert.equal(held.execution_authorized, false);
  assert.equal(held.confirmation_token, null);
  assert.equal(held.confirmation_token_emitted, false);
  assert.equal(held.identity_hold.amazon_asin, "B0H776M5B5");
  assert.equal(held.identity_hold.channelmax_asin, "B0H75VN18Z");
  assert.ok(held.identity_hold.reason_codes.includes("CHANNELMAX_IDENTITY_MISMATCH"));

  const snapshotPath = path.join(
    UNCRUSTABLES_APP_ROOT,
    release.current_cas.source_snapshot_path,
  );
  const snapshot = await readJson<UncrustablesPreChangeSnapshot>(snapshotPath);
  verifyPreChangeSnapshot(snapshot);
  assert.equal(snapshot.scope.captured, 164);
  assert.equal(snapshot.capture_mode, "LIVE_SP_API");
  assert.equal(fileSha256(await readFile(snapshotPath)), release.current_cas.source_snapshot_file_sha256);
  for (const cas of release.current_cas.rows) {
    const source = snapshot.entries.find(({ sku }) => sku === cas.sku);
    assert.ok(source, `Missing snapshot source for ${cas.sku}.`);
    assert.equal(cas.asin, source.asin);
    assert.equal(cas.listing_sha256, source.listing_sha256);
    for (const touched of cas.touched_paths) {
      const sourceField: SnapshotFieldState | undefined = source.fields[touched.path];
      if (touched.before.present) {
        assert.ok(sourceField, `Missing current field ${cas.sku} ${touched.path}.`);
        assert.deepEqual(touched.before, sourceField);
      } else {
        assert.equal(sourceField, undefined);
      }
    }
  }

  for (const source of Object.values(release.source_artifacts)) {
    assert.equal(
      fileSha256(await readFile(path.join(UNCRUSTABLES_APP_ROOT, source.path))),
      source.file_sha256,
      `Source artifact SHA drift: ${source.path}`,
    );
  }
  assert.deepEqual(release.external_mutations, {
    amazon_gets: 0,
    amazon_patches: 0,
    database_writes: 0,
    uploads: 0,
    channelmax_writes: 0,
  });
});

test("minimal gallery verifiers fail closed on scope, authorization, and CAS tampering", async () => {
  const releasePath = await oneFile(OUTPUT_ROOT, "UMGRB-");
  const heldPath = await oneFile(path.join(OUTPUT_ROOT, "held-sz"), "UGHES-");
  const release = await readJson<MinimalGalleryReleaseBundle>(releasePath);
  const held = await readJson<MinimalGalleryHeldSelection>(heldPath);

  const executableHeldBody = structuredClone(held) as unknown as Record<string, unknown>;
  executableHeldBody.execution_authorized = true;
  const executableHeld = reseal(executableHeldBody);
  assert.throws(
    () => verifyMinimalGalleryHeldSelection(executableHeld as unknown as MinimalGalleryHeldSelection),
    /invalid or executable/,
  );

  const mainCrossingBody = structuredClone(release) as unknown as Record<string, unknown>;
  const mainSafety = mainCrossingBody.safety_boundary as Record<string, unknown>;
  mainSafety.allowed_patch_paths = [
    ...((mainSafety.allowed_patch_paths as string[]) ?? []),
    "/attributes/main_product_image_locator",
  ];
  const mainCrossing = reseal(mainCrossingBody);
  assert.throws(
    () => verifyMinimalGalleryReleaseBundle(mainCrossing as unknown as MinimalGalleryReleaseBundle),
    /safety boundary was weakened/,
  );

  const authorizedCanaryBody = structuredClone(release) as unknown as Record<string, unknown>;
  (authorizedCanaryBody.canary as Record<string, unknown>).execution_authorized_now = true;
  const authorizedCanary = reseal(authorizedCanaryBody);
  assert.throws(
    () => verifyMinimalGalleryReleaseBundle(authorizedCanary as unknown as MinimalGalleryReleaseBundle),
    /Canary release contract is not fail-closed/,
  );

  const wrongSkuBody = structuredClone(release) as unknown as Record<string, unknown>;
  const wrongRows = (wrongSkuBody.current_cas as { rows: MinimalGalleryCasRow[] }).rows;
  wrongRows[0].sku = "WRONG-SKU";
  (wrongSkuBody.current_cas as Record<string, unknown>).rows_sha256 = createHash("sha256")
    .update(stableJson(wrongRows))
    .digest("hex");
  const wrongSku = reseal(wrongSkuBody);
  assert.throws(
    () => verifyMinimalGalleryReleaseBundle(wrongSku as unknown as MinimalGalleryReleaseBundle),
    /exactly three rows/,
  );

  const badCas = structuredClone(release.current_cas.rows[0]);
  badCas.touched_paths[0].before.sha256 = "0".repeat(64);
  const badCasBody = { ...badCas } as Partial<MinimalGalleryCasRow>;
  delete badCasBody.cas_sha256;
  badCas.cas_sha256 = createHash("sha256").update(stableJson(badCasBody)).digest("hex");
  assert.throws(() => verifyMinimalGalleryCasRow(badCas), /before-state SHA mismatch/);
});
