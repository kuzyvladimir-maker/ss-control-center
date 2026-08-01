import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertWalmartStudioExactImageUrl,
  fetchWalmartStudioExactImage,
} from "../walmart-studio-draft-engine";

test("Walmart Studio draft engine contains no marketplace or UPC write adapter", async () => {
  const source = await readFile(
    new URL("../walmart-studio-draft-engine.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /getWalmartClient|requestRaw|submitFeed|uPCPool|reserveManagedUpc/);
  assert.match(source, /readProductTruthWalmartPilotCandidate/);
  assert.match(source, /buildDeterministicWalmartMultipackImage/);
  assert.match(source, /marketplace_mutated: false/);
  assert.match(source, /upc_reserved: false/);
});

test("exact-image reader permits current donor CDNs and rejects unknown hosts", () => {
  assert.equal(
    assertWalmartStudioExactImageUrl(
      "https://i5.walmartimages.com/asr/exact.jpeg?odnHeight=100",
    ).hostname,
    "i5.walmartimages.com",
  );
  assert.equal(
    assertWalmartStudioExactImageUrl(
      "https://target.scene7.com/is/image/Target/exact",
    ).hostname,
    "target.scene7.com",
  );
  assert.throws(
    () => assertWalmartStudioExactImageUrl("https://images.example.com/product.jpg"),
    /host is not approved/,
  );
});

test("exact-image reader validates every redirect before following it", async () => {
  const requested: string[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    requested.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/internal" },
    });
  }) as typeof fetch;
  await assert.rejects(
    fetchWalmartStudioExactImage(
      "https://images.salsify.com/exact.jpeg",
      fetchImpl,
    ),
    /unauthenticated HTTPS|host is not approved/,
  );
  assert.equal(requested.length, 1);
});

test("exact-image reader accepts a bounded image response", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const result = await fetchWalmartStudioExactImage(
    "https://images.salsify.com/exact.jpeg",
    (async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(bytes.byteLength),
      },
    })) as typeof fetch,
  );
  assert.deepEqual(result.bytes, Buffer.from(bytes));
  assert.equal(result.content_type, "image/jpeg");
});
