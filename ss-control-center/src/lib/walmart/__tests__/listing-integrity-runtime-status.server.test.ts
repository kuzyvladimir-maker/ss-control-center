import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildListingIntegrityRuntimeStatusResponse,
  POST as postRuntimeStatus,
} from "@/app/api/walmart/growth/listing-integrity/runtime/route";
import {
  loadWalmartListingIntegrityRuntimeStatus,
} from "../listing-integrity-runtime-status.server";

const CHECKED_AT = "2026-08-01T20:45:53.584Z";

async function writeQualificationStatus(input: {
  root: string;
  status: "PENDING_PROPAGATION" | "FAIL";
  check: number;
  checkedAt: string;
}) {
  const receiptPath = path.join(input.root, `qualification-${input.check}.json`);
  const receiptBytes = Buffer.from(JSON.stringify({
    command: "qualify",
    status: input.status,
    listing: { sku: "FaisalX-1144" },
    qualification: {
      verdict: input.status,
      facets: {
        product_and_variant: "PASS",
        pack_count: "PASS",
        title: "PASS",
        description: "PASS",
        bullets: "PASS",
        attributes: "PASS",
        main: "FAIL",
        gallery: "PASS",
        published_and_indexed: "PASS",
      },
      propagation: {
        failure_not_before: "2026-08-01T23:12:25.210Z",
      },
    },
    external_effects: { walmart_content_writes: 0 },
  }));
  await writeFile(receiptPath, receiptBytes);
  await writeFile(path.join(input.root, "monitor-FaisalX-1144-v46-status.json"), JSON.stringify({
    status: input.status === "FAIL" ? "QUALIFICATION_FAIL" : "MONITORING_PROPAGATION",
    phase: "QUALIFICATION",
    sku: "FaisalX-1144",
    qualification_status: input.status,
    check: input.check,
    checked_at: input.checkedAt,
    qualification_receipt_path: receiptPath,
    qualification_receipt_file_sha256: createHash("sha256").update(receiptBytes).digest("hex"),
    walmart_content_writes: 0,
  }));
}

async function fixtureRoot(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wli-runtime-status-"));
  t.after(async () => rm(root, { recursive: true }));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "listing-integrity-successor-watch-status.json"), JSON.stringify({
    schema_version: "walmart-listing-integrity-successor-watch-status/v1",
    checked_at: "2026-08-01T20:48:38.667Z",
    pid: process.pid,
    status: "WAITING_FOR_PREDECESSOR_QUALIFICATION",
    active_listing_key: "walmart:1:FaisalX-1144",
    walmart_writes: 0,
  }));
  await writeQualificationStatus({
    root,
    status: "PENDING_PROPAGATION",
    check: 15,
    checkedAt: CHECKED_AT,
  });
  await writeFile(path.join(root, "monitor-FaisalX-1144-v46.lock"), JSON.stringify({
    pid: process.pid,
    sku: "FaisalX-1144",
    mode: "FEED_GET_THEN_FRESH_QUALIFICATION_NO_WRITE",
    started_at: "2026-08-01T16:47:13.489Z",
  }));
  return root;
}

test("projects the exact predecessor Qualification wait from durable local custody", async (t) => {
  const status = await loadWalmartListingIntegrityRuntimeStatus(await fixtureRoot(t));
  assert.equal(status.state, "MONITORING_QUALIFICATION");
  assert.equal(status.activeSku, "FaisalX-1144");
  assert.equal(status.qualification?.status, "PENDING_PROPAGATION");
  assert.equal(status.qualification?.check, 15);
  assert.equal(status.qualification?.checkedAt, CHECKED_AT);
  assert.equal(status.qualification?.monitorAlive, true);
  assert.deepEqual(status.qualification?.blockingFacets, ["main"]);
  assert.equal(status.qualification?.publishedAndIndexedPreserved, true);
  assert.equal(status.qualification?.failureNotBefore, "2026-08-01T23:12:25.210Z");
  assert.equal(status.successor?.processAlive, true);
  assert.equal(status.successor?.lastCycleWalmartWrites, 0);
  assert.deepEqual(status.claims, {
    source: "LOCAL_SHA_CUSTODY_STATUS",
    statusLoaderWalmartReads: 0,
    statusLoaderWalmartWrites: 0,
    mutationControlsExposed: false,
  });
});

test("missing runtime custody is reported without fabricating a process", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wli-runtime-empty-"));
  t.after(async () => rm(root, { recursive: true }));
  const status = await loadWalmartListingIntegrityRuntimeStatus(root);
  assert.equal(status.state, "NOT_AVAILABLE");
  assert.equal(status.activeSku, null);
  assert.equal(status.successor, null);
});

test("a waiting predecessor status fails closed if it claims a Walmart write", async (t) => {
  const root = await fixtureRoot(t);
  await writeFile(path.join(root, "listing-integrity-successor-watch-status.json"), JSON.stringify({
    schema_version: "walmart-listing-integrity-successor-watch-status/v1",
    checked_at: "2026-08-01T20:48:38.667Z",
    pid: process.pid,
    status: "WAITING_FOR_PREDECESSOR_QUALIFICATION",
    active_listing_key: "walmart:1:FaisalX-1144",
    walmart_writes: 1,
  }));
  await assert.rejects(
    loadWalmartListingIntegrityRuntimeStatus(root),
    /waiting successor cannot report a Walmart write/,
  );
});

test("terminal Qualification failure is shown as requiring verified disposition", async (t) => {
  const root = await fixtureRoot(t);
  await writeQualificationStatus({
    root,
    status: "FAIL",
    check: 24,
    checkedAt: "2026-08-01T23:15:53.584Z",
  });
  const status = await loadWalmartListingIntegrityRuntimeStatus(root);
  assert.equal(status.state, "REQUIRES_DISPOSITION");
  assert.equal(status.qualification?.status, "FAIL");
  assert.equal(status.activeSku, "FaisalX-1144");
  assert.equal(status.successor?.lastCycleWalmartWrites, 0);
});

test("runtime API is no-store GET-only and exposes no mutation route", async (t) => {
  const root = await fixtureRoot(t);
  const response = await buildListingIntegrityRuntimeStatusResponse(
    () => loadWalmartListingIntegrityRuntimeStatus(root),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal((await response.json()).runtime.activeSku, "FaisalX-1144");

  const post = await postRuntimeStatus();
  assert.equal(post.status, 405);
  assert.equal((await post.json()).error, "READ_ONLY_LISTING_INTEGRITY_RUNTIME_API");
});
