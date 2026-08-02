import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
} from "../listing-integrity-control-plane";
import {
  buildWalmartListingIntegrityRunCompletionEvidence,
  verifyWalmartListingIntegrityRunCompletionEvidence,
} from "../listing-integrity-control-run-completion";
import {
  loadWalmartListingIntegrityTerminalListingKeys,
} from "../listing-integrity-control-store.server";

const H = (value: string) => createHash("sha256").update(value).digest("hex");

function state(
  ordinal: number,
  terminal: "QUALIFIED_PASS" | "QUARANTINED_UNRESOLVED",
): WalmartListingIntegrityControlState {
  const body = {
    schema_version: "walmart-listing-integrity-control-state/v1" as const,
    identity: {
      run_id: "wlirun-completion-test",
      pool_body_sha256: H("pool"),
      ordinal,
      listing_key: `walmart:1:SKU-${ordinal}`,
      sku: `SKU-${ordinal}`,
      item_id: `ITEM-${ordinal}`,
      store_index: 1,
    },
    state: terminal,
    revision: 4,
    transitioned_at: "2026-08-01T22:00:00.000Z",
    previous_state_sha256: H(`previous-${ordinal}`),
    evidence_sha256: H(`evidence-${ordinal}`),
    execution_package_sha256: terminal === "QUALIFIED_PASS" ? H("package") : null,
    owner_permit_sha256: terminal === "QUALIFIED_PASS" ? H("permit") : null,
    feed_id: terminal === "QUALIFIED_PASS" ? "feed-pass" : null,
    marketplace_write_calls: terminal === "QUALIFIED_PASS" ? 1 : 0,
    automatic_retry_allowed: false as const,
    automatic_replay_allowed: false as const,
  };
  return { ...body, body_sha256: walmartListingIntegrityControlSha256(body) };
}

test("fully terminal epoch seals PASS galleries and quarantine without a fake gallery", () => {
  const pass = state(1, "QUALIFIED_PASS");
  const quarantine = state(2, "QUARANTINED_UNRESOLVED");
  const evidence = buildWalmartListingIntegrityRunCompletionEvidence({
    run: {
      run_id: "wlirun-completion-test",
      pool_body_sha256: H("pool"),
      release_id_sha256: H("release"),
      manifest_sha256: H("manifest"),
      status: "ACTIVE",
      items: [pass, quarantine],
    },
    galleries: [{
      sku: "SKU-1",
      published: {
        status: "GALLERY_PUBLISHED",
        destination: "/immutable/gallery/SKU-1",
        verification_file_sha256: H("verification"),
        gallery_file_sha256: H("gallery"),
      },
    }],
    completed_at: "2026-08-01T22:01:00.000Z",
  });
  assert.equal(evidence.terminal_items[0]?.gallery?.publication_status, "GALLERY_PUBLISHED");
  assert.equal(evidence.terminal_items[1]?.gallery, null);
  assert.doesNotThrow(() => verifyWalmartListingIntegrityRunCompletionEvidence(evidence));
  const tampered = structuredClone(evidence);
  tampered.terminal_items[0]!.state_body_sha256 = H("tampered");
  assert.throws(
    () => verifyWalmartListingIntegrityRunCompletionEvidence(tampered),
    /completion evidence seal or policy differs/,
  );
});

test("epoch completion rejects a missing PASS gallery or a nonterminal item", () => {
  const pass = state(1, "QUALIFIED_PASS");
  const common = {
    run_id: "wlirun-completion-test",
    pool_body_sha256: H("pool"),
    release_id_sha256: H("release"),
    manifest_sha256: H("manifest"),
    status: "ACTIVE",
  };
  assert.throws(
    () => buildWalmartListingIntegrityRunCompletionEvidence({
      run: { ...common, items: [pass] },
      galleries: [],
      completed_at: "2026-08-01T22:01:00.000Z",
    }),
    /lacks a published factual gallery/,
  );
  assert.throws(
    () => buildWalmartListingIntegrityRunCompletionEvidence({
      run: { ...common, items: [{ ...pass, state: "LIVE_REREAD" }] },
      galleries: [],
      completed_at: "2026-08-01T22:01:00.000Z",
    }),
    /not one fully terminal ACTIVE epoch/,
  );
});

test("terminal listing boundary is read across every preserved epoch", async () => {
  const queries: string[] = [];
  const client = {
    async $queryRawUnsafe(query: string) {
      queries.push(query);
      return [
        { listingKey: "walmart:1:SKU-A" },
        { listingKey: "walmart:1:SKU-B" },
      ];
    },
  } as never;
  assert.deepEqual(
    await loadWalmartListingIntegrityTerminalListingKeys(client),
    ["walmart:1:SKU-A", "walmart:1:SKU-B"],
  );
  assert.match(queries[0]!, /QUARANTINED_SOURCE_REQUIRED/u);
  assert.match(queries[0]!, /ORDER BY listingKey ASC/u);
});
