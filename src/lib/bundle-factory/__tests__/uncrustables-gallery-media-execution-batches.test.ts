// node_modules/.bin/tsx --test src/lib/bundle-factory/__tests__/uncrustables-gallery-media-execution-batches.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS,
  GALLERY_MEDIA_ONLY_PROFILE,
  UNCRUSTABLES_APP_ROOT,
  readRepairExecutionSelection,
  readRepairPlan,
  sha256,
  stableJson,
} from "../repair/uncrustables-surgical";

const INDEX_PATH =
  "data/repairs/execution-selections/uncrustables-gallery-media-remaining-118-20260718-v1/UGMEB-20260718T125000000Z-cdd87eb0cc89.json";
const PLAN_SHA256 =
  "8badb989fc9bc5ee9c7ced63029ef9c8cea01d1b494c5766330709dfcf17c477";

interface BatchRecord {
  sequence: number;
  label: string;
  skus: string[];
  action_ids: string[];
  selection_path: string;
  selection_file_sha256: string;
  selection_sha256: string;
  profile: string;
}

interface PreviewEvidence {
  path: string;
  file_sha256: string;
  checkpoint_sha256: string;
  action_id: string;
  sku: string;
  kind: string;
  status: string;
  patch_paths: string[];
}

interface BatchIndex {
  schema_version: string;
  immutable: boolean;
  source_plan: {
    path: string;
    canonical_sha256: string;
  };
  execution_scope: {
    profile: string;
    requested_action_kinds: string[];
    selected_skus: number;
    selected_actions: number;
    forbidden_patch_paths: string[];
    main_paths: number;
    offer_paths: number;
    text_paths: number;
    structured_paths: number;
  };
  exclusions: {
    already_verified: { sku: string; action_id: string };
    outside_final_v8: Array<{ sku: string }>;
  };
  validation_previews: {
    selected_events: number;
    checkpoints: PreviewEvidence[];
  };
  batches: BatchRecord[];
  sha256: string;
}

function absolute(repoPath: string): string {
  return path.join(UNCRUSTABLES_APP_ROOT, repoPath);
}

function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("sealed final-v8 gallery rollout is disjoint, complete, preview-backed, and MAIN-free", async () => {
  const indexBytes = await readFile(absolute(INDEX_PATH));
  const index = JSON.parse(indexBytes.toString("utf8")) as BatchIndex;
  const { sha256: claimedIndexSha256, ...indexBody } = index;
  assert.equal(index.schema_version, "uncrustables-gallery-media-execution-batches/v1");
  assert.equal(index.immutable, true);
  assert.equal(claimedIndexSha256, sha256(stableJson(indexBody)));
  assert.equal(index.source_plan.canonical_sha256, PLAN_SHA256);
  assert.equal(index.execution_scope.profile, GALLERY_MEDIA_ONLY_PROFILE);
  assert.deepEqual(index.execution_scope.requested_action_kinds, ["MEDIA"]);
  assert.deepEqual(
    index.execution_scope.forbidden_patch_paths,
    GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS,
  );
  assert.deepEqual(
    [
      index.execution_scope.main_paths,
      index.execution_scope.offer_paths,
      index.execution_scope.text_paths,
      index.execution_scope.structured_paths,
    ],
    [0, 0, 0, 0],
  );

  const plan = await readRepairPlan(absolute(index.source_plan.path));
  assert.equal(plan.sha256, PLAN_SHA256);
  assert.equal(index.batches.length, 10);
  assert.deepEqual(
    index.batches.map((batch) => batch.skus.length),
    [1, 1, 1, 5, 10, 20, 20, 20, 20, 20],
  );
  assert.deepEqual(
    index.batches.slice(0, 3).map((batch) => batch.skus[0]),
    ["AZ-ASMY-VEQ2", "AG-ASKV-W9EN", "ZX-ASQU-TKU9"],
  );

  const selectedSkus = index.batches.flatMap((batch) => batch.skus);
  const selectedActions = index.batches.flatMap((batch) => batch.action_ids);
  assert.equal(selectedSkus.length, 118);
  assert.equal(new Set(selectedSkus).size, 118);
  assert.equal(selectedActions.length, 118);
  assert.equal(new Set(selectedActions).size, 118);
  assert.ok(selectedActions.every((actionId) => actionId.endsWith(":media")));
  assert.equal(index.execution_scope.selected_skus, 118);
  assert.equal(index.execution_scope.selected_actions, 118);
  for (const excludedSku of [
    index.exclusions.already_verified.sku,
    ...index.exclusions.outside_final_v8.map(({ sku }) => sku),
  ]) {
    assert.ok(!selectedSkus.includes(excludedSku));
  }
  assert.equal(index.exclusions.already_verified.sku, "AD-AS4H-QXZD");
  assert.equal(index.exclusions.already_verified.action_id, "AD-AS4H-QXZD:media");
  assert.deepEqual(
    index.exclusions.outside_final_v8.map(({ sku }) => sku),
    ["TY-AST2-JE9P", "VN-AS1A-D572"],
  );

  for (const batch of index.batches) {
    const selectionBytes = await readFile(absolute(batch.selection_path));
    assert.equal(fileSha256(selectionBytes), batch.selection_file_sha256);
    assert.equal(
      await readFile(`${absolute(batch.selection_path)}.sha256`, "utf8"),
      `${batch.selection_file_sha256}  ${path.basename(batch.selection_path)}\n`,
    );
    const selection = await readRepairExecutionSelection(
      absolute(batch.selection_path),
      plan,
    );
    assert.equal(selection.profile, GALLERY_MEDIA_ONLY_PROFILE);
    assert.equal(selection.sha256, batch.selection_sha256);
    assert.deepEqual(selection.requested_action_kinds, ["MEDIA"]);
    assert.deepEqual(
      selection.forbidden_patch_paths,
      GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS,
    );
    assert.deepEqual(
      [...selection.selected_skus].sort(),
      [...batch.skus].sort(),
    );
    assert.deepEqual(selection.selected_action_ids, batch.action_ids);
  }

  assert.equal(index.validation_previews.selected_events, 118);
  assert.equal(index.validation_previews.checkpoints.length, 118);
  assert.equal(
    new Set(
      index.validation_previews.checkpoints.map(({ action_id }) => action_id),
    ).size,
    118,
  );
  assert.deepEqual(
    [...index.validation_previews.checkpoints.map(({ action_id }) => action_id)].sort(),
    [...selectedActions].sort(),
  );
  await Promise.all(
    index.validation_previews.checkpoints.map(async (preview) => {
      assert.equal(preview.kind, "MEDIA");
      assert.equal(preview.status, "PREVIEW_VALID");
      assert.equal(preview.action_id, `${preview.sku}:media`);
      assert.ok(preview.patch_paths.length > 0);
      assert.ok(
        preview.patch_paths.every((patchPath) =>
          /^\/attributes\/other_product_image_locator_[1-8]$/.test(patchPath),
        ),
      );
      assert.ok(
        !preview.patch_paths.includes("/attributes/main_product_image_locator"),
      );
      const bytes = await readFile(absolute(preview.path));
      assert.equal(fileSha256(bytes), preview.file_sha256);
      const checkpoint = JSON.parse(bytes.toString("utf8")) as Record<
        string,
        unknown
      >;
      const { sha256: checkpointClaimed, ...checkpointBody } = checkpoint;
      assert.equal(checkpointClaimed, preview.checkpoint_sha256);
      assert.equal(checkpointClaimed, sha256(stableJson(checkpointBody)));
    }),
  );
});
