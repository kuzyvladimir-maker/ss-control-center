import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";

import { MARKETPLACE_ID, spApiGet } from "../src/lib/amazon-sp-api/client";
import { patchListing, type ListingPatch } from "../src/lib/amazon-sp-api/listings";
import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";

const PLAN_SCHEMA = "uncrustables-batch200-seo-surgical-plan/v1";
const PREVIEW_SCHEMA = "uncrustables-batch200-seo-validation-preview/v1";
const EXECUTION_SCHEMA = "uncrustables-batch200-seo-canary-execution/v1";

type TargetStatus =
  | "PLANNED"
  | "PATCH_IN_FLIGHT"
  | "PATCH_ACCEPTED"
  | "PENDING_VERIFICATION"
  | "VERIFIED"
  | "BLOCKED_AMBIGUOUS"
  | "BLOCKED_DRIFT";

interface PlanEntry {
  sku: string;
  asin: string;
  productType: string;
  eligible: boolean;
  current: Record<string, unknown>;
  desired: {
    generic_keyword: string;
    flavor: string;
    size: string;
    specialty: string;
    item_form: string;
    number_of_pieces: number;
  };
}

interface Plan {
  schemaVersion: string;
  canarySkus: string[];
  entries: PlanEntry[];
  policy: { mutationMethod?: unknown; genericPutForbidden?: unknown };
}

interface Preview {
  schemaVersion: string;
  selection?: "CANARY" | "ROLLOUT_REMAINDER";
  plan: { sha256: string };
  counts: { targets: number; accepted: number; rejected: number };
  claims: { realPatchCalls: number; marketplaceMutations: number };
  results: Array<{ sku: string; accepted: boolean; patches: ListingPatch[] }>;
}

interface ExecutionTarget {
  sku: string;
  asin: string;
  status: TargetStatus;
  updatedAt: string;
  preSnapshotFile?: string;
  preSnapshotSha256?: string;
  preOfferSha256?: string;
  patchRequestStartedAt?: string;
  patchResponse?: unknown;
  verificationChecks: number;
  verifiedAt?: string;
  postSnapshotSha256?: string;
  postOfferSha256?: string;
  error?: string;
}

interface ExecutionState {
  schemaVersion: typeof EXECUTION_SCHEMA;
  createdAt: string;
  updatedAt: string;
  plan: { path: string; sha256: string };
  preview: { path: string; sha256: string };
  selection?: "CANARY" | "ROLLOUT_REMAINDER";
  claims: {
    genericPutCalls: 0;
    titleMutations: 0;
    offerMutationsRequested: 0;
    imageMutations: 0;
  };
  targets: ExecutionTarget[];
}

function fail(message: string): never {
  throw new Error(message);
}

function exactArg(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args.indexOf(name, index + 1) >= 0) {
    return fail(`${name} is required exactly once`);
  }
  const value = args[index + 1];
  if (!value || value !== value.trim() || value.startsWith("--")) {
    return fail(`${name} must have one exact value`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function writeNew(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function currentValue(attributes: Record<string, unknown>, name: string): unknown {
  const rows = attributes[name];
  return Array.isArray(rows) && rows[0] && typeof rows[0] === "object"
    ? (rows[0] as Record<string, unknown>).value ?? null
    : null;
}

function desiredApplied(attributes: Record<string, unknown>, desired: PlanEntry["desired"]): boolean {
  return Object.entries(desired).every(([name, value]) => currentValue(attributes, name) === value);
}

function sourceUnchanged(attributes: Record<string, unknown>, current: Record<string, unknown>): boolean {
  return ["generic_keyword", "flavor", "size", "specialty", "item_form", "number_of_pieces"]
    .every((name) => currentValue(attributes, name) === current[name]);
}

function patches(entry: PlanEntry): ListingPatch[] {
  const localized = (value: string) => [{
    value,
    language_tag: "en_US",
    marketplace_id: MARKETPLACE_ID,
  }];
  return [
    { op: "replace", path: "/attributes/generic_keyword", value: localized(entry.desired.generic_keyword) },
    { op: "add", path: "/attributes/flavor", value: localized(entry.desired.flavor) },
    { op: "add", path: "/attributes/size", value: localized(entry.desired.size) },
    { op: "add", path: "/attributes/specialty", value: localized(entry.desired.specialty) },
    { op: "add", path: "/attributes/item_form", value: localized(entry.desired.item_form) },
    {
      op: "add",
      path: "/attributes/number_of_pieces",
      value: [{ value: entry.desired.number_of_pieces, marketplace_id: MARKETPLACE_ID }],
    },
  ];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function freshListing(sellerId: string, sku: string): Promise<Record<string, unknown>> {
  return spApiGet(
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
    {
      storeId: "store1",
      params: {
        marketplaceIds: MARKETPLACE_ID,
        includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
      },
      retries: 2,
      signal: AbortSignal.timeout(30_000),
    },
  ) as Promise<Record<string, unknown>>;
}

function identityIsExact(raw: Record<string, unknown>, entry: PlanEntry): boolean {
  const summaries = Array.isArray(raw.summaries) ? raw.summaries : [];
  const summary = summaries[0] as Record<string, unknown> | undefined;
  const statuses = Array.isArray(summary?.status) ? summary.status : [];
  return summary?.asin === entry.asin
    && summary.productType === "FOOD"
    && statuses.includes("BUYABLE")
    && statuses.includes("DISCOVERABLE");
}

function offerSha(raw: Record<string, unknown>): string {
  return sha256(canonicalJson({
    offers: raw.offers ?? null,
    fulfillmentAvailability: raw.fulfillmentAvailability ?? null,
  }));
}

async function verifyTarget(
  sellerId: string,
  entry: PlanEntry,
  target: ExecutionTarget,
): Promise<boolean> {
  const raw = await freshListing(sellerId, entry.sku);
  target.verificationChecks += 1;
  target.updatedAt = new Date().toISOString();
  if (!identityIsExact(raw, entry)) {
    target.status = "BLOCKED_DRIFT";
    target.error = "listing identity/status drifted during verification";
    return false;
  }
  const attributes = raw.attributes && typeof raw.attributes === "object"
    ? raw.attributes as Record<string, unknown>
    : {};
  if (!desiredApplied(attributes, entry.desired)) return false;
  target.postOfferSha256 = offerSha(raw);
  if (target.preOfferSha256 !== target.postOfferSha256) {
    target.status = "BLOCKED_DRIFT";
    target.error = "offer or fulfillment availability changed across SEO-only patch";
    return false;
  }
  target.status = "VERIFIED";
  target.verifiedAt = new Date().toISOString();
  target.postSnapshotSha256 = sha256(`${canonicalJson(raw)}\n`);
  delete target.error;
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Apply an exact preview-bound batch-200 SEO canary or rollout with ambiguity fences.\n"
      + "Required: --plan ABS --plan-sha256 SHA --preview ABS --preview-sha256 SHA --execution-dir ABS\n"
      + "Resumes verification only after accepted/unknown PATCH; never repeats an ambiguous physical PATCH.",
    );
    return;
  }
  const allowed = new Set([
    "--plan", "--plan-sha256", "--preview", "--preview-sha256", "--execution-dir",
  ]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const planPath = exactArg(args, "--plan");
  const planSha = exactArg(args, "--plan-sha256").toLowerCase();
  const previewPath = exactArg(args, "--preview");
  const previewSha = exactArg(args, "--preview-sha256").toLowerCase();
  const executionDir = exactArg(args, "--execution-dir");
  for (const [name, path] of [
    ["--plan", planPath], ["--preview", previewPath], ["--execution-dir", executionDir],
  ]) {
    if (!isAbsolute(path) || normalize(path) !== path) fail(`${name} must be a normalized absolute path`);
  }
  const [planBytes, previewBytes] = await Promise.all([
    readFile(planPath),
    readFile(previewPath),
  ]);
  if (sha256(planBytes) !== planSha || sha256(previewBytes) !== previewSha) {
    fail("plan or preview SHA-256 mismatch");
  }
  const plan = JSON.parse(planBytes.toString("utf8")) as Plan;
  const preview = JSON.parse(previewBytes.toString("utf8")) as Preview;
  const selection = preview.selection ?? "CANARY";
  const expectedTargetSkus = selection === "CANARY"
    ? plan.canarySkus
    : plan.entries.filter((entry) =>
      entry.eligible && entry.productType === "FOOD" && !plan.canarySkus.includes(entry.sku))
      .map((entry) => entry.sku);
  const targetSkus = preview.results.map((result) => result.sku);
  if (
    plan.schemaVersion !== PLAN_SCHEMA
    || plan.policy.mutationMethod !== "SURGICAL_ATTRIBUTE_PATCH_ONLY"
    || plan.policy.genericPutForbidden !== true
    || plan.canarySkus.length !== 10
    || preview.schemaVersion !== PREVIEW_SCHEMA
    || preview.plan.sha256 !== planSha
    || !["CANARY", "ROLLOUT_REMAINDER"].includes(selection)
    || expectedTargetSkus.length < 1
    || targetSkus.length !== expectedTargetSkus.length
    || targetSkus.some((sku, index) => sku !== expectedTargetSkus[index])
    || new Set(targetSkus).size !== targetSkus.length
    || preview.counts.targets !== targetSkus.length
    || preview.counts.accepted !== targetSkus.length
    || preview.counts.rejected !== 0
    || preview.claims.realPatchCalls !== 0
    || preview.claims.marketplaceMutations !== 0
  ) fail("plan/preview contract is not execution-eligible");
  const previewBySku = new Map(preview.results.map((result) => [result.sku, result]));
  const entryBySku = new Map(plan.entries.map((entry) => [entry.sku, entry]));
  for (const sku of targetSkus) {
    const entry = entryBySku.get(sku);
    const previewResult = previewBySku.get(sku);
    if (!entry?.eligible || entry.productType !== "FOOD" || !previewResult?.accepted) {
      fail(`canary binding is invalid for ${sku}`);
    }
    if (canonicalJson(previewResult.patches) !== canonicalJson(patches(entry))) {
      fail(`preview patch bytes drifted for ${sku}`);
    }
  }
  const sellerId = process.env.AMAZON_SP_SELLER_ID_STORE1?.trim();
  if (!sellerId) fail("AMAZON_SP_SELLER_ID_STORE1 is required");
  const statePath = join(executionDir, "execution-state.json");
  let state: ExecutionState;
  if (await pathExists(statePath)) {
    state = JSON.parse(await readFile(statePath, "utf8")) as ExecutionState;
    if (
      state.schemaVersion !== EXECUTION_SCHEMA
      || state.plan.sha256 !== planSha
      || state.preview.sha256 !== previewSha
      || (state.selection ?? "CANARY") !== selection
    ) fail("existing execution state does not match plan/preview");
  } else {
    if (await pathExists(executionDir)) fail("execution directory exists without state");
    await mkdir(executionDir, { mode: 0o700 });
    const now = new Date().toISOString();
    state = {
      schemaVersion: EXECUTION_SCHEMA,
      createdAt: now,
      updatedAt: now,
      plan: { path: planPath, sha256: planSha },
      preview: { path: previewPath, sha256: previewSha },
      selection,
      claims: {
        genericPutCalls: 0,
        titleMutations: 0,
        offerMutationsRequested: 0,
        imageMutations: 0,
      },
      targets: targetSkus.map((sku) => ({
        sku,
        asin: entryBySku.get(sku)?.asin ?? "",
        status: "PLANNED",
        updatedAt: now,
        verificationChecks: 0,
      })),
    };
    await writeJsonAtomic(statePath, state);
  }

  for (const target of state.targets) {
    const entry = entryBySku.get(target.sku);
    if (!entry || entry.asin !== target.asin) fail(`execution target binding drift for ${target.sku}`);
    if (target.status === "VERIFIED" || target.status.startsWith("BLOCKED_")) continue;
    if (target.status === "PATCH_IN_FLIGHT") {
      const reconciled = await verifyTarget(sellerId, entry, target);
      if (!reconciled) {
        target.status = "BLOCKED_AMBIGUOUS";
        target.error = "unknown PATCH outcome did not reconcile to desired attributes; physical PATCH was not repeated";
      }
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(statePath, state);
      continue;
    }
    if (target.status === "PATCH_ACCEPTED" || target.status === "PENDING_VERIFICATION") {
      const verified = await verifyTarget(sellerId, entry, target);
      if (!verified && target.status !== "BLOCKED_DRIFT") target.status = "PENDING_VERIFICATION";
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(statePath, state);
      continue;
    }

    const pre = await freshListing(sellerId, entry.sku);
    if (!identityIsExact(pre, entry)) {
      target.status = "BLOCKED_DRIFT";
      target.error = "fresh identity/status drift before PATCH";
      target.updatedAt = new Date().toISOString();
      await writeJsonAtomic(statePath, state);
      continue;
    }
    const attributes = pre.attributes && typeof pre.attributes === "object"
      ? pre.attributes as Record<string, unknown>
      : {};
    if (!sourceUnchanged(attributes, entry.current)) {
      target.status = "BLOCKED_DRIFT";
      target.error = "fresh source attributes drift before PATCH";
      target.updatedAt = new Date().toISOString();
      await writeJsonAtomic(statePath, state);
      continue;
    }
    const preJson = `${canonicalJson(pre)}\n`;
    const preFile = `pre-${basename(entry.sku)}.json`;
    await writeNew(join(executionDir, preFile), preJson);
    target.preSnapshotFile = preFile;
    target.preSnapshotSha256 = sha256(preJson);
    target.preOfferSha256 = offerSha(pre);
    target.status = "PATCH_IN_FLIGHT";
    target.patchRequestStartedAt = new Date().toISOString();
    target.updatedAt = target.patchRequestStartedAt;
    state.updatedAt = target.updatedAt;
    await writeJsonAtomic(statePath, state);
    try {
      target.patchResponse = await patchListing(
        1,
        sellerId,
        entry.sku,
        "FOOD",
        patches(entry),
        { validationPreview: false, retries: 1, signal: AbortSignal.timeout(30_000) },
      );
      const response = target.patchResponse as Record<string, unknown>;
      if (response.status !== "ACCEPTED") {
        target.status = "BLOCKED_DRIFT";
        target.error = `Amazon PATCH response status=${String(response.status)}`;
      } else {
        target.status = "PATCH_ACCEPTED";
      }
      target.updatedAt = new Date().toISOString();
      state.updatedAt = target.updatedAt;
      await writeJsonAtomic(statePath, state);
    } catch (error) {
      target.error = error instanceof Error ? error.message : String(error);
      target.updatedAt = new Date().toISOString();
      state.updatedAt = target.updatedAt;
      await writeJsonAtomic(statePath, state);
      // PATCH_IN_FLIGHT is deliberately preserved as an ambiguity fence.
      throw error;
    }
    if (target.status !== "PATCH_ACCEPTED") continue;
    let verified = false;
    for (let check = 0; check < 4 && !verified; check += 1) {
      await sleep(3_000);
      verified = await verifyTarget(sellerId, entry, target);
      if (target.status === "BLOCKED_DRIFT") break;
    }
    if (!verified && target.status !== "BLOCKED_DRIFT") target.status = "PENDING_VERIFICATION";
    target.updatedAt = new Date().toISOString();
    state.updatedAt = target.updatedAt;
    await writeJsonAtomic(statePath, state);
  }

  const counts = Object.fromEntries(
    [...new Set(state.targets.map((target) => target.status))]
      .sort()
      .map((status) => [status, state.targets.filter((target) => target.status === status).length]),
  );
  const complete = state.targets.every((target) => target.status === "VERIFIED");
  console.log(JSON.stringify({
    status: complete
      ? `${selection}_APPLIED_AND_VERIFIED`
      : `${selection}_NOT_FULLY_VERIFIED`,
    executionDir,
    counts,
    physicalPatchResponses: state.targets.filter((target) => target.patchResponse).length,
    genericPutCalls: 0,
    titleMutations: 0,
    offerMutationsRequested: 0,
  }, null, 2));
  if (!complete) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
