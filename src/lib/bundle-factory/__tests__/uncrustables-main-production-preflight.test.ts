// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-main-production-preflight.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
  PRODUCTION_UNCRUSTABLES_MAIN_OWNER_APPROVALS,
  preflightDeclaredUncrustablesMainHash,
  preflightProductionUncrustablesMain,
  verifyProductionUncrustablesAuthenticityArtifacts,
  verifyUncrustablesMainPublishPermit,
  type ProductionUncrustablesMainIdentity,
} from "../audit/uncrustables-main-production-preflight";
import { evaluateUncrustablesMainAuthenticity } from "../audit/uncrustables-main-authenticity";

const url = (name: string) => `https://approved-assets.r2.dev/${name}.png`;

const identities: Array<
  ProductionUncrustablesMainIdentity & { image_sha256: string; path: string }
> = [
  {
    sku: "PB-ASAF-G2T6",
    main_image_url: url("pb"),
    image_sha256:
      "4cdd7bec9ab5c1d5f97b5746d7569a4ffc891a36b8d1fb159168176f06e19076",
    path: "data/audits/uncrustables-gpt-image-2-previews-20260718/01c-retail-boxes-single-pb-24-four-gel-packs.png",
    pack_count: 24,
    components: [
      {
        product_name:
          "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
        qty: 24,
      },
    ],
  },
  {
    sku: "YG-ASH6-BCXX",
    main_image_url: url("pb-blackberry"),
    image_sha256:
      "9d0294242508529022a0e2b1cdd2df0adce469ef9dbb8bd2dd7d448031ea839d",
    path: "data/audits/uncrustables-gpt-image-2-previews-20260718/02b-retail-boxes-mix-pb-blackberry-24-four-gel-packs.png",
    pack_count: 24,
    components: [
      {
        product_name:
          "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
        qty: 12,
      },
      {
        product_name:
          "Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct",
        qty: 12,
      },
    ],
  },
  {
    sku: "TL-ASHN-ZRKG",
    main_image_url: url("hazelnut-berry"),
    image_sha256:
      "d2f7ffdd0a3e411725a3dc1dac013f9f5f50c1e6dd9d34164c12cbe5cacc722f",
    path: "data/audits/uncrustables-gpt-image-2-previews-20260718/03-individual-wraps-mix-hazelnut-berry-24.png",
    pack_count: 24,
    components: [
      {
        product_name:
          "Smucker's Uncrustables Chocolate Flavored Hazelnut Spread Frozen Sandwich - 18oz/10ct",
        qty: 12,
      },
      {
        product_name:
          "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct",
        qty: 12,
      },
    ],
  },
];

test("sealed registry and all three exact style approvals verify without becoming publish permits", () => {
  assert.doesNotThrow(verifyProductionUncrustablesAuthenticityArtifacts);
  assert.equal(PRODUCTION_UNCRUSTABLES_MAIN_OWNER_APPROVALS.entries.length, 3);
  for (const [index, identity] of identities.entries()) {
    const proof = PRODUCTION_UNCRUSTABLES_MAIN_OWNER_APPROVALS.entries[index];
    const authenticity = evaluateUncrustablesMainAuthenticity({
      ...proof,
      registry: PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
    });
    assert.equal(authenticity.pass, true, JSON.stringify(authenticity.hard_fails));
    assert.equal(proof.approval_scope, "style-reference-only");
    assert.equal(proof.production_eligible, false);
    assert.deepEqual(proof.pixel_dimensions, { width: 1536, height: 1536 });

    const result = preflightDeclaredUncrustablesMainHash(identity);
    assert.equal(result.pass, false);
    assert.equal(result.findings[0]?.code, "APPROVAL_NOT_PRODUCTION_ELIGIBLE");
    assert.equal(result.permit, undefined);
  }
});

test("1536px style approval blocks before reading or trusting runtime bytes", async () => {
  const identity = identities[0];
  let reads = 0;
  const result = await preflightProductionUncrustablesMain(identity, {
    fetchImageBytes: async () => {
      reads++;
      return Buffer.from("even exact or transformed bytes must not inherit style approval");
    },
  });
  assert.equal(result.pass, false);
  assert.equal(result.findings[0]?.code, "APPROVAL_NOT_PRODUCTION_ELIGIBLE");
  assert.equal(reads, 0);
});

test("absence of an approved SKU proof blocks without reading the network", async () => {
  let reads = 0;
  const result = await preflightProductionUncrustablesMain(
    {
      ...identities[0],
      sku: "UNREVIEWED-SKU",
    },
    {
      fetchImageBytes: async () => {
        reads++;
        return Buffer.from("must not be read");
      },
    },
  );
  assert.equal(result.pass, false);
  assert.equal(result.findings[0]?.code, "NO_APPROVED_PROOF_FOR_SKU");
  assert.equal(reads, 0);
});

test("runtime count, flavor, and recipe drift cannot escape the style-only block", () => {
  const quantityDrift = structuredClone(identities[1]);
  quantityDrift.components[0].qty = 8;
  quantityDrift.components[1].qty = 16;
  assert.equal(
    preflightDeclaredUncrustablesMainHash(quantityDrift).findings[0]?.code,
    "APPROVAL_NOT_PRODUCTION_ELIGIBLE",
  );

  const countDrift = structuredClone(identities[0]);
  countDrift.pack_count = 20;
  assert.equal(
    preflightDeclaredUncrustablesMainHash(countDrift).findings[0]?.code,
    "APPROVAL_NOT_PRODUCTION_ELIGIBLE",
  );

  const fictional = structuredClone(identities[0]);
  fictional.components[0].product_name = "Uncrustables Cosmic Cherry Dream";
  assert.equal(
    preflightDeclaredUncrustablesMainHash(fictional).findings[0]?.code,
    "APPROVAL_NOT_PRODUCTION_ELIGIBLE",
  );
});

test("Amazon boundary rejects a missing authenticity permit", () => {
  assert.equal(
    verifyUncrustablesMainPublishPermit(undefined, identities[2]).valid,
    false,
  );
});
