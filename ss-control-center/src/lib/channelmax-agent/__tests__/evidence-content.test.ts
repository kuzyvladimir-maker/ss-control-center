import assert from "node:assert/strict";
import { test } from "node:test";

import sharp from "sharp";

import type { ChannelMaxManagedEvidenceUploadInput } from "../contracts";
import {
  assertChannelMaxManagedEvidenceContent,
  type ChannelMaxEvidenceJobBinding,
} from "../evidence-content";

const ACCOUNT_ID = "channelmax:amznus:salutem-solutions";
const CAPTURED_AT = "2026-07-18T20:00:00.000Z";

function uploadInput(
  kind: "SCREENSHOT" | "DOM_SNAPSHOT",
  mediaType: string,
): ChannelMaxManagedEvidenceUploadInput {
  return {
    lease_token: "a".repeat(64),
    kind,
    media_type: mediaType,
    captured_at: CAPTURED_AT,
  };
}

function job(
  operation: "SNAPSHOT_INVENTORY" | "DISCOVER_MANUAL_MODEL",
  expectedRows = 2,
): ChannelMaxEvidenceJobBinding {
  return {
    operation,
    accountId: ACCOUNT_ID,
    payloadJson: JSON.stringify({
      account_id: ACCOUNT_ID,
      expected_active_rows: expectedRows,
      ...(operation === "SNAPSHOT_INVENTORY"
        ? { include_inactive: false }
        : {}),
    }),
  };
}

async function png(width = 320, height = 200): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 24, g: 91, b: 53, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

function inventoryDocument(): Record<string, unknown> {
  return {
    schema_version: "channelmax-inventory-snapshot/v1",
    captured_at: CAPTURED_AT,
    account_id: ACCOUNT_ID,
    expected_active_rows: 2,
    requested_include_inactive: false,
    query_scope: {
      active_skus_only: true,
      title_contains: "Uncrustables",
      view_type: "REPRICING",
      page: 1,
      size: 600,
    },
    selected_site_id: "300",
    selected_site_name: "AmznUS [Salutem Solutions]",
    title_total: 2,
    loaded_title_rows: 2,
    aggregate: {
      exact_launch_count: 2,
      positive_current_price_count: 1,
      zero_or_missing_current_price_count: 1,
      model_distribution: [],
      repricing_status_distribution: [],
    },
    launch_rows: [{ sku: "AA-AS12-ABCD" }, { sku: "BB-AS34-EFGH" }],
  };
}

function manualModelDocument(): Record<string, unknown> {
  return {
    schema_version: "channelmax-manual-model-discovery/v1",
    captured_at: CAPTURED_AT,
    observation: {
      operation: "DISCOVER_MANUAL_MODEL",
      account_id: ACCOUNT_ID,
      expected_active_rows: 2,
      visible_text_sha256: "a".repeat(64),
      visible_text_bytes: 100,
      visible_nonempty_line_count: 4,
      matched_view_markers: ["manual"],
      manual_model_discovery: {
        selected_site_id: "300",
        selected_site_name: "AmznUS [Salutem Solutions]",
        scanned_nodes: 1,
        models: [{ id: "59021", name: "Manual min/max" }],
        canonical_manual_model: { id: "59021", name: "Manual min/max" },
      },
    },
  };
}

test("SCREENSHOT accepts only a decodable, bounded PNG", async () => {
  const input = uploadInput("SCREENSHOT", "image/png");
  await assertChannelMaxManagedEvidenceContent(
    input,
    await png(),
    job("SNAPSHOT_INVENTORY"),
  );
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      Buffer.from("not-a-png"),
      job("SNAPSHOT_INVENTORY"),
    ),
    /PNG signature/i,
  );
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      uploadInput("SCREENSHOT", "image/jpeg"),
      await png(),
      job("SNAPSHOT_INVENTORY"),
    ),
    /media_type=image\/png/i,
  );
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      await png(1, 1),
      job("SNAPSHOT_INVENTORY"),
    ),
    /dimensions or page count/i,
  );
});

test("inventory DOM snapshot must match the exact job, site, and row aggregate", async () => {
  const input = uploadInput("DOM_SNAPSHOT", "application/json");
  const valid = inventoryDocument();
  await assertChannelMaxManagedEvidenceContent(
    input,
    Buffer.from(JSON.stringify(valid)),
    job("SNAPSHOT_INVENTORY"),
  );

  for (const invalidDocument of [
    { ...valid, account_id: "other-account" },
    { ...valid, selected_site_id: "999" },
    { ...valid, schema_version: "untrusted/v1" },
    { ...valid, seller_id: "secret" },
  ]) {
    await assert.rejects(
      assertChannelMaxManagedEvidenceContent(
        input,
        Buffer.from(JSON.stringify(invalidDocument)),
        job("SNAPSHOT_INVENTORY"),
      ),
    );
  }
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      Buffer.from("{invalid"),
      job("SNAPSHOT_INVENTORY"),
    ),
    /valid UTF-8 JSON/i,
  );
});

test("manual-model DOM snapshot must identify model 59021 on the exact site", async () => {
  const input = uploadInput("DOM_SNAPSHOT", "application/json");
  const valid = manualModelDocument();
  await assertChannelMaxManagedEvidenceContent(
    input,
    Buffer.from(JSON.stringify(valid)),
    job("DISCOVER_MANUAL_MODEL"),
  );

  const wrongSite = structuredClone(valid);
  const observation = wrongSite.observation as Record<string, unknown>;
  const discovery = observation.manual_model_discovery as Record<string, unknown>;
  discovery.selected_site_name = "Another account";
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      Buffer.from(JSON.stringify(wrongSite)),
      job("DISCOVER_MANUAL_MODEL"),
    ),
    /selected ChannelMAX site/i,
  );
});
