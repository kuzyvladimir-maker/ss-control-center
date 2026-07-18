// node --experimental-strip-types --experimental-loader ./scripts/node-native-ts-loader.mjs \
//   --test src/lib/bundle-factory/__tests__/uncrustables-gallery-desired-manifest.test.ts

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  VERIFIED_BRAND_CARD_REHOST_URL,
  buildRepairPlan,
  sha256,
  stableJson,
  type DesiredRepairManifest,
} from "../repair/uncrustables-surgical";

const LEDGER_PATH =
  "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
const GALLERY_PLAN_PATH =
  "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v1.json";
const OVERRIDES_PATH =
  "data/repairs/uncrustables-reviewed-overrides-20260717.json";
const MANIFEST_PATH =
  "data/repairs/uncrustables-gallery-merged-desired-20260718-v1.json";
const MANIFEST_FILE_SHA256 =
  "4b37083be7de15212b5988c02816f6722cd4649dadfb8a6a778223766d823dd6";

test("sealed gallery desired manifest preserves reviewed overrides and builds a blocker-free 164-SKU dry plan", async () => {
  const [ledgerBytes, galleryBytes, overridesBytes, manifestBytes, sidecar] =
    await Promise.all([
      readFile(LEDGER_PATH),
      readFile(GALLERY_PLAN_PATH),
      readFile(OVERRIDES_PATH),
      readFile(MANIFEST_PATH),
      readFile(`${MANIFEST_PATH}.sha256`, "utf8"),
    ]);
  assert.equal(sha256(manifestBytes), MANIFEST_FILE_SHA256);
  assert.equal(
    sidecar,
    `${MANIFEST_FILE_SHA256}  uncrustables-gallery-merged-desired-20260718-v1.json\n`,
  );

  const galleryPlan = JSON.parse(galleryBytes.toString("utf8")) as {
    rows: Array<{ sku: string }>;
  };
  const overrides = JSON.parse(
    overridesBytes.toString("utf8"),
  ) as DesiredRepairManifest;
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as
    DesiredRepairManifest & {
      body_sha256: string;
      source_artifacts: {
        gallery_surgical_plan: { sha256: string };
        reviewed_overrides: { sha256: string };
      };
      merge_summary: {
        source_override_repairs: number;
        merged_repairs: number;
        media_repairs: number;
        explicit_tail_slot_deletions: number;
      };
    };
  const { body_sha256: bodySha256, ...body } = manifest;
  assert.equal(sha256(stableJson(body)), bodySha256);
  assert.equal(
    manifest.source_artifacts.gallery_surgical_plan.sha256,
    sha256(galleryBytes),
  );
  assert.equal(
    manifest.source_artifacts.reviewed_overrides.sha256,
    sha256(overridesBytes),
  );
  assert.deepEqual(manifest.merge_summary, {
    source_gallery_rows: 164,
    source_gallery_keep_no_write: 44,
    source_gallery_rebuild: 120,
    source_override_repairs: 4,
    overlapping_repairs: 2,
    merged_repairs: 122,
    media_repairs: 120,
    ordered_gallery_replacements: 120,
    explicit_tail_slot_deletions: 194,
  });

  const mergedBySku = new Map(
    manifest.repairs.map((repair) => [repair.sku, repair]),
  );
  for (const original of overrides.repairs) {
    const merged = structuredClone(mergedBySku.get(original.sku));
    assert.ok(merged, `Missing reviewed override ${original.sku}.`);
    delete merged.media;
    assert.deepEqual(merged, original);
  }

  const mediaRepairs = manifest.repairs.filter((repair) => repair.media);
  assert.equal(mediaRepairs.length, 120);
  for (const repair of mediaRepairs) {
    const gallery = repair.media?.gallery_image_urls ?? [];
    assert.ok(gallery.length >= 5 && gallery.length <= 7);
    assert.equal(gallery[0], VERIFIED_BRAND_CARD_REHOST_URL);
    assert.equal(new Set(gallery).size, gallery.length);
    assert.deepEqual(
      repair.media?.delete_gallery_slots,
      Array.from(
        { length: 8 - gallery.length },
        (_, index) => gallery.length + 1 + index,
      ),
    );
  }

  const skus = galleryPlan.rows.map((row) => row.sku);
  const plan = buildRepairPlan({
    ledgerPath: LEDGER_PATH,
    ledgerBytes,
    manifest,
    skus,
    createdAt: new Date("2026-07-18T04:08:55.607Z"),
  });
  const actions = plan.entries.flatMap((entry) => entry.actions);
  assert.equal(plan.scope.entries, 164);
  assert.equal(plan.scope.blocked, 0);
  assert.equal(actions.length, 287);
  assert.equal(actions.filter((action) => action.kind === "MEDIA").length, 120);
  assert.equal(actions.filter((action) => action.kind === "OFFER").length, 164);
  assert.equal(actions.filter((action) => action.kind === "TEXT_COUNT").length, 3);
  assert.equal(
    actions
      .filter((action) => action.desired.kind === "MEDIA")
      .reduce(
        (sum, action) =>
          sum +
          (action.desired.kind === "MEDIA"
            ? action.desired.value.delete_gallery_slots?.length ?? 0
            : 0),
        0,
      ),
    194,
  );
});
