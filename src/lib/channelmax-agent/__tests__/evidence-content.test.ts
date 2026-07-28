import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import type { ChannelMaxManagedEvidenceUploadInput } from "../contracts";
import {
  assertChannelMaxManagedEvidenceContent,
  type ChannelMaxEvidenceJobBinding,
} from "../evidence-content";
import {
  buildChannelMaxVcCanaryJobRequest,
  channelMaxVcCanaryArtifact,
  CHANNELMAX_VC_CANARY,
  CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA,
} from "../uncrustables-same-model-canary";
import { testPng, testPngChunk } from "./png-fixture";

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
  return testPng({ width, height });
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

test("SCREENSHOT validates CRCs, chunk order, IEND, and trailing bytes", async () => {
  const input = uploadInput("SCREENSHOT", "image/png");
  const valid = testPng({ idatParts: 3 });
  await assertChannelMaxManagedEvidenceContent(
    input,
    valid,
    job("SNAPSHOT_INVENTORY"),
  );

  const corruptCrc = Buffer.from(valid);
  const idat = corruptCrc.indexOf(Buffer.from("IDAT", "ascii"));
  assert.ok(idat > 0);
  corruptCrc[idat + 4] ^= 0x01;
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      corruptCrc,
      job("SNAPSHOT_INVENTORY"),
    ),
    /invalid CRC/i,
  );

  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      testPng({ includeIend: false }),
      job("SNAPSHOT_INVENTORY"),
    ),
    /missing.*IEND/i,
  );
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      testPng({ trailing: Buffer.from("untrusted") }),
      job("SNAPSHOT_INVENTORY"),
    ),
    /after IEND/i,
  );
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      testPng({
        idatParts: 2,
        chunksBetweenIdat: [testPngChunk("tEXt", Buffer.from("x"))],
      }),
      job("SNAPSHOT_INVENTORY"),
    ),
    /exact image scanlines|consecutive/i,
  );
});

test("SCREENSHOT permits only canonical Chromium PNG encoding", async () => {
  const input = uploadInput("SCREENSHOT", "image/png");
  await assertChannelMaxManagedEvidenceContent(
    input,
    testPng({ colorType: 2 }),
    job("SNAPSHOT_INVENTORY"),
  );

  for (const invalidPng of [
    testPng({ bitDepth: 16 }),
    testPng({ colorType: 3 }),
    testPng({ colorType: 4 }),
    testPng({ interlaceMethod: 1 }),
    testPng({ compressionMethod: 1 }),
    testPng({ filterMethod: 1 }),
  ]) {
    await assert.rejects(
      assertChannelMaxManagedEvidenceContent(
        input,
        invalidPng,
        job("SNAPSHOT_INVENTORY"),
      ),
      /8-bit, non-interlaced Chromium RGB or RGBA/i,
    );
  }
});

test("SCREENSHOT requires one complete zlib stream with exact valid scanlines", async () => {
  const input = uploadInput("SCREENSHOT", "image/png");
  const exactLength = (320 * 4 + 1) * 200;

  for (const invalidPng of [
    testPng({ scanlines: Buffer.alloc(exactLength - 1) }),
    testPng({ scanlines: Buffer.alloc(exactLength + 1) }),
    testPng({ compressed: Buffer.from([0x78, 0x9c, 0x00]) }),
    testPng({
      compressed: Buffer.concat([
        deflateSync(Buffer.alloc(exactLength)),
        Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      ]),
    }),
  ]) {
    await assert.rejects(
      assertChannelMaxManagedEvidenceContent(
        input,
        invalidPng,
        job("SNAPSHOT_INVENTORY"),
      ),
      /exact image scanlines|decodable PNG/i,
    );
  }

  const invalidFilterScanlines = Buffer.alloc(exactLength);
  invalidFilterScanlines[0] = 5;
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      input,
      testPng({ scanlines: invalidFilterScanlines }),
      job("SNAPSHOT_INVENTORY"),
    ),
    /invalid scanline filter/i,
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

test("VC mutation DOM evidence accepts only the exact same-model pre/post state", async () => {
  const request = buildChannelMaxVcCanaryJobRequest("FORWARD");
  const mutationJob: ChannelMaxEvidenceJobBinding = {
    operation: "UPLOAD_MANUAL_ASSIGNMENT",
    accountId: CHANNELMAX_VC_CANARY.account_id,
    payloadJson: JSON.stringify(request.payload),
  };
  const document = {
    schema_version: CHANNELMAX_VC_CANARY_SNAPSHOT_SCHEMA,
    captured_at: CAPTURED_AT,
    phase: "PREWRITE",
    direction: "FORWARD",
    account_id: CHANNELMAX_VC_CANARY.account_id,
    selected_site_id: CHANNELMAX_VC_CANARY.selected_site_id,
    selected_site_name: CHANNELMAX_VC_CANARY.selected_site_name,
    assignment_sha256: channelMaxVcCanaryArtifact("FORWARD").sha256,
    baseline_inventory_snapshot_sha256:
      CHANNELMAX_VC_CANARY.prewrite_snapshot_sha256,
    upload_task_id: null,
    row: {
      sku: CHANNELMAX_VC_CANARY.sku,
      asin: CHANNELMAX_VC_CANARY.asin,
      repricing_model_id: CHANNELMAX_VC_CANARY.manual_model.id,
      repricing_model_name: CHANNELMAX_VC_CANARY.manual_model.name,
      minimum_price: CHANNELMAX_VC_CANARY.rollback.minimum_price,
      maximum_price: CHANNELMAX_VC_CANARY.rollback.maximum_price,
    },
  };
  await assertChannelMaxManagedEvidenceContent(
    uploadInput("DOM_SNAPSHOT", "application/json"),
    Buffer.from(JSON.stringify(document)),
    mutationJob,
  );

  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      uploadInput("DOM_SNAPSHOT", "application/json"),
      Buffer.from(
        JSON.stringify({
          ...document,
          row: { ...document.row, repricing_model_id: null },
        }),
      ),
      mutationJob,
    ),
    /exact expected VC state/i,
  );
  await assert.rejects(
    assertChannelMaxManagedEvidenceContent(
      uploadInput("DOM_SNAPSHOT", "application/json"),
      Buffer.from(
        JSON.stringify({
          ...document,
          row: { ...document.row, sku: "SZ-ASPI-JFAT" },
        }),
      ),
      mutationJob,
    ),
    /exact expected VC state/i,
  );
});
