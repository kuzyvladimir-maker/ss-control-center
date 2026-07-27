// node --import tsx --test src/lib/bundle-factory/__tests__/uncrustables-safe-launch-promo.test.ts

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  SAFE_LAUNCH_PROMO_FILES,
  SAFE_LAUNCH_PROMO_IDENTITY_HOLDS,
  SAFE_LAUNCH_PROMO_PINNED_SOURCES,
  SAFE_LAUNCH_PROMO_PREPARED_AT,
  SAFE_LAUNCH_PROMO_WINDOW,
  buildSafeLaunchPromoArtifact,
  safeLaunchPromoSha256,
  verifySafeLaunchPromoArtifact,
  type BuildSafeLaunchPromoInput,
  type SafeLaunchPromoManifest,
  type SafeLaunchPromoSource,
} from "../repair/uncrustables-safe-launch-promo";

const ARTIFACT_DIR =
  "data/repairs/launch-pricing/" +
  "uncrustables-safe-promo-161-20260720-20260819-v1";

async function load(source: {
  path: string;
  file_sha256: string;
}): Promise<SafeLaunchPromoSource> {
  return { path: source.path, bytes: await readFile(source.path) };
}

async function fixture(): Promise<BuildSafeLaunchPromoInput> {
  const source = SAFE_LAUNCH_PROMO_PINNED_SOURCES;
  const [launchManifest, assignments, couponSpec, salePriceSpec, safeBase, safeTsv] =
    await Promise.all([
      load(source.launch_manifest),
      load(source.assignments),
      load(source.coupon_spec),
      load(source.sale_price_spec),
      load(source.safe_base_offer_manifest),
      load(source.safe_base_offer_tsv),
    ]);
  return {
    launchManifest,
    assignments,
    couponSpec,
    salePriceSpec,
    safeBaseOfferManifest: safeBase,
    safeBaseOfferTsv: safeTsv,
  };
}

test("builds exact safe 161-row A/B projection with preserved 81/80 assignments", async () => {
  const built = buildSafeLaunchPromoArtifact(await fixture());
  assert.equal(built.manifest.prepared_at, SAFE_LAUNCH_PROMO_PREPARED_AT);
  assert.deepEqual(built.manifest.window, SAFE_LAUNCH_PROMO_WINDOW);
  assert.equal(built.manifest.rows.length, 161);
  assert.equal(built.manifest.scope.coupon_rows, 81);
  assert.equal(built.manifest.scope.sale_price_rows, 80);
  assert.equal(
    built.manifest.rows.filter((row) => row.arm === "A").length,
    81,
  );
  assert.equal(
    built.manifest.rows.filter((row) => row.arm === "B").length,
    80,
  );
  const heldSkus = new Set<string>(SAFE_LAUNCH_PROMO_IDENTITY_HOLDS.map((row) => row.sku));
  assert.equal(built.manifest.rows.some((row) => heldSkus.has(row.sku)), false);
  assert.deepEqual(
    built.manifest.identity_holds.map((row) => row.sku),
    ["SZ-ASPI-JFAT", "TY-AST2-JE9P", "VN-AS1A-D572"],
  );
  assert.deepEqual(
    built.manifest.coupon_controls.groups.map((group) => [
      group.count,
      group.asin_count,
    ]),
    [
      [24, 46],
      [30, 10],
      [45, 10],
      [90, 8],
      [120, 7],
    ],
  );
  assert.equal(built.assignmentsCsv.trimEnd().split("\n").length, 162);
  assert.equal(built.couponsCsv.trimEnd().split("\n").length, 6);
  assert.equal(built.salePricesCsv.trimEnd().split("\n").length, 81);
  assert.equal(built.manifest.authority.owner_approval_received, false);
  assert.equal(built.manifest.authority.execution_authorized, false);
  assert.equal(built.manifest.authority.amazon_live_mutations_performed, false);
  assert.equal(built.manifest.authority.channelmax_live_mutations_performed, false);
  assert.equal(built.manifest.authority.external_mutations, 0);
  verifySafeLaunchPromoArtifact(built.manifest, built);
});

test("remaining assignments are byte-preserved apart from exact SZ/TY exclusions", async () => {
  const input = await fixture();
  const built = buildSafeLaunchPromoArtifact(input);
  const sourceAssignmentLines = input.assignments.bytes
    .toString("utf8")
    .trimEnd()
    .split("\n");
  const expectedAssignments = [
    sourceAssignmentLines[0],
    ...sourceAssignmentLines.slice(1).filter((line) => {
      const sku = line.split(",")[1];
      return sku !== "SZ-ASPI-JFAT" && sku !== "TY-AST2-JE9P";
    }),
  ].join("\n");
  assert.equal(built.assignmentsCsv.trimEnd(), expectedAssignments);

  const sourceSaleLines = input.salePriceSpec.bytes
    .toString("utf8")
    .trimEnd()
    .split("\n");
  const expectedSalePrices = sourceSaleLines
    .filter((line, index) => index === 0 || line.split(",")[1] !== "TY-AST2-JE9P")
    .join("\n");
  assert.equal(built.salePricesCsv.trimEnd(), expectedSalePrices);
  assert.equal(built.couponsCsv.includes("B0H776M5B5"), false);
  assert.equal(built.couponsCsv.includes("B0H84WQRXB"), false);
  assert.equal(built.couponsCsv.includes("B0H82PKK18"), false);
});

test("builder fails closed on pinned source byte or path drift", async () => {
  const tampered = await fixture();
  tampered.couponSpec = {
    ...tampered.couponSpec,
    bytes: Buffer.concat([tampered.couponSpec.bytes, Buffer.from(" ")]),
  };
  assert.throws(
    () => buildSafeLaunchPromoArtifact(tampered),
    /exact pinned canonical source/,
  );

  const wrongPath = await fixture();
  wrongPath.safeBaseOfferManifest = {
    ...wrongPath.safeBaseOfferManifest,
    path: `${wrongPath.safeBaseOfferManifest.path}.copy`,
  };
  assert.throws(
    () => buildSafeLaunchPromoArtifact(wrongPath),
    /exact pinned canonical source/,
  );
});

test("verifier rejects authorization, hold, window, arm, or CSV mutation", async () => {
  const built = buildSafeLaunchPromoArtifact(await fixture());
  const files = {
    assignmentsCsv: built.assignmentsCsv,
    couponsCsv: built.couponsCsv,
    salePricesCsv: built.salePricesCsv,
  };

  const authorized = structuredClone(built.manifest);
  authorized.authority.execution_authorized = true as false;
  assert.throws(
    () => verifySafeLaunchPromoArtifact(authorized, files),
    /authority or offline boundary/,
  );

  const insertedHold = structuredClone(built.manifest);
  insertedHold.rows[0].sku = "SZ-ASPI-JFAT";
  assert.throws(
    () => verifySafeLaunchPromoArtifact(insertedHold, files),
    /row 1 is invalid/,
  );

  const changedWindow = structuredClone(built.manifest);
  (changedWindow.window as { end_date: string }).end_date = "2026-08-20";
  assert.throws(
    () => verifySafeLaunchPromoArtifact(changedWindow, files),
    /strategy, window, holds, or tier policy drifted/,
  );

  const movedArm = structuredClone(built.manifest);
  movedArm.rows[0].arm = (movedArm.rows[0].arm === "A" ? "B" : "A");
  assert.throws(
    () => verifySafeLaunchPromoArtifact(movedArm, files),
    /row 1 is invalid|schedule is invalid/,
  );

  assert.throws(
    () =>
      verifySafeLaunchPromoArtifact(built.manifest, {
        ...files,
        salePricesCsv: built.salePricesCsv.replace("66.98", "66.97"),
      }),
    /files or output bindings/,
  );
});

test("checked-in artifact and all sidecars match exact deterministic builder output", async () => {
  const built = buildSafeLaunchPromoArtifact(await fixture());
  const manifestPath = path.join(ARTIFACT_DIR, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(
    manifestBytes.toString("utf8"),
  ) as SafeLaunchPromoManifest;
  assert.deepEqual(manifest, built.manifest);

  const outputFiles = [
    [SAFE_LAUNCH_PROMO_FILES.assignments, built.assignmentsCsv],
    [SAFE_LAUNCH_PROMO_FILES.coupons, built.couponsCsv],
    [SAFE_LAUNCH_PROMO_FILES.sale_prices, built.salePricesCsv],
  ] as const;
  for (const [fileName, expected] of outputFiles) {
    const bytes = await readFile(path.join(ARTIFACT_DIR, fileName));
    const sidecar = await readFile(
      path.join(ARTIFACT_DIR, `${fileName}.sha256`),
      "utf8",
    );
    assert.equal(bytes.toString("utf8"), expected);
    assert.equal(sidecar, `${safeLaunchPromoSha256(bytes)}  ${fileName}\n`);
  }
  const manifestSidecar = await readFile(`${manifestPath}.sha256`, "utf8");
  assert.equal(
    manifestSidecar,
    `${safeLaunchPromoSha256(manifestBytes)}  manifest.json\n`,
  );
  verifySafeLaunchPromoArtifact(manifest, {
    assignmentsCsv: built.assignmentsCsv,
    couponsCsv: built.couponsCsv,
    salePricesCsv: built.salePricesCsv,
  });
});

test("offline builder has no network, browser, database, or marketplace client import", async () => {
  const source = await readFile(
    "scripts/build-uncrustables-safe-launch-promo.ts",
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["']node:(?:http|https|net|tls)["']/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /amazon-sp-api|channelmax-agent|prisma|libsql/i);
});
