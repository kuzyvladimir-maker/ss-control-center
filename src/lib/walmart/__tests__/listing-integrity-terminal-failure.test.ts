import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  walmartListingIntegritySha256,
} from "../listing-integrity-audit.ts";
import {
  buildWalmartListingIntegrityTerminalFailureDisposition,
  captureWalmartListingQualityEvidence,
  verifyWalmartListingIntegrityTerminalFailureDisposition,
} from "../listing-integrity-terminal-failure.ts";

const H = (value: string | Uint8Array) => (
  createHash("sha256").update(value).digest("hex")
);
const CAPTURED_AT = "2026-07-28T14:10:00.000Z";
const QUALIFIED_AT = "2026-07-28T04:45:10.000Z";

function seal<T extends Record<string, unknown>>(body: T): T & { body_sha256: string } {
  return { ...body, body_sha256: walmartListingIntegritySha256(body) };
}

function operatorReceipt() {
  const listing = {
    channel: "WALMART_US",
    store_index: 1,
    sku: "FaisalX-2768",
    listing_key: "walmart:1:FaisalX-2768",
    item_id: "1838619805",
  };
  const qualification = seal({
    schema_version: "walmart-listing-integrity-repair-live-qualification/v2",
    qualification_id: "live-qualification-final",
    qualified_at: QUALIFIED_AT,
    verdict: "FAIL",
    listing,
    plan_id: "plan-1",
    plan_body_sha256: H("plan"),
    permit_authorization_sha256: H("permit"),
    feed_id: "feed-1",
    feed_terminal_at: "2026-07-27T22:42:52.181Z",
    apply_custody: {
      request_payload_sha256: H("payload"),
      terminal_feed_status_payload_sha256: H("status"),
    },
    facets: {
      exact_listing_identity: "PASS",
      published_and_indexed: "PASS",
      product_and_variant: "FAIL",
      pack_count: "FAIL",
      title: "PASS",
      description: "PASS",
      bullets: "PASS",
      attributes: "FAIL",
      main: "PASS",
      gallery: "PASS",
      exact_repair_target: "FAIL",
      unchanged_fields_preserved: "PASS",
      fresh_authenticated_live_reread: "PASS",
      terminal_apply_custody: "PASS",
    },
    propagation: {
      failure_not_before: "2026-07-28T04:42:52.181Z",
      reread_before_failure_window: false,
      recheck_same_sku_without_write: false,
    },
    next_sku_unblocked: false,
    next_action: "OWNER_REVIEW_REPLAN",
    marketplace_write_authorized: false,
    automatic_reapply_allowed: false,
  });
  return seal({
    schema_version: "walmart-listing-repair-operator-receipt/v1",
    command: "qualify",
    status: "FAIL",
    listing,
    qualification,
    marketplace_write_authorized: false,
    automatic_reapply_allowed: false,
  });
}

function listingQualityResponse(
  mutator?: (value: Record<string, unknown>) => void,
): Buffer {
  const contentIssues = [
    { attributeName: "flavor", attributeValue: "qty 4", isEditable: false },
    { attributeName: "multipack_quantity", attributeValue: "4", isEditable: false },
    { attributeName: "count_per_pack", attributeValue: "1", isEditable: false },
    { attributeName: "number_of_pieces", attributeValue: "1", isEditable: false },
  ];
  const value: Record<string, unknown> = {
    status: "OK",
    totalItems: 1,
    payload: [{
      sku: "FaisalX-2768",
      itemId: "1838619805",
      isInStock: true,
      updatedTimestamp: "2026-07-28 14:09:49.247",
      scoreDetails: {
        contentAndDiscoverability: {
          score: 91,
          issues: contentIssues,
        },
      },
    }],
  };
  mutator?.(value);
  return Buffer.from(JSON.stringify(value), "utf8");
}

function qualityReceipt(responseBytes: Buffer) {
  return seal({
    schema_version: "walmart-listing-integrity-listing-quality-receipt/v1",
    captured_at: CAPTURED_AT,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: "FaisalX-2768",
    },
    seller_account_fingerprint: H("seller"),
    request: {
      method: "POST",
      path: "/v3/insights/items/listingQuality/items",
      query: { limit: 200 },
      body_sha256: H("request"),
      correlation_id: "correlation-1",
    },
    response: {
      http_status: 200,
      body_sha256: H(responseBytes),
      bytes: responseBytes.byteLength,
    },
    external_effects: {
      oauth_token_calls: 1,
      listing_quality_read_calls: 1,
      retries: 0,
      redirects: 0,
      model_calls: 0,
      database_writes: 0,
      walmart_content_writes: 0,
    },
  });
}

test("seals an unresolved terminal failure and unblocks only the next listing", () => {
  const responseBytes = listingQualityResponse();
  const result = buildWalmartListingIntegrityTerminalFailureDisposition({
    operator_receipt: operatorReceipt(),
    operator_receipt_file_sha256: H("operator-file"),
    listing_quality_receipt: qualityReceipt(responseBytes),
    listing_quality_response_bytes: responseBytes,
    created_at: "2026-07-28T14:11:00.000Z",
  });
  assert.equal(result.status, "QUARANTINED_UNRESOLVED");
  assert.equal(result.classification.listing_repair_complete, false);
  assert.equal(result.classification.same_payload_reapply_allowed, false);
  assert.equal(result.sequence.next_listing_unblocked, true);
  assert.equal(result.failed_qualification.published_and_indexed_preserved, true);
  assert.deepEqual(
    result.listing_quality_evidence.target_fields_reported_not_editable,
    ["count_per_pack", "flavor", "multipack_quantity", "number_of_pieces"],
  );
  assert.doesNotThrow(
    () => verifyWalmartListingIntegrityTerminalFailureDisposition(result),
  );
});

test("does not classify an editable field as a platform-priority quarantine", () => {
  const responseBytes = listingQualityResponse((value) => {
    const payload = value.payload as Array<Record<string, unknown>>;
    const score = payload[0]!.scoreDetails as {
      contentAndDiscoverability: { issues: Array<Record<string, unknown>> };
    };
    score.contentAndDiscoverability.issues[0]!.isEditable = true;
  });
  assert.throws(
    () => buildWalmartListingIntegrityTerminalFailureDisposition({
      operator_receipt: operatorReceipt(),
      operator_receipt_file_sha256: H("operator-file"),
      listing_quality_receipt: qualityReceipt(responseBytes),
      listing_quality_response_bytes: responseBytes,
      created_at: "2026-07-28T14:11:00.000Z",
    }),
    /does not prove flavor is reported non-editable/,
  );
});

test("Listing Quality capture performs exactly one token and one read attempt", async () => {
  const responseBytes = listingQualityResponse();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await captureWalmartListingQualityEvidence({
    store_index: 1,
    sku: "FaisalX-2768",
    credentials: {
      client_id: "client",
      client_secret: "secret",
      seller_id: "seller",
    },
    fetch_impl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (calls.length === 1) {
        const bytes = Buffer.from(JSON.stringify({ access_token: "token" }));
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(bytes.byteLength),
          },
        });
      }
      return new Response(new Uint8Array(responseBytes), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(responseBytes.byteLength),
        },
      });
    },
    now: () => new Date(CAPTURED_AT),
    random_uuid: (() => {
      const values = ["oauth-correlation", "quality-correlation"];
      return () => values.shift()!;
    })(),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init.method, "POST");
  assert.match(calls[0]!.url, /\/v3\/token$/u);
  assert.equal(calls[1]!.init.method, "POST");
  assert.match(calls[1]!.url, /listingQuality\/items\?limit=200$/u);
  assert.deepEqual(
    JSON.parse(String(calls[1]!.init.body)),
    { query: { field: "sku", value: "FaisalX-2768" } },
  );
  assert.equal(result.receipt.external_effects.walmart_content_writes, 0);
  assert.equal(result.receipt.external_effects.retries, 0);
  assert.equal(H(result.response_bytes), H(responseBytes));
});
