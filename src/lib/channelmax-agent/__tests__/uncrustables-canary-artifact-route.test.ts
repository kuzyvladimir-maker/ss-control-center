import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, before, test } from "node:test";

import { NextRequest } from "next/server";

import {
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  PATCH,
  POST,
  PUT,
} from "@/app/api/openclaw/channelmax/canary-artifacts/[digest]/route";
import {
  channelMaxVcCanaryArtifact,
  CHANNELMAX_VC_CANARY,
  CHANNELMAX_VC_CANARY_ARTIFACT_MEDIA_TYPE,
  CHANNELMAX_VC_CANARY_ARTIFACT_ROUTE_PREFIX,
} from "../uncrustables-same-model-canary";

const TOKEN = "jackie-canary-artifact-route-test-token";
const previousJackieToken = process.env.JACKIE_API_TOKEN;
const previousSsccToken = process.env.SSCC_API_TOKEN;

before(() => {
  process.env.JACKIE_API_TOKEN = TOKEN;
  delete process.env.SSCC_API_TOKEN;
});

after(() => {
  if (previousJackieToken === undefined) delete process.env.JACKIE_API_TOKEN;
  else process.env.JACKIE_API_TOKEN = previousJackieToken;
  if (previousSsccToken === undefined) delete process.env.SSCC_API_TOKEN;
  else process.env.SSCC_API_TOKEN = previousSsccToken;
});

function request(url: string, method = "GET", token: string | null = TOKEN) {
  return new NextRequest(url, {
    method,
    headers: token === null ? undefined : { authorization: `Bearer ${token}` },
  });
}

function context(digest: string) {
  return { params: Promise.resolve({ digest }) };
}

for (const direction of ["FORWARD", "ROLLBACK"] as const) {
  test(`authenticated GET serves only the exact ${direction} bytes and metadata`, async () => {
    const artifact = channelMaxVcCanaryArtifact(direction);
    const wireName = `${artifact.sha256}.txt`;
    assert.equal(
      artifact.url,
      `${CHANNELMAX_VC_CANARY.artifact_origin}${CHANNELMAX_VC_CANARY_ARTIFACT_ROUTE_PREFIX}/${wireName}`,
    );

    const response = await GET(request(artifact.url), context(wireName));
    assert.equal(response.status, 200);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      artifact.bytes,
    );
    assert.equal(response.headers.get("content-length"), "103");
    assert.equal(
      response.headers.get("content-type"),
      CHANNELMAX_VC_CANARY_ARTIFACT_MEDIA_TYPE,
    );
    assert.equal(
      response.headers.get("x-channelmax-artifact-sha256"),
      artifact.sha256,
    );
    assert.equal(response.headers.get("etag"), `"${artifact.sha256}"`);
    assert.equal(
      response.headers.get("digest"),
      `sha-256=${Buffer.from(artifact.sha256, "hex").toString("base64")}`,
    );
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store, max-age=0",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
}

test("artifact GET requires the existing worker bearer auth", async () => {
  const artifact = channelMaxVcCanaryArtifact("FORWARD");
  const wireName = `${artifact.sha256}.txt`;
  for (const token of [null, "wrong-token"]) {
    const response = await GET(
      request(artifact.url, "GET", token),
      context(wireName),
    );
    assert.equal(response.status, 401);
  }
});

test("every digest variant outside the two pinned wire names is rejected", async () => {
  const artifact = channelMaxVcCanaryArtifact("FORWARD");
  const invalidNames = [
    `${"f".repeat(64)}.txt`,
    artifact.sha256,
    `${artifact.sha256.toUpperCase()}.txt`,
    `${artifact.sha256}.tsv`,
    `${artifact.sha256}.txt.extra`,
  ];
  for (const wireName of invalidNames) {
    const url =
      `${CHANNELMAX_VC_CANARY.artifact_origin}${CHANNELMAX_VC_CANARY_ARTIFACT_ROUTE_PREFIX}/${wireName}`;
    const response = await GET(request(url), context(wireName));
    assert.equal(response.status, 404, wireName);
    assert.equal((await response.json()).error, "CANARY_ARTIFACT_NOT_FOUND");
  }

  const validWireName = `${artifact.sha256}.txt`;
  const queryResponse = await GET(
    request(`${artifact.url}?download=1`),
    context(validWireName),
  );
  assert.equal(queryResponse.status, 404);
});

test("all non-GET route methods fail closed without returning artifact bytes", async () => {
  const artifact = channelMaxVcCanaryArtifact("ROLLBACK");
  const handlers = [
    ["HEAD", HEAD],
    ["POST", POST],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
    ["OPTIONS", OPTIONS],
  ] as const;

  for (const [method, handler] of handlers) {
    const response = await handler(request(artifact.url, method));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET");
    if (method !== "HEAD") {
      assert.equal((await response.json()).error, "METHOD_NOT_ALLOWED");
    }
  }
});

test("non-GET methods do not bypass bearer auth", async () => {
  const artifact = channelMaxVcCanaryArtifact("ROLLBACK");
  const response = await POST(request(artifact.url, "POST", null));
  assert.equal(response.status, 401);
});
