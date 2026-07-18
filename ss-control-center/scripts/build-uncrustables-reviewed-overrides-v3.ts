/**
 * Seal the all-164 factual-content rewrite and its offline audit.
 *
 * Exact pinned local reads and immutable local writes only. No external client
 * is imported and no network, DB, Amazon, or object-storage write can occur.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildUncrustablesReviewedOverridesV3,
  type AmazonFoodPtdEvidenceForFullFactualRewrite,
  type FullFactualRewriteSources,
  type UncrustablesDonorEvidenceForFullFactualRewrite,
  type UncrustablesLedgerForFullFactualRewrite,
} from "../src/lib/bundle-factory/repair/uncrustables-reviewed-overrides-v3";
import type { DesiredRepairManifest } from "../src/lib/bundle-factory/repair/uncrustables-surgical";

const SOURCE_PINS = {
  ledger: {
    path: "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json",
    sha256: "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f",
  },
  prior_reviewed_overrides: {
    path: "data/repairs/uncrustables-reviewed-overrides-20260718-v2.json",
    sha256: "07c4a12b11083471096fd88054564146d7ef823c5075f4468eb0cef96f49b885",
  },
  donor_manifest: {
    path: "data/repairs/uncrustables-donor-enrichment-20260717.json",
    sha256: "999348227982c169477ad13fb806ddba42fb15cb68397308e4289a9cbbcee9f9",
  },
  ptd_attribute_proof: {
    path: "data/audits/amazon-food-ptd-attribute-proof-20260718T010205Z.json",
    sha256: "98f65723cdb9fd4dedc63317e7ad08bd45e17c95917e3b0ee9e372956a1d0ec9",
  },
  owner_fulfillment_handoff: {
    path: "../HANDOFF_Uncrustables_2026-07-17.md",
    sha256: "8ca9bb574a7d940b636871bb1fdfe1c0d6b88bbb39c9833812493f8746bb7841",
    locator: "line 19",
  },
  frozen_cost_model: {
    path: "src/lib/pricing/cost-model.ts",
    sha256: "394fc8a0c8b11fcad44092092958b6a9ca82cc471c4e4fd93d84633ad3b7c9d9",
  },
  frozen_image_policy: {
    path: "src/lib/bundle-factory/image-pipeline.ts",
    sha256: "0c7178cba64c87af384263de5a56cd6d252666f96ef1c0a0dc3a6a95035c9a5a",
  },
  renderer: {
    path: "src/lib/bundle-factory/repair/uncrustables-content.ts",
    sha256: "de05471a84ab911d860816349e875ef9dc6cd3d591b500b026cf94027891e79d",
  },
} as const satisfies FullFactualRewriteSources;

const MANIFEST_OUTPUT =
  "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r6.json";
const AUDIT_OUTPUT =
  "data/audits/uncrustables-factual-content-audit-20260718-v6.json";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exactRead(root: string, source: { path: string; sha256: string }): Promise<Buffer> {
  const bytes = await readFile(path.resolve(root, source.path));
  const actual = sha256(bytes);
  assert(actual === source.sha256, `${source.path} SHA-256 mismatch: expected ${source.sha256}, got ${actual}`);
  return bytes;
}

async function writeIdenticalOrCreate(absolutePath: string, bytes: Buffer): Promise<void> {
  try {
    const existing = await readFile(absolutePath);
    assert(existing.equals(bytes), `Refusing to overwrite immutable artifact: ${absolutePath}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporary = `${absolutePath}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, absolutePath);
}

async function writeArtifact(root: string, relativePath: string, payload: unknown): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  const digest = sha256(bytes);
  await writeIdenticalOrCreate(path.resolve(root, relativePath), bytes);
  await writeIdenticalOrCreate(
    path.resolve(root, `${relativePath}.sha256`),
    Buffer.from(`${digest}  ${path.basename(relativePath)}\n`),
  );
  return digest;
}

async function main(): Promise<void> {
  assert(process.argv.length === 2, "This pinned builder accepts no runtime overrides");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [
    ledgerBytes,
    priorBytes,
    donorBytes,
    ptdBytes,
    fulfillmentHandoffBytes,
    costModelBytes,
    imagePolicyBytes,
    rendererBytes,
  ] = await Promise.all([
    exactRead(root, SOURCE_PINS.ledger),
    exactRead(root, SOURCE_PINS.prior_reviewed_overrides),
    exactRead(root, SOURCE_PINS.donor_manifest),
    exactRead(root, SOURCE_PINS.ptd_attribute_proof),
    exactRead(root, SOURCE_PINS.owner_fulfillment_handoff),
    exactRead(root, SOURCE_PINS.frozen_cost_model),
    exactRead(root, SOURCE_PINS.frozen_image_policy),
    exactRead(root, SOURCE_PINS.renderer),
  ]);
  assert(
    [costModelBytes, imagePolicyBytes, rendererBytes].every((bytes) => bytes.length > 0),
    "A frozen-program policy source is empty",
  );
  const { manifest, audit } = buildUncrustablesReviewedOverridesV3({
    ledger: JSON.parse(ledgerBytes.toString("utf8")) as UncrustablesLedgerForFullFactualRewrite,
    priorManifest: JSON.parse(priorBytes.toString("utf8")) as DesiredRepairManifest,
    donorManifest: JSON.parse(
      donorBytes.toString("utf8"),
    ) as UncrustablesDonorEvidenceForFullFactualRewrite,
    ptdProof: JSON.parse(
      ptdBytes.toString("utf8"),
    ) as AmazonFoodPtdEvidenceForFullFactualRewrite,
    fulfillmentHandoffText: fulfillmentHandoffBytes.toString("utf8"),
    sources: SOURCE_PINS,
  });
  const manifestSha256 = await writeArtifact(root, MANIFEST_OUTPUT, manifest);
  const auditSha256 = await writeArtifact(root, AUDIT_OUTPUT, audit);
  process.stdout.write(`${JSON.stringify({
    manifest: { path: MANIFEST_OUTPUT, sha256: manifestSha256, repairs: manifest.repairs.length },
    audit: { path: AUDIT_OUTPUT, sha256: auditSha256, summary: audit.summary },
  })}\n`);
}

await main();
