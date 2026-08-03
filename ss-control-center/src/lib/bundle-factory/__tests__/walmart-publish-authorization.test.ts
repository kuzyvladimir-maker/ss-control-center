import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("a studio listing is authorized by its sealed approval, the pilot by a signed permit", async () => {
  const publish = await read("../distribution/walmart-publish.ts");
  // The Ed25519 signer runs on the owner's own machine and one signature
  // authorizes exactly one SKU; a deployed app publishing batches can satisfy
  // neither. The studio lane therefore carries a different authorization —
  // not an absent one.
  assert.match(publish, /const studioAuthorized = isWalmartStudioLane\(input\.sku\.attributes\)/u);
  assert.match(publish, /\(!studioAuthorized && !input\.ownerPermitAuthorization\)/u);

  // Every other fence stays mandatory for BOTH lanes.
  assert.match(publish, /typeof input\.beforeFeedPost !== "function"/u);
  assert.match(publish, /\|\| !input\.lifecyclePostClaim/u);
  assert.match(publish, /\|\| !shippingTemplateContract/u);

  // What authorized the POST is still recorded, whichever lane it came from.
  assert.match(publish, /pilotPermitSha256: authorization/u);
  assert.match(publish, /\.distribution_approval/u);

  const pipeline = await read("../distribution/distribution-pipeline.ts");
  // The one-signature-per-SKU rule still governs pilot SKUs exactly as before.
  assert.match(pipeline, /pilotApplyCandidates\.length !== 1/u);
  assert.match(pipeline, /!isWalmartStudioLane\(sku\.attributes\)/u);
  // And the sealed approval is still asserted for every applied Walmart SKU.
  assert.match(pipeline, /assertValidWalmartDistributionApproval\(sku\)/u);
});

test("approval binds the validation run that actually produced the status", async () => {
  const pipeline = await read("../validation/validation-pipeline.ts");
  // validation_check_id was never stamped, so it stayed null and every Walmart
  // approval failed with "must bind the current ChannelSKU validation run".
  assert.match(pipeline, /validation_check_id: validationRunId/u);
  assert.match(pipeline, /wmvalidation-\$\{sha256WalmartJson\(/u);

  const contract = await read("../walmart-listing-contract.ts");
  // Seal and verify read one function, so they cannot hash different things.
  assert.match(contract, /function walmartApprovalEvidence\(/u);
  assert.match(contract, /lane: "WALMART_STUDIO_DRAFT"/u);
  assert.match(contract, /lane: "WALMART_PILOT"/u);
});
