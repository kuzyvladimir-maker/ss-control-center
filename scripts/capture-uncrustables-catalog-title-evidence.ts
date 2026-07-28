/**
 * Read-only cross-check of catalog item_name conflicts reported by an
 * immutable Listings Items VALIDATION_PREVIEW checkpoint set.
 *
 * The script never calls a Listings mutation endpoint. It re-reads each
 * conflicting ASIN through Catalog Items v2022-04-01, requires the catalog
 * title to exactly equal the title embedded in Amazon's preview issue, and
 * writes a SHA-sealed evidence artifact with create-new semantics.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { config } from "dotenv";

import { MARKETPLACE_ID, spApiGet } from "@/lib/amazon-sp-api/client";
import {
  CHECKPOINT_SCHEMA,
  sha256,
  stableJson,
  type CheckpointEvent,
  type UncrustablesRepairPlan,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

type UnknownRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function option(name: string): string {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  const value = raw?.slice(prefix.length).trim();
  if (!value) throw new Error(`Missing --${name}=PATH.`);
  return value;
}

function previewPayload(error: string): UnknownRecord {
  const start = error.indexOf(": {");
  assert(start >= 0, "FAILED checkpoint does not contain a preview response.");
  const parsed = JSON.parse(error.slice(start + 2)) as unknown;
  assert(isRecord(parsed), "Preview response must be an object.");
  return parsed;
}

function catalogTitleFromIssue(message: string): string {
  const match = /Amazon \[en_US: "([^"]+)"\]\)/.exec(message);
  assert(match?.[1], "Catalog conflict does not contain one exact Amazon en_US title.");
  return match[1];
}

async function main(): Promise<void> {
  const planPath = option("plan");
  const checkpointDirectory = option("checkpoint-dir");
  const outputPath = option("output");
  const delayMs = Number(
    process.argv
      .slice(2)
      .find((arg) => arg.startsWith("--request-delay-ms="))
      ?.split("=", 2)[1] ?? 550,
  );
  assert(Number.isInteger(delayMs) && delayMs >= 500, "request delay must be >=500ms.");

  const planBytes = await readFile(planPath);
  // This evidence tool may need to inspect a superseded diagnostic plan after
  // execution-order safety was tightened. Verify the immutable body seal here
  // without treating that obsolete plan as apply-eligible.
  const plan = JSON.parse(planBytes.toString("utf8")) as UncrustablesRepairPlan;
  const { sha256: claimedPlanSha256, ...planBody } = plan;
  assert(plan.immutable === true, "Source plan is not immutable.");
  assert(
    claimedPlanSha256 === sha256(stableJson(planBody)),
    "Source plan body seal is invalid.",
  );
  const bySku = new Map(plan.entries.map((entry) => [entry.sku, entry]));
  const checkpointFiles = (await readdir(checkpointDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert(checkpointFiles.length === plan.scope.actions, "Checkpoint set must cover every plan action exactly once.");

  const conflicts = new Map<
    string,
    {
      sku: string;
      asin: string;
      preview_catalog_title: string;
      preview_submission_ids: string[];
      checkpoint_event_sha256s: string[];
      checkpoint_file_sha256s: string[];
    }
  >();

  for (const name of checkpointFiles) {
    const bytes = await readFile(path.join(checkpointDirectory, name));
    const event = JSON.parse(bytes.toString("utf8")) as CheckpointEvent;
    const { sha256: claimed, ...body } = event;
    assert(event.schema_version === CHECKPOINT_SCHEMA, `Wrong checkpoint schema: ${name}`);
    assert(event.plan_sha256 === plan.sha256, `Wrong plan seal: ${name}`);
    assert(claimed === sha256(stableJson(body)), `Invalid checkpoint seal: ${name}`);
    if (event.status !== "FAILED") continue;
    const detailError = isRecord(event.detail) ? event.detail.error : null;
    assert(typeof detailError === "string", `FAILED checkpoint missing detail.error: ${name}`);
    const response = previewPayload(detailError);
    const issues = response.issues;
    assert(Array.isArray(issues), `FAILED checkpoint missing issues: ${name}`);
    const titleIssues = issues.filter(
      (issue) =>
        isRecord(issue) &&
        String(issue.code) === "8541" &&
        Array.isArray(issue.attributeNames) &&
        issue.attributeNames.length === 1 &&
        issue.attributeNames[0] === "item_name",
    );
    if (titleIssues.length === 0) continue;
    assert(titleIssues.length === 1 && issues.length === 1, `Ambiguous title conflict issues: ${name}`);
    const issue = titleIssues[0] as UnknownRecord;
    assert(typeof issue.message === "string", `Title conflict missing message: ${name}`);
    const catalogTitle = catalogTitleFromIssue(issue.message);
    const entry = bySku.get(event.sku);
    assert(entry, `Checkpoint SKU absent from plan: ${event.sku}`);
    const submissionId = typeof response.submission_id === "string"
      ? response.submission_id
      : typeof response.submissionId === "string"
        ? response.submissionId
        : null;
    assert(submissionId, `Title conflict missing submission id: ${name}`);
    const prior = conflicts.get(event.sku);
    if (prior) {
      assert(prior.asin === entry.asin, `ASIN drift across conflicts: ${event.sku}`);
      assert(prior.preview_catalog_title === catalogTitle, `Title drift across conflicts: ${event.sku}`);
      prior.preview_submission_ids.push(submissionId);
      prior.checkpoint_event_sha256s.push(claimed);
      prior.checkpoint_file_sha256s.push(fileSha256(bytes));
    } else {
      conflicts.set(event.sku, {
        sku: event.sku,
        asin: entry.asin,
        preview_catalog_title: catalogTitle,
        preview_submission_ids: [submissionId],
        checkpoint_event_sha256s: [claimed],
        checkpoint_file_sha256s: [fileSha256(bytes)],
      });
    }
  }
  assert(conflicts.size > 0, "No catalog item_name conflicts found.");

  const evidence: UnknownRecord[] = [];
  for (const conflict of [...conflicts.values()].sort((a, b) => a.sku.localeCompare(b.sku))) {
    const response = (await spApiGet(
      `/catalog/2022-04-01/items/${encodeURIComponent(conflict.asin)}`,
      {
        storeId: "store1",
        params: {
          marketplaceIds: MARKETPLACE_ID,
          includedData: "attributes,summaries,productTypes",
        },
      },
    )) as UnknownRecord;
    const summaries = Array.isArray(response.summaries) ? response.summaries : [];
    const summary = summaries
      .filter(isRecord)
      .find((item) => item.marketplaceId === MARKETPLACE_ID) ?? summaries.filter(isRecord)[0];
    assert(summary && typeof summary.itemName === "string", `Catalog title missing: ${conflict.asin}`);
    assert(summary.itemName === conflict.preview_catalog_title, `Catalog/preview title mismatch: ${conflict.sku}`);
    const attributes = isRecord(response.attributes) ? response.attributes : {};
    evidence.push({
      ...conflict,
      catalog_api_title: summary.itemName,
      catalog_api_brand: summary.brand ?? null,
      catalog_api_product_type:
        Array.isArray(response.productTypes) && isRecord(response.productTypes[0])
          ? response.productTypes[0].productType ?? null
          : null,
      catalog_api_number_of_items: attributes.number_of_items ?? null,
      catalog_api_unit_count: attributes.unit_count ?? null,
      catalog_api_product_identifiers:
        attributes.externally_assigned_product_identifier ?? null,
      exact_preview_match: true,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const capturedAt = new Date().toISOString();
  const artifactBody = {
    schema_version: "uncrustables-catalog-title-api-evidence/v1",
    immutable: true,
    read_only: true,
    captured_at: capturedAt,
    source_plan: {
      path: planPath,
      internal_sha256: plan.sha256,
      file_sha256: fileSha256(planBytes),
    },
    source_checkpoint_set: {
      path: checkpointDirectory,
      files: checkpointFiles.length,
      sha256: sha256(
        stableJson(
          await Promise.all(
            checkpointFiles.map(async (name) => ({
              name,
              file_sha256: fileSha256(await readFile(path.join(checkpointDirectory, name))),
            })),
          ),
        ),
      ),
    },
    scope: {
      catalog_title_conflict_skus: evidence.length,
      exact_preview_api_matches: evidence.length,
      mismatches: 0,
    },
    evidence,
  };
  const artifact = { ...artifactBody, body_sha256: sha256(stableJson(artifactBody)) };
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { flag: "wx" });
  await writeFile(`${outputPath}.sha256`, `${fileSha256(bytes)}  ${path.basename(outputPath)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        file_sha256: fileSha256(bytes),
        body_sha256: artifact.body_sha256,
        exact_matches: evidence.length,
      },
      null,
      2,
    ),
  );
}

await main();
