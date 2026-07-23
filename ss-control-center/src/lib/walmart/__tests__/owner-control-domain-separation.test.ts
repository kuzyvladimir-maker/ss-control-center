import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import test from "node:test";

import {
  walmartNewSkuCatalogActivationOwnerApprovalSigningMessage,
  type WalmartNewSkuCatalogActivationOwnerApprovalEnvelope,
} from "@/lib/bundle-factory/walmart-new-sku-catalog-activation";
import {
  walmartOwnerPermitSigningMessage,
  type WalmartOwnerPermitSigningEnvelope,
} from "@/lib/bundle-factory/walmart-owner-permit";

import {
  walmartItemReportReissueOwnerDispositionV2SigningMessage,
  type WalmartItemReportReissueOwnerDispositionV2SigningEnvelope,
} from "../item-report-reissue-owner-disposition-v2";

test("one owner-control key cannot replay a signature across report, catalog, and SKU domains", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identicalEnvelopeBytes = {
    schema_version: "domain-separation-probe",
    algorithm: "Ed25519",
    key_id: "walmart-owner-control-domain-test",
    owner_public_key_spki_sha256: "1".repeat(64),
    signed_body: { exact_probe: true },
  };
  const reportMessage = walmartItemReportReissueOwnerDispositionV2SigningMessage(
    identicalEnvelopeBytes as unknown as
      WalmartItemReportReissueOwnerDispositionV2SigningEnvelope,
  );
  const catalogMessage = walmartNewSkuCatalogActivationOwnerApprovalSigningMessage(
    identicalEnvelopeBytes as unknown as
      WalmartNewSkuCatalogActivationOwnerApprovalEnvelope,
  );
  const skuMessage = walmartOwnerPermitSigningMessage(
    identicalEnvelopeBytes as unknown as WalmartOwnerPermitSigningEnvelope,
  );

  assert.notDeepEqual(reportMessage, catalogMessage);
  assert.notDeepEqual(reportMessage, skuMessage);
  assert.notDeepEqual(catalogMessage, skuMessage);

  const reportSignature = sign(null, reportMessage, privateKey);
  assert.equal(verify(null, reportMessage, publicKey, reportSignature), true);
  assert.equal(verify(null, catalogMessage, publicKey, reportSignature), false);
  assert.equal(verify(null, skuMessage, publicKey, reportSignature), false);

  const catalogSignature = sign(null, catalogMessage, privateKey);
  assert.equal(verify(null, catalogMessage, publicKey, catalogSignature), true);
  assert.equal(verify(null, reportMessage, publicKey, catalogSignature), false);
  assert.equal(verify(null, skuMessage, publicKey, catalogSignature), false);

  const skuSignature = sign(null, skuMessage, privateKey);
  assert.equal(verify(null, skuMessage, publicKey, skuSignature), true);
  assert.equal(verify(null, reportMessage, publicKey, skuSignature), false);
  assert.equal(verify(null, catalogMessage, publicKey, skuSignature), false);
});
