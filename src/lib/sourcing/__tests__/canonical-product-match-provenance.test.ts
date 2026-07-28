import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_PRODUCT_MATCHER_VERSION as PUBLIC_MATCHER_VERSION,
} from "../canonical-product-match";
import {
  CANONICAL_PRODUCT_MATCHER_PROVENANCE,
  CANONICAL_PRODUCT_MATCHER_PROVENANCE_SCHEMA_VERSION,
  CANONICAL_PRODUCT_MATCHER_RELEASE_MANIFEST,
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_PATH,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "../canonical-product-match-provenance";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MATCHER_SOURCE = fileURLToPath(new URL("../canonical-product-match.ts", import.meta.url));

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("canonical JSON rejects undefined");
  return encoded;
}

test("canonical matcher provenance pins the exact 1.2.1 source bytes", async () => {
  const projectRelativePath = relative(PROJECT_ROOT, MATCHER_SOURCE).split(sep).join("/");
  const sourceBytes = await readFile(MATCHER_SOURCE);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

  assert.equal(CANONICAL_PRODUCT_MATCHER_VERSION, "canonical-product-match/1.2.1");
  assert.equal(PUBLIC_MATCHER_VERSION, CANONICAL_PRODUCT_MATCHER_VERSION);
  assert.equal(CANONICAL_PRODUCT_MATCHER_SOURCE_PATH, projectRelativePath);
  assert.match(CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256, sourceSha256);
  assert.equal(
    CANONICAL_PRODUCT_MATCHER_PROVENANCE_SCHEMA_VERSION,
    "canonical-product-match-provenance/1.0.0",
  );
  assert.deepEqual(CANONICAL_PRODUCT_MATCHER_RELEASE_MANIFEST, {
    schemaVersion: CANONICAL_PRODUCT_MATCHER_PROVENANCE_SCHEMA_VERSION,
    matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
    sourcePath: CANONICAL_PRODUCT_MATCHER_SOURCE_PATH,
    sourceSha256: CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  });
  assert.equal(
    CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
    createHash("sha256")
      .update(canonicalJson(CANONICAL_PRODUCT_MATCHER_RELEASE_MANIFEST), "utf8")
      .digest("hex"),
  );
  assert.equal(
    CANONICAL_PRODUCT_MATCHER_PROVENANCE,
    CANONICAL_PRODUCT_MATCHER_RELEASE_MANIFEST,
  );
  assert.equal(Object.isFrozen(CANONICAL_PRODUCT_MATCHER_RELEASE_MANIFEST), true);
  assert.equal(Object.isFrozen(CANONICAL_PRODUCT_MATCHER_PROVENANCE), true);
});
