import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createClient } from "@libsql/client";

import {
  loadAuthoritativeWalmartItemReportEvidence,
  readCanonicalListingComponents,
} from "../../../../scripts/build-product-truth-legacy-bridge-plan";
import {
  buildCanonicalProductVariantKey,
} from "../canonical-product-variant";
import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  compileProductTruthLegacyBridgePlan,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeComponentRow,
  type ProductTruthAuthoritativeWalmartItemReportEvidenceRow,
  type ProductTruthDirectTargetContentEvidence,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "../product-truth-legacy-bridge";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "../product-truth-operational-run-contract";
import type { Phase1ScopeManifest } from "../phase1-scope-manifest";

function component(
  overrides: Partial<ProductTruthLegacyBridgeComponentRow> = {},
): ProductTruthLegacyBridgeComponentRow {
  return {
    id: "component-1",
    sku: "SKU-1",
    idx: 0,
    product: "Acme Crunch Chips",
    flavor: "Barbecue",
    size: "8 oz",
    qty: 1,
    costMethod: "exact",
    retailer: "walmart",
    matchedTitle: null,
    perUnitCost: 3.49,
    lineCost: 3.49,
    donorProductId: "donor-1",
    contentDonorProductId: null,
    priceEvidenceDonorProductId: null,
    priceEvidenceOfferId: null,
    ...overrides,
  };
}

function donor(
  overrides: Partial<ProductTruthLegacyBridgeDonorRow> = {},
): ProductTruthLegacyBridgeDonorRow {
  return {
    id: "donor-1",
    brand: "Acme",
    productLine: null,
    flavor: null,
    containerType: null,
    size: "8 oz",
    category: "Dry",
    upc: "036000291452",
    gtin: null,
    title: "Acme Crunch Chips Barbecue Bag 8 oz",
    description: "Crunchy barbecue chips.",
    bullets: "[\"One bag\"]",
    attributes: "[{\"name\":\"Food condition\",\"value\":\"Shelf-Stable\"}]",
    nutritionFacts: "{\"calories\":150,\"allergens\":[]}",
    ingredients: "Potatoes, oil, seasoning.",
    mainImageUrl: "https://images.example/main.jpg",
    imageUrls: "[\"https://images.example/main.jpg\"]",
    identityKey: "acme-crunch-chips-barbecue-8oz",
    identityStatus: "legacy_unverified",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function offer(
  overrides: Partial<ProductTruthLegacyBridgeOfferRow> = {},
): ProductTruthLegacyBridgeOfferRow {
  return {
    id: "offer-1",
    donorProductId: "donor-1",
    retailer: "walmart",
    retailerProductId: "123",
    via: "direct",
    price: 3.49,
    packSizeSeen: 1,
    pricePerUnit: 3.49,
    currency: "USD",
    zip: "33765",
    localityEvidence: "zip_scoped",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/123",
    isFirstParty: true,
    sourceApi: "test",
    fetchedAt: "2026-07-26T11:00:00.000Z",
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    brand: "Acme",
    product_line: "Crunch Chips",
    flavor: "Barbecue",
    size: "8 oz",
    container_type: "Bag",
    units_in_listing: 1,
    is_bundle: false,
    components: [],
    ...overrides,
  });
}

function snapshot(
  overrides: Partial<ProductTruthLegacyBridgeSnapshot> = {},
): ProductTruthLegacyBridgeSnapshot {
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: "2026-07-26T12:00:00.000Z",
    targetFingerprint: "a".repeat(64),
    manifest: {
      schemaVersion: "phase1-authoritative-scope-manifest/v3",
      sha256: "b".repeat(64),
      asOf: "2026-07-26T00:00:00.000Z",
      listingCount: 1,
    },
    listings: [{
      listingKey: "ptls1:test",
      channel: "walmart",
      storeIndex: 1,
      sku: "SKU-1",
      listingUpc: null,
      listingUpcSource: null,
      priorityGmv30d: null,
      priorityOrders30d: null,
      priorityUnits30d: null,
      priorityObservedAt: null,
      productIdentityJson: identity(),
      productIdentityUpdatedAt: "2026-07-10T00:00:00.000Z",
    }],
    components: [component()],
    donors: [donor()],
    offers: [offer()],
    canonicalDonorBindings: [],
    canonicalListingComponents: [],
    componentBarcodeEvidence: [],
    directTargetContentEvidence: [],
    authoritativeWalmartItemReportEvidence: [],
    ...overrides,
  };
}

function compile(value: ProductTruthLegacyBridgeSnapshot) {
  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(value);
  return compileProductTruthLegacyBridgePlan({
    snapshot: value,
    snapshotJson,
    snapshotSha256: productTruthLegacyBridgeBytesSha256(snapshotJson),
    generatedAt: "2026-07-26T13:00:00.000Z",
  });
}

function walmartItemReportEvidence(
  overrides: Partial<ProductTruthAuthoritativeWalmartItemReportEvidenceRow> = {},
): ProductTruthAuthoritativeWalmartItemReportEvidenceRow {
  const core = {
    schemaVersion:
      "product-truth-authoritative-walmart-item-report-evidence/1.0.0" as const,
    listingKey: "ptls1:test",
    storeIndex: 1,
    sku: "SKU-1",
    itemId: "123456789",
    title: "Acme Crunch Chips Barbecue Bag 8 oz (Pack of 4)",
    brand: "Acme",
    gtin: "00036000291452",
    upc: "036000291452",
    itemPageUrl: "https://www.walmart.com/ip/123456789",
    primaryImageUrl: "https://images.example/main.jpg",
    publishStatus: "PUBLISHED" as const,
    lifecycleStatus: "ACTIVE" as const,
    sourceReportId: "report-1",
    sourceReportName: "ItemReport.csv",
    sourceReportCapturedAt: "2026-07-26T11:00:00.000Z",
    sourceReportSha256: "d".repeat(64),
    sourceReportByteLength: 1000,
    sourceRowNumber: 2,
  };
  const merged = { ...core, ...overrides };
  const hashInput = { ...merged };
  delete (
    hashInput as Partial<ProductTruthAuthoritativeWalmartItemReportEvidenceRow>
  ).evidenceRowSha256;
  return {
    ...merged,
    evidenceRowSha256:
      overrides.evidenceRowSha256
      ?? productTruthOperationalSha256(hashInput),
  };
}

function walmartManifestForReport(
  csv: string,
  title = "Acme Crunch Chips Barbecue Bag 8 oz (Pack of 4)",
): Phase1ScopeManifest {
  const headers = csv.slice(0, csv.indexOf("\n")).split(",");
  const contentSha256 = createHash("sha256").update(csv).digest("hex");
  return {
    sourceReports: [{
      channel: "walmart",
      storeIndex: 1,
      reportId: "report-1",
      reportType: "ITEM_CATALOG",
      scopeKey: "store1",
      accountId: "account-1",
      storeId: "store1",
      marketplaceId: null,
      capturedAt: "2026-07-26T11:00:00.000Z",
      sourceName: "ItemReport.csv",
      contentSha256,
      byteLength: Buffer.byteLength(csv),
      delimiter: "comma",
      headers,
      totalRows: 1,
      expectedRowCount: 1,
      liveRows: 1,
      statusCounts: { "PUBLISHED|ACTIVE": 1 },
    }],
    listings: [{
      channel: "walmart",
      scopeKey: "store1",
      storeIndex: 1,
      accountId: "account-1",
      storeId: "store1",
      marketplaceId: null,
      listingKey: "ptls1:test",
      listingId: "123456789",
      sku: "SKU-1",
      title,
      sourceStatus: "PUBLISHED",
      sourceLifecycleStatus: "ACTIVE",
      phase1Status: "NOT_STARTED",
      sourceReportId: "report-1",
      sourceCapturedAt: "2026-07-26T11:00:00.000Z",
      sourceContentSha256: contentSha256,
    }],
  } as Phase1ScopeManifest;
}

test("Walmart ITEM report loader binds exact bytes and manifest row identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pt-walmart-report-"));
  try {
    const csv = [
      [
        "SKU",
        "Item ID",
        "Product Name",
        "Lifecycle Status",
        "Publish Status",
        "Brand",
        "GTIN",
        "UPC",
        "Item Page URL",
        "Primary Image URL",
      ].join(","),
      [
        "SKU-1",
        "123456789",
        "\"Acme Crunch Chips Barbecue Bag 8 oz (Pack of 4)\"",
        "ACTIVE",
        "PUBLISHED",
        "Acme",
        "00036000291452",
        "036000291452",
        "https://www.walmart.com/ip/123456789",
        "https://images.example/main.jpg",
      ].join(","),
      "",
    ].join("\n");
    const path = join(directory, "ItemReport.csv");
    await writeFile(path, csv);
    const manifest = walmartManifestForReport(csv);
    const rows = await loadAuthoritativeWalmartItemReportEvidence(
      path,
      manifest,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, manifest.listings[0]?.title);
    assert.equal(rows[0]?.brand, "Acme");
    assert.match(rows[0]?.evidenceRowSha256 ?? "", /^[a-f0-9]{64}$/);

    await writeFile(path, `${csv}drift`);
    await assert.rejects(
      () => loadAuthoritativeWalmartItemReportEvidence(path, manifest),
      /WALMART_ITEM_REPORT_BYTES_MISMATCH/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Walmart ITEM report loader rejects title or item identity drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pt-walmart-report-"));
  try {
    const csv = [
      "SKU,Item ID,Product Name,Lifecycle Status,Publish Status,Brand,GTIN,UPC,Item Page URL,Primary Image URL",
      "SKU-1,987654321,Wrong title,ACTIVE,PUBLISHED,Acme,,,,",
      "",
    ].join("\n");
    const path = join(directory, "ItemReport.csv");
    await writeFile(path, csv);
    const manifest = walmartManifestForReport(csv);
    await assert.rejects(
      () => loadAuthoritativeWalmartItemReportEvidence(path, manifest),
      /WALMART_ITEM_REPORT_LISTING_MISMATCH/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative Walmart exact-title multipack recovers a missing legacy recipe", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    }],
    components: [],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence()],
  });
  const plan = compile(value);
  const scope = plan.scopes[0]!;
  const componentPlan = scope.components[0]!;
  assert.equal(scope.disposition, "CONTENT_ONLY_CANONICALIZATION_CANDIDATE");
  assert.equal(componentPlan.qty, 4);
  assert.equal(componentPlan.legacyComponentId, null);
  assert.equal(
    componentPlan.identityProof,
    "EXACT_AUTHORITATIVE_WALMART_REPORT_TITLE",
  );
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
  assert.equal(componentPlan.donorProductId, "donor-1");
});

test("authoritative Walmart title recovery accepts a report-proven expanded brand phrase", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    }],
    components: [],
    donors: [donor({
      brand: "Acme",
      title: "Acme Foods Crunch Chips Barbecue Bag 8 oz",
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: "Acme Foods Crunch Chips Barbecue Bag 8 oz (Pack of 4)",
      brand: "Acme Foods",
    })],
  });
  const componentPlan = compile(value).scopes[0]!.components[0]!;
  assert.equal(
    componentPlan.identityProof,
    "EXACT_AUTHORITATIVE_WALMART_REPORT_TITLE",
  );
  assert.equal(componentPlan.targetIdentity?.brand, "Acme Foods");
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
});

test("authoritative Walmart title recovery accepts an attribute-corroborated brand expansion", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    }],
    components: [],
    donors: [donor({
      brand: "Bigelow",
      title: "Bigelow Salted Caramel Black Tea Bags 18 Count",
      size: "18 Count",
      attributes: JSON.stringify([{
        name: "Brand",
        value: "Bigelow Tea",
      }]),
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: "Bigelow Salted Caramel Black Tea Bags 18 Count (Pack of 4)",
      brand: "Bigelow Tea",
    })],
  });
  const componentPlan = compile(value).scopes[0]!.components[0]!;
  assert.equal(
    componentPlan.identityProof,
    "EXACT_AUTHORITATIVE_WALMART_REPORT_TITLE",
  );
  assert.equal(componentPlan.targetIdentity?.brand, "Bigelow");
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
});

test("authoritative Walmart exact title accepts a structured size beside an inner count", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    }],
    components: [],
    donors: [donor({
      brand: "La Banderita",
      title: "La Banderita Birria Flour Tortillas 10.8 oz 14 Count Bag",
      size: "10.8 oz",
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: "La Banderita Birria Flour Tortillas 10.8 oz 14 Count Bag (Pack of 6)",
      brand: "La Banderita",
    })],
  });
  const scope = compile(value).scopes[0]!;
  assert.notEqual(scope.disposition, "QUARANTINE");
  assert.equal(scope.components[0]?.qty, 6);
  assert.equal(scope.components[0]?.matcherVerdict, "EXACT_IDENTITY");
});

test("authoritative Walmart exact title uses the agreeing legacy package size", () => {
  const title =
    "Jack Link's Sweet Hot Beef Jerky 2.85 oz 9 g Protein Per Serving";
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Jack Link's",
        product_line: "Beef Jerky",
        flavor: "Sweet Hot",
        size: "2.85 oz",
        units_in_listing: 4,
      }),
    }],
    components: [component({
      product: "Beef Jerky",
      flavor: "Sweet Hot",
      size: "2.85 oz",
      qty: 4,
    })],
    donors: [donor({
      brand: "Jack Link's",
      title,
      size: "9 g",
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: `${title} (Pack of 4)`,
      brand: "Jack Link's",
    })],
  });
  const componentPlan = compile(value).scopes[0]!.components[0]!;
  assert.equal(componentPlan.targetIdentity?.size, "2.85 oz");
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
});

test("authoritative Walmart exact title accepts Fluid Ounce and fl. oz. package evidence", () => {
  for (const sizeLabel of ["12 Fluid Ounce", "12 fl. oz."]) {
    const title = `Hidden Valley Seafood Secret Sauce ${sizeLabel}`;
    const value = snapshot({
      listings: [{
        ...snapshot().listings[0],
        productIdentityJson: identity({
          brand: "Hidden Valley",
          product_line: "Seafood Secret Sauce",
          flavor: null,
          size: "12 fl oz",
          units_in_listing: 4,
        }),
      }],
      components: [component({
        product: "Seafood Secret Sauce",
        flavor: null,
        size: "12 fl oz",
        qty: 4,
        donorProductId: "stale-adjacent-donor",
      })],
      donors: [donor({
        brand: "Hidden Valley",
        title,
        size: "12 fl oz",
      })],
      authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
        title: `${title} (Pack of 4)`,
        brand: "Hidden Valley",
      })],
    });
    const componentPlan = compile(value).scopes[0]!.components[0]!;
    assert.equal(
      componentPlan.identityProof,
      "EXACT_AUTHORITATIVE_WALMART_REPORT_TITLE",
    );
    assert.equal(componentPlan.targetIdentity?.size, "12 fl oz");
    assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
  }
});

test("authoritative Walmart exact title normalizes explicit tea-bag count evidence", () => {
  const title = "Celestial Seasonings Lemon Honey Tea 16 Count";
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Celestial Seasonings",
        product_line: "Lemon Honey Tea",
        flavor: null,
        size: "16 Count",
        units_in_listing: 4,
      }),
    }],
    components: [component({
      product: "Lemon Honey Tea",
      flavor: null,
      size: "16 tea bags",
      qty: 4,
    })],
    donors: [donor({
      brand: "Celestial Seasonings",
      title,
      size: "16 Count",
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: `${title} (Pack of 4)`,
      brand: "Celestial Seasonings",
    })],
  });
  const componentPlan = compile(value).scopes[0]!.components[0]!;
  assert.equal(componentPlan.targetIdentity?.size, "16 count");
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
});

test("authoritative Walmart exact title falls back to report-proven donor count when legacy mass is a different dimension", () => {
  const title = "Jammin Lemon Ginger Herbal Tea 20 Count";
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Jammin",
        product_line: "Lemon Ginger Herbal Tea",
        flavor: null,
        size: "20 Count",
        units_in_listing: 4,
      }),
    }],
    components: [component({
      product: "Lemon Ginger Herbal Tea",
      flavor: null,
      size: "1.6 oz (45g)",
      qty: 4,
    })],
    donors: [donor({
      brand: "Jammin",
      title,
      size: "20 Count",
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: `${title} (Pack of 4)`,
      brand: "Jammin",
    })],
  });
  const componentPlan = compile(value).scopes[0]!.components[0]!;
  assert.equal(componentPlan.targetIdentity?.size, "20 Count");
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
});

test("authoritative Walmart exact title never treats nutrition protein grams as package size", () => {
  const title = "Quest Chocolate Brownie Protein Bar 20g Protein";
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    }],
    components: [],
    donors: [donor({
      brand: "Quest",
      title,
      size: "20 g",
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: `${title} (Pack of 4)`,
      brand: "Quest",
    })],
  });
  assert.equal(compile(value).scopes[0]?.disposition, "QUARANTINE");
});

test("authoritative Walmart exact title accepts a one-pack donor with explicit net-content attributes", () => {
  const donorTitle =
    "Cirkul Wild Splash Gecko Grape Flavor Cartridge Drink Mix 1-Pack";
  const reportTitle =
    "Cirkul Wild Splash Gecko Grape Flavor Cartridge Drink Mix (Pack of 4)";
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    }],
    components: [],
    donors: [donor({
      brand: "Cirkul",
      title: donorTitle,
      size: null,
      attributes: JSON.stringify([
        { name: "Net content statement", value: "20 mL (0.68 fl oz)" },
        { name: "Count ", value: "1" },
      ]),
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: reportTitle,
      brand: "Cirkul",
    })],
  });
  const componentPlan = compile(value).scopes[0]!.components[0]!;
  assert.equal(componentPlan.targetIdentity?.size, "20 mL (0.68 fl oz)");
  assert.equal(componentPlan.qty, 4);
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
});

test("authoritative Walmart exact title accepts an explicit structured item count", () => {
  const title =
    "Scotch-Brite Zero Scratch Non-Scratch Cleaning Scrub Sponge 3 Dish Sponges";
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    }],
    components: [],
    donors: [donor({
      brand: "Scotch-Brite",
      title,
      size: null,
      attributes: JSON.stringify([
        { name: "Count ", value: "3" },
        { name: "Items included", value: "3 SCRUB SPONGES" },
      ]),
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title,
      brand: "Scotch-Brite",
    })],
  });
  const componentPlan = compile(value).scopes[0]!.components[0]!;
  assert.equal(componentPlan.targetIdentity?.size, "3 count");
  assert.equal(componentPlan.qty, 1);
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
});

test("authoritative Walmart title recovery rejects ambiguous or contradictory legacy package evidence", () => {
  const title =
    "Guerrero Street Taco Zero Net Carbs Tortillas 14 ct 8.89 oz";
  const base = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Guerrero",
        product_line: "Street Taco Tortillas",
        flavor: "Zero Net Carbs",
        size: "8.89 oz",
        units_in_listing: 4,
      }),
    }],
    components: [component({
      product: "Street Taco Tortillas",
      flavor: "Zero Net Carbs",
      size: "8.89 oz (14 ct)",
      qty: 4,
    })],
    donors: [donor({
      brand: "Guerrero",
      title,
      size: "14 ct",
    })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: `${title} (Pack of 4)`,
      brand: "Guerrero",
    })],
  });
  assert.equal(compile(base).scopes[0]?.disposition, "QUARANTINE");

  base.components[0] = component({
    product: "Street Taco Tortillas",
    flavor: "Zero Net Carbs",
    size: "8.89 oz",
    qty: 3,
  });
  assert.equal(compile(base).scopes[0]?.disposition, "QUARANTINE");
});

test("authoritative Walmart title recovery rejects a non-prefix brand expansion", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
      productIdentityUpdatedAt: null,
    }],
    components: [],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      brand: "Acme Chips",
    })],
  });
  assert.equal(compile(value).scopes[0]!.disposition, "QUARANTINE");
});

test("authoritative Walmart title recovery keeps adjacent variants quarantined", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
    }],
    components: [],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence({
      title: "Acme Crunch Chips Hot Bag 8 oz (Pack of 4)",
    })],
  });
  assert.equal(compile(value).scopes[0]!.disposition, "QUARANTINE");
});

test("authoritative Walmart title recovery rejects duplicate donors and placeholders", () => {
  const duplicate = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
    }],
    components: [],
    donors: [donor(), donor({ id: "donor-2" })],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence()],
  });
  assert.equal(compile(duplicate).scopes[0]!.disposition, "QUARANTINE");

  const placeholderEvidence = walmartItemReportEvidence({
    title: "Coming Soon (Pack of 2)",
    brand: "Coming",
  });
  const placeholder = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: null,
    }],
    components: [],
    donors: [donor({
      brand: "Coming",
      title: "Coming Soon",
      size: "8 oz",
    })],
    authoritativeWalmartItemReportEvidence: [placeholderEvidence],
  });
  assert.equal(compile(placeholder).scopes[0]!.disposition, "QUARANTINE");
});

test("authoritative report fallback never replaces an explicit mixed bundle", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        is_bundle: true,
        units_in_listing: 2,
        components: [{
          product: "Acme Crunch Chips",
          flavor: "Barbecue",
          size: "8 oz",
          qty: 2,
          container_type: "Bag",
        }],
      }),
    }],
    components: [],
    authoritativeWalmartItemReportEvidence: [walmartItemReportEvidence()],
  });
  const scope = compile(value).scopes[0]!;
  assert.equal(scope.disposition, "QUARANTINE");
  assert.notEqual(
    scope.components[0]?.identityProof,
    "EXACT_AUTHORITATIVE_WALMART_REPORT_TITLE",
  );
});

test("authoritative Walmart report evidence hash drift fails before planning", () => {
  const evidence = walmartItemReportEvidence();
  evidence.title = "Acme Crunch Chips Hot Bag 8 oz (Pack of 4)";
  const value = snapshot({
    authoritativeWalmartItemReportEvidence: [evidence],
  });
  assert.throws(
    () => compile(value),
    /LEGACY_BRIDGE_AUTHORITATIVE_WALMART_EVIDENCE_INVALID/,
  );
});

function directTargetEvidence(
  overrides: Partial<ProductTruthDirectTargetContentEvidence> = {},
) {
  const evidence: ProductTruthDirectTargetContentEvidence = {
    schemaVersion: "product-truth-direct-target-content-evidence/1.0.0",
    donorProductId: "donor-1",
    offerId: "offer-1",
    capturedAt: "2026-07-26T11:30:00.000Z",
    retailerContent: {
      retailer: "target",
      retailerProductId: "12973001",
      productUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      finalUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      httpStatus: 200,
      fetchedAt: "2026-07-26T11:30:00.000Z",
      htmlFile: "retailer-content.html",
      htmlSha256: "c".repeat(64),
      normalizedGtin14: "00036000291452",
      title: "Acme Crunch Chips Barbecue Bag 8 oz",
      description: "Exact Target description.",
      bullets: ["One exact bag"],
      attributes: ["State of Readiness: Ready to Eat"],
      nutritionFacts: { calories: 150 },
      ingredients: "Potatoes, oil, seasoning.",
      allergens: "Contains: Milk.",
    },
    safety: {
      modelCalls: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerReads: 1,
      databaseWrites: 0,
      walmartWrites: 0,
    },
    ...overrides,
  };
  return {
    ...evidence,
    evidenceArtifactSha256: productTruthLegacyBridgeBytesSha256(
      renderProductTruthOperationalJson(evidence),
    ),
  };
}

test("strict title exact donor can use byte-bound direct Target content", () => {
  const value = snapshot({
    donors: [donor({
      attributes: "[{\"label\":\"State of Readiness\",\"value\":\"Ready to Eat\"}]",
      nutritionFacts: "{\"calories\":150}",
      ingredients: "Potatoes, oil, seasoning.",
    })],
    offers: [offer({
      retailer: "target",
      retailerProductId: "12973001",
      productUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      sourceApi: "unwrangle",
    })],
    directTargetContentEvidence: [directTargetEvidence()],
  });
  const plan = compile(value);
  const componentPlan = plan.scopes[0].components[0];
  assert.equal(componentPlan.matcherVerdict, "EXACT_IDENTITY");
  assert.equal(componentPlan.identityProof, "STRICT_TITLE_MATCH");
  assert.equal(componentPlan.contentAssessment?.complete, true);
  assert.equal(
    componentPlan.contentAssessment?.contentOverride?.evidenceType,
    "DIRECT_TARGET_CONTENT",
  );
  assert.equal(
    componentPlan.contentAssessment?.allergensEvidence
      && (componentPlan.contentAssessment.allergensEvidence as { value: string }).value,
    "Contains: Milk.",
  );
  assert.equal(
    componentPlan.contentAssessment?.storageEvidence
      && (componentPlan.contentAssessment.storageEvidence as { value: string }).value,
    "Ready to Eat",
  );
});

test("legacy label-shaped readiness attribute is accepted as explicit storage evidence", () => {
  const value = snapshot({
    donors: [donor({
      attributes: "[{\"label\":\"State of Readiness\",\"value\":\"Ready to Eat\"}]",
    })],
  });
  const assessment = compile(value).scopes[0].components[0].contentAssessment;
  assert.equal(assessment?.complete, true);
  assert.deepEqual(
    assessment?.storageEvidence,
    { label: "State of Readiness", value: "Ready to Eat" },
  );
});

test("direct Target evidence fails closed when the exact offer binding is wrong", () => {
  const value = snapshot({
    offers: [offer({
      retailer: "target",
      retailerProductId: "12973001",
      productUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      sourceApi: "unwrangle",
    })],
    directTargetContentEvidence: [directTargetEvidence({ offerId: "wrong-offer" })],
  });
  assert.throws(
    () => compile(value),
    /LEGACY_BRIDGE_DIRECT_TARGET_CONTENT_EVIDENCE_INVALID/,
  );
});

test("direct Target content cannot rescue a strict matcher rejection", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({ flavor: "Hot" }),
    }],
    donors: [donor({
      attributes: "[{\"label\":\"State of Readiness\",\"value\":\"Ready to Eat\"}]",
      nutritionFacts: "{\"calories\":150}",
      ingredients: "Potatoes, oil, seasoning.",
    })],
    offers: [offer({
      retailer: "target",
      retailerProductId: "12973001",
      productUrl: "https://www.target.com/p/acme-crunch-chips/-/A-12973001",
      sourceApi: "unwrangle",
    })],
    directTargetContentEvidence: [directTargetEvidence()],
  });
  const componentPlan = compile(value).scopes[0].components[0];
  assert.equal(componentPlan.matcherVerdict, "REJECT");
  assert.equal(componentPlan.disposition, "QUARANTINE");
  assert.equal(componentPlan.contentAssessment, null);
});

test("fresh exact live-image barcode can prove a same-product multipack component", () => {
  const value = snapshot({
    capturedAt: "2026-07-27T13:00:00.000Z",
    listings: [{
      ...snapshot().listings[0],
      listingKey: "walmart:1:FaisalX-1148",
      sku: "FaisalX-1148",
      listingUpc: "742132418239",
      productIdentityJson: identity({
        brand: "Pepperidge Farm",
        product_line: "Hot Dog Buns",
        flavor: "White",
        size: "8 count",
        container_type: "Bag",
        units_in_listing: 2,
        base_unit: "Pepperidge Farm White Top-Sliced Hot Dog Buns 8 count bag",
      }),
    }],
    components: [component({
      id: "comp:FaisalX-1148:0",
      sku: "FaisalX-1148",
      product: "Hot Dog Buns",
      flavor: "White",
      size: "8 count",
      qty: 2,
      donorProductId: "donor-1",
    })],
    donors: [donor({
      id: "donor-1",
      brand: "Pepperidge Farm",
      size: "14 oz",
      upc: "014100070931",
      title: "Pepperidge Farm Bakery Classics Top Sliced White Hot Dog Buns - 14oz/8ct",
      bullets: "[\"8 BUNS: 8-count bag of Pepperidge Farm Top Sliced Soft White hot dog buns\"]",
    })],
    offers: [offer({
      donorProductId: "donor-1",
      retailer: "target",
      retailerProductId: "17189284",
      productUrl: "https://www.target.com/p/-/A-17189284",
      fetchedAt: "2026-07-27T12:00:00.000Z",
    })],
    componentBarcodeEvidence: [{
      schemaVersion: "product-truth-live-image-barcode-evidence/1.0.0",
      evidenceArtifactSha256: "1".repeat(64),
      listingKey: "walmart:1:FaisalX-1148",
      componentIndex: 0,
      capturedAt: "2026-07-27T12:45:00.000Z",
      sourceImageFile: "barcode-source.jpeg",
      image: {
        imageId: "image-1",
        slot: "gallery-2",
        sourceAssetSha256: "2".repeat(64),
        modelAssetSha256: "3".repeat(64),
      },
      barcode: {
        decoder: "APPLE_VISION_VNDETECTBARCODESREQUEST",
        symbology: "VNBarcodeSymbologyEAN13",
        payload: "0014100070931",
        normalizedGtin14: "00014100070931",
        confidence: 0.99,
      },
      visualObservation: {
        brandText: "PEPPERIDGE FARM",
        productText: "TOP SLICED SOFT WHITE HOT DOG BUNS",
        readableIdentity: "clear",
        multipleDistinctProducts: "no",
        gridCellKind: "single_sellable_package",
        externalPackageCount: 1,
        identityModifiers: ["top sliced"],
      },
      buyerPdp: {
        title: "Pepperidge Farm White Hot Dog Buns, Top Sliced, (Pack of 2)",
        brand: "Pepperidge Farm",
        productType: "Hot Dog Buns",
        productLine: "Bakery Classics",
        flavor: "White",
        count: 8,
        multipackQuantity: 2,
        containerType: "Bag",
        netContent: "14 Ounces",
        foodCondition: "Shelf-Stable",
      },
      retailerContent: {
        retailer: "target",
        retailerProductId: "17189284",
        productUrl: "https://www.target.com/p/-/A-17189284",
        finalUrl: "https://www.target.com/p/-/A-17189284",
        httpStatus: 200,
        fetchedAt: "2026-07-27T12:45:00.000Z",
        htmlFile: "retailer-content.html",
        htmlSha256: "c".repeat(64),
        normalizedGtin14: "00014100070931",
        title: "Pepperidge Farm Bakery Classics Top Sliced White Hot Dog Buns - 14oz/8ct",
        description: "Exact product description.",
        bullets: ["8 BUNS: 8-count bag"],
        attributes: ["State of Readiness: Ready to Eat"],
        nutritionFacts: { servings_per_container: "8" },
        ingredients: "Wheat flour, water.",
        allergens: "Contains: Wheat, Milk, Sesame Seeds.",
      },
      sourceHashes: {
        intakeIndexFileSha256: "4".repeat(64),
        intakeIndexBodySha256: "5".repeat(64),
        buyerPdpFileSha256: "6".repeat(64),
        observerPlanFileSha256: "7".repeat(64),
        observerPlanBodySha256: "8".repeat(64),
        observationsFileSha256: "9".repeat(64),
        executionIndexFileSha256: "a".repeat(64),
        executionIndexBodySha256: "b".repeat(64),
      },
      safety: {
        modelCalls: 0,
        providerCalls: 0,
        paidCalls: 0,
        retailerReads: 1,
        databaseWrites: 0,
        walmartWrites: 0,
      },
    }],
  });
  const plan = compile(value);
  const componentPlan = plan.scopes[0].components[0];
  assert.equal(plan.scopes[0].writeEligible, true);
  assert.equal(componentPlan.identityProof, "EXACT_LIVE_IMAGE_BARCODE");
  assert.equal(componentPlan.targetIdentity?.productLine, "bakery classics hot dog buns");
  assert.deepEqual(componentPlan.targetIdentity?.modifiers, ["top sliced"]);
  assert.match(
    String(componentPlan.targetVariant?.canonicalVariantId),
    /^cpv1:[a-f0-9]{64}$/,
  );
});

test("exact existing donor becomes a no-fetch canonicalization candidate", () => {
  const plan = compile(snapshot());
  assert.equal(plan.counts.exactCanonicalizationCandidates, 1);
  assert.equal(plan.scopes[0].writeEligible, true);
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "EXACT_IDENTITY");
  assert.equal(plan.scopes[0].components[0].donorOfferId, "offer-1");
  assert.equal(plan.scopes[0].components[0].contentAssessment?.complete, true);
  assert.match(
    String(plan.scopes[0].components[0].targetVariant?.canonicalVariantId),
    /^cpv1:[a-f0-9]{64}$/,
  );
  assert.deepEqual(plan.safety, {
    readOnly: true,
    databaseWrites: 0,
    providerCalls: 0,
    paidCalls: 0,
    retailerFetches: 0,
    mutatesLegacyCatalog: false,
    createsAdditionalCatalog: false,
    historicalExactFlagsAreIdentityProof: false,
    priceProxyMayProvideContent: false,
  });
  assert.equal(plan.pricePolicy.maxAgeMs, 86_400_000);
});

test("an empty legacy bundle flag recovers only as an exact one-component multipack", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        units_in_listing: 4,
        is_bundle: true,
        components: [],
      }),
    }],
    components: [component({ qty: 4 })],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].disposition, "EXACT_CANONICALIZATION_CANDIDATE");
  assert.equal(plan.scopes[0].components.length, 1);
  assert.equal(plan.scopes[0].components[0].qty, 4);
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "EXACT_IDENTITY");
  assert.equal(
    plan.scopes[0].blockers.some(
      (blocker) => blocker.code === "PRODUCT_IDENTITY_INVALID",
    ),
    false,
  );
});

test("an empty bundle flag with a mismatched BOM quantity remains invalid", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        units_in_listing: 4,
        is_bundle: true,
        components: [],
      }),
    }],
    components: [component({ qty: 3 })],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components.length, 0);
  assert.ok(
    plan.scopes[0].blockers.some(
      (blocker) => blocker.code === "PRODUCT_IDENTITY_INVALID",
    ),
  );
});

test("historical exact flag cannot admit Hot target matched to Maple donor", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Jimmy Dean",
        product_line: "Premium Pork Sausage",
        flavor: "Hot",
        size: "16 oz",
        container_type: "Roll",
      }),
    }],
    components: [component({
      product: "Jimmy Dean Premium Pork Sausage",
      flavor: "Hot",
      size: "16 oz",
      costMethod: "exact",
    })],
    donors: [donor({
      brand: "Jimmy Dean",
      size: "16 oz",
      title: "Jimmy Dean Premium Pork Sausage Maple Roll 16 oz",
    })],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "REJECT");
  assert.ok(plan.scopes[0].components[0].matcherReasonCodes.includes("TITLE_TARGET_TOKEN_MISSING"));
});

test("historical exact flag cannot admit Patties target matched to Links donor", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Jimmy Dean",
        product_line: "Fully Cooked Pork Sausage",
        flavor: "Patties",
        size: "8 count",
        container_type: "Bag",
      }),
    }],
    donors: [donor({
      brand: "Jimmy Dean",
      size: "8 count",
      title: "Jimmy Dean Fully Cooked Pork Sausage Links Bag 8 Count",
    })],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].components[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "REJECT");
});

test("a unique strict exact catalog donor repairs a stale neighboring-variant link", () => {
  const value = snapshot({
    components: [component({ donorProductId: "stale-donor" })],
    donors: [
      donor({
        id: "stale-donor",
        upc: null,
        title: "Acme Crunch Chips Maple Bag 8 oz",
      }),
      donor({
        id: "exact-donor",
        upc: null,
        title: "Acme Crunch Chips Barbecue Bag 8 oz",
      }),
    ],
    offers: [offer({
      id: "exact-offer",
      donorProductId: "exact-donor",
    })],
  });
  const result = compile(value).scopes[0].components[0];
  assert.equal(result.disposition, "EXACT_IDENTITY_ONLY_CANDIDATE");
  assert.equal(result.identityProof, "STRICT_TITLE_MATCH");
  assert.equal(result.matcherVerdict, "EXACT_IDENTITY");
  assert.equal(result.donorProductId, "exact-donor");
  assert.equal(result.legacyDonorProductId, "stale-donor");
  assert.equal(result.donorOfferId, "exact-offer");
});

test("multiple strict exact catalog donors remain quarantined", () => {
  const value = snapshot({
    components: [component({ donorProductId: "stale-donor" })],
    donors: [
      donor({
        id: "stale-donor",
        upc: null,
        title: "Acme Crunch Chips Maple Bag 8 oz",
      }),
      donor({
        id: "exact-donor-a",
        upc: null,
        title: "Acme Crunch Chips Barbecue Bag 8 oz",
      }),
      donor({
        id: "exact-donor-b",
        upc: null,
        title: "Acme Crunch Chips Barbecue Bag 8 oz",
      }),
    ],
    offers: [],
  });
  const result = compile(value).scopes[0].components[0];
  assert.equal(result.disposition, "QUARANTINE");
  assert.ok(result.blockers.some(
    (blocker) => blocker.code === "DONOR_TITLE_MATCH_AMBIGUOUS",
  ));
});

test("a unique strict exact donor with a conflicting canonical binding is not rematched", () => {
  const targetVariantId =
    compile(snapshot()).scopes[0].components[0].targetVariant?.canonicalVariantId;
  assert.ok(targetVariantId);
  const value = snapshot({
    components: [component({ donorProductId: "stale-donor" })],
    donors: [
      donor({
        id: "stale-donor",
        upc: null,
        title: "Acme Crunch Chips Maple Bag 8 oz",
      }),
      donor({
        id: "bound-donor",
        upc: null,
        title: "Acme Crunch Chips Barbecue Bag 8 oz",
      }),
    ],
    offers: [],
    canonicalDonorBindings: [{
      donorProductId: "bound-donor",
      canonicalVariantId: `cpv1:${"f".repeat(64)}`,
      decisionId: "decision-conflict",
      decisionStatus: "exact_confirmed",
      decidedAt: "2026-07-26T11:30:00.000Z",
    }],
  });
  const result = compile(value).scopes[0].components[0];
  assert.notEqual(targetVariantId, `cpv1:${"f".repeat(64)}`);
  assert.equal(result.disposition, "QUARANTINE");
  assert.equal(result.donorProductId, "stale-donor");
  assert.equal(result.matcherVerdict, "REJECT");
});

test("conflicting legacy donor links are not overridden by a catalog rematch", () => {
  const value = snapshot({
    components: [component({
      donorProductId: "stale-donor",
      contentDonorProductId: "exact-donor",
    })],
    donors: [
      donor({
        id: "stale-donor",
        upc: null,
        title: "Acme Crunch Chips Maple Bag 8 oz",
      }),
      donor({
        id: "exact-donor",
        upc: null,
        title: "Acme Crunch Chips Barbecue Bag 8 oz",
      }),
    ],
    offers: [offer({ donorProductId: "exact-donor" })],
  });
  const result = compile(value).scopes[0].components[0];
  assert.equal(result.disposition, "QUARANTINE");
  assert.equal(result.identityProof, "NONE");
  assert.ok(result.blockers.some(
    (blocker) => blocker.code === "LEGACY_DONOR_LINK_CONFLICT",
  ));
});

test("cross-size donor is price-only and never content truth", () => {
  const value = snapshot({
    donors: [donor({
      size: "16 oz",
      title: "Acme Crunch Chips Barbecue Bag 16 oz",
    })],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components[0].disposition, "PRICE_ONLY_ESTIMATE");
  assert.equal(plan.scopes[0].components[0].matcherVerdict, "CROSS_SIZE_ESTIMATE");
  assert.equal(plan.scopes[0].components[0].donorOfferId, null);
});

test("valid exact manufacturer UPC repairs a stale donor link without title guessing", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      listingUpc: "036000291452",
      listingUpcSource: "walmart_item",
    }],
    components: [component({ donorProductId: "wrong-donor" })],
    donors: [
      donor({
        id: "wrong-donor",
        upc: null,
        title: "Acme Crunch Chips Maple Bag 8 oz",
      }),
      donor({
        id: "gtin-donor",
        upc: "036000291452",
        title: "Legacy title with noisy retailer copy",
      }),
    ],
    offers: [offer({ donorProductId: "gtin-donor" })],
  });
  const plan = compile(value);
  const result = plan.scopes[0].components[0];
  assert.equal(result.identityProof, "EXACT_GTIN");
  assert.equal(result.donorProductId, "gtin-donor");
  assert.equal(result.legacyDonorProductId, "wrong-donor");
  assert.equal(result.disposition, "EXACT_CONTENT_AND_PRICE_CANDIDATE");
});

test("invalid UPC cannot bypass the strict matcher", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      listingUpc: "036000291453",
      listingUpcSource: "walmart_item",
    }],
    donors: [donor({
      upc: "036000291453",
      title: "Acme Crunch Chips Maple Bag 8 oz",
    })],
  });
  const result = compile(value).scopes[0].components[0];
  assert.equal(result.identityProof, "NONE");
  assert.equal(result.disposition, "QUARANTINE");
});

test("an outer marketplace UPC cannot prove a multipack base-unit donor", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      listingUpc: "036000291452",
      listingUpcSource: "walmart_item",
      productIdentityJson: identity({
        units_in_listing: 4,
        flavor: "Maple",
      }),
    }],
    components: [component({ qty: 4, flavor: "Maple" })],
    donors: [donor({
      upc: "036000291452",
      title: "Acme Crunch Chips Barbecue Bag 8 oz",
    })],
  });
  const result = compile(value).scopes[0].components[0];
  assert.equal(result.qty, 4);
  assert.equal(result.identityProof, "NONE");
  assert.equal(result.disposition, "QUARANTINE");
  assert.equal(result.matcherVerdict, "REJECT");
});

test("missing product identity and orphan donor fail closed", () => {
  const missing = snapshot({
    listings: [{ ...snapshot().listings[0], productIdentityJson: null }],
  });
  assert.deepEqual(
    compile(missing).scopes[0].blockers.map((item) => item.code),
    ["PRODUCT_IDENTITY_MISSING"],
  );

  const orphan = snapshot({ donors: [] });
  assert.equal(compile(orphan).scopes[0].components[0].blockers[0].code, "LEGACY_DONOR_ORPHANED");
});

test("bundle component brand must be explicit in the preserved identity", () => {
  const value = snapshot({
    listings: [{
      ...snapshot().listings[0],
      productIdentityJson: identity({
        brand: "Our Bundle",
        product_line: "Snack Box",
        is_bundle: true,
        components: [{
          product: "Crunch Chips",
          flavor: "Barbecue",
          size: "8 oz",
          qty: 2,
        }],
      }),
    }],
  });
  const plan = compile(value);
  assert.equal(plan.scopes[0].components[0].disposition, "QUARANTINE");
  assert.ok(
    plan.scopes[0].components[0].blockers.some(
      (item) => item.code === "BUNDLE_COMPONENT_BRAND_UNPROVEN",
    ),
  );
});

test("regional and club offers are not silently promoted", () => {
  const regional = snapshot({
    offers: [offer({ retailer: "publix", zip: "00000" })],
  });
  assert.equal(
    compile(regional).scopes[0].components[0].disposition,
    "EXACT_CONTENT_ONLY_CANDIDATE",
  );
  const club = snapshot({
    offers: [offer({ retailer: "costco" })],
  });
  assert.equal(
    compile(club).scopes[0].components[0].disposition,
    "EXACT_IDENTITY_ONLY_CANDIDATE",
  );
});

test("current exact content evidence is classified as already canonical", () => {
  const base = snapshot();
  const targetVariantId = compile(base).scopes[0].components[0].targetVariant?.canonicalVariantId;
  assert.ok(targetVariantId);
  const plan = compile(snapshot({
    canonicalDonorBindings: [{
      donorProductId: "donor-1",
      canonicalVariantId: targetVariantId,
      decisionId: "decision-1",
      decisionStatus: "exact_confirmed",
      decidedAt: "2026-07-26T11:30:00.000Z",
    }],
    canonicalListingComponents: [{
      listingKey: "ptls1:test",
      skuCostId: "cost-1",
      componentIndex: 0,
      evidenceStatus: "REJECT",
      targetCanonicalVariantId: targetVariantId,
      contentCanonicalVariantId: targetVariantId,
      contentObservationId: "content-1",
      observedContentCanonicalVariantId: targetVariantId,
      decisionStatus: "exact_confirmed",
      decisionCanonicalVariantId: targetVariantId,
    }],
  }));
  assert.equal(plan.scopes[0].disposition, "ALREADY_CANONICAL");
  assert.equal(plan.scopes[0].writeEligible, false);
  assert.equal(plan.scopes[0].components[0].disposition, "ALREADY_CANONICAL");
  assert.equal(plan.counts.alreadyCanonicalListings, 1);
  assert.equal(plan.counts.alreadyCanonicalComponents, 1);
  assert.equal(plan.counts.exactCanonicalizationCandidates, 0);
});

test("current exact listing recipe remains canonical without content evidence", () => {
  const base = snapshot();
  const targetVariantId =
    compile(base).scopes[0].components[0].targetVariant?.canonicalVariantId;
  assert.ok(targetVariantId);
  const plan = compile(snapshot({
    canonicalDonorBindings: [{
      donorProductId: "donor-1",
      canonicalVariantId: targetVariantId,
      decisionId: "decision-identity-only",
      decisionStatus: "exact_confirmed",
      decidedAt: "2026-07-26T11:30:00.000Z",
    }],
    canonicalListingComponents: [{
      listingKey: "ptls1:test",
      skuCostId: "cost-identity-only",
      componentIndex: 0,
      evidenceStatus: "REJECT",
      targetCanonicalVariantId: targetVariantId,
      contentCanonicalVariantId: null,
      contentObservationId: null,
      observedContentCanonicalVariantId: null,
      decisionId: "decision-identity-only",
      decisionStatus: "exact_confirmed",
      decisionCanonicalVariantId: targetVariantId,
      recipeTargetCanonicalVariantId: targetVariantId,
      recipeDonorProductId: "donor-1",
      recipeVariantDecisionId: "decision-identity-only",
      recipeComponentEvidenceHash: null,
      recipeComponentEvidenceJson: null,
    }],
  }));
  assert.equal(plan.scopes[0].disposition, "ALREADY_CANONICAL");
  assert.equal(plan.scopes[0].writeEligible, false);
  assert.equal(plan.scopes[0].components[0].disposition, "ALREADY_CANONICAL");
  assert.equal(plan.counts.alreadyCanonicalListings, 1);
});

test("canonical audit keeps the current recipe when a later FACT cost has independent provenance", async () => {
  const db = createClient({ url: ":memory:" });
  const manifestSha256 = "1".repeat(64);
  const capturedAt = "2026-07-29T09:40:00.000Z";
  const variantId = `cpv1:${"2".repeat(64)}`;
  try {
    await db.batch([
      `CREATE TABLE ProductTruthListingScope (
        listingKey TEXT PRIMARY KEY,
        manifestSha256 TEXT NOT NULL
      )`,
      `CREATE TABLE SkuCostListingScopeLink (
        listingKey TEXT NOT NULL,
        skuCostId TEXT NOT NULL
      )`,
      `CREATE TABLE SkuCost (
        id TEXT PRIMARY KEY,
        recipeHash TEXT,
        runId TEXT,
        approvalId TEXT,
        effectiveDate TEXT,
        createdAt TEXT,
        source TEXT
      )`,
      `CREATE TABLE SkuComponentEvidence (
        id TEXT PRIMARY KEY,
        skuCostId TEXT NOT NULL,
        componentIndex INTEGER NOT NULL,
        evidenceStatus TEXT NOT NULL,
        targetCanonicalVariantId TEXT NOT NULL,
        contentCanonicalVariantId TEXT,
        contentObservationId TEXT
      )`,
      `CREATE TABLE ProductContentObservation (
        id TEXT PRIMARY KEY,
        canonicalVariantId TEXT NOT NULL,
        variantDecisionId TEXT NOT NULL
      )`,
      `CREATE TABLE ProductTruthListingRecipe (
        id TEXT PRIMARY KEY,
        listingKey TEXT NOT NULL,
        recipeHash TEXT NOT NULL,
        manifestSha256 TEXT NOT NULL,
        runId TEXT,
        approvalId TEXT,
        effectiveAt TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )`,
      `CREATE TABLE ProductTruthListingRecipeComponent (
        listingRecipeId TEXT NOT NULL,
        componentIndex INTEGER NOT NULL,
        targetCanonicalVariantId TEXT NOT NULL,
        donorProductId TEXT NOT NULL,
        variantDecisionId TEXT NOT NULL,
        evidenceHash TEXT NOT NULL,
        evidenceJson TEXT NOT NULL
      )`,
      `CREATE TABLE DonorProductVariantDecision (
        id TEXT PRIMARY KEY,
        decisionStatus TEXT NOT NULL,
        canonicalVariantId TEXT NOT NULL
      )`,
    ], "write");
    await db.batch([
      {
        sql: `INSERT INTO ProductTruthListingScope
              (listingKey,manifestSha256) VALUES (?,?)`,
        args: ["walmart:1:SKU-FACT", manifestSha256],
      },
      {
        sql: `INSERT INTO ProductTruthListingRecipe
              (id,listingKey,recipeHash,manifestSha256,runId,approvalId,effectiveAt,createdAt)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [
          "recipe-1",
          "walmart:1:SKU-FACT",
          "recipe-hash",
          manifestSha256,
          "identity-run",
          "identity-approval",
          "2026-07-29T08:00:00.000Z",
          "2026-07-29T08:00:00.000Z",
        ],
      },
      {
        sql: `INSERT INTO ProductTruthListingRecipeComponent
              (listingRecipeId,componentIndex,targetCanonicalVariantId,
               donorProductId,variantDecisionId,evidenceHash,evidenceJson)
              VALUES (?,?,?,?,?,?,?)`,
        args: [
          "recipe-1",
          0,
          variantId,
          "donor-1",
          "decision-1",
          "evidence-hash",
          "{}",
        ],
      },
      {
        sql: `INSERT INTO DonorProductVariantDecision
              (id,decisionStatus,canonicalVariantId) VALUES (?,?,?)`,
        args: ["decision-1", "exact_confirmed", variantId],
      },
      {
        sql: `INSERT INTO SkuCost
              (id,recipeHash,runId,approvalId,effectiveDate,createdAt,source)
              VALUES (?,?,?,?,?,?,?)`,
        args: [
          "fact-cost",
          "recipe-hash",
          null,
          null,
          "2026-07-29T09:28:01.000Z",
          "2026-07-29T09:28:01.000Z",
          "retail:batch",
        ],
      },
      {
        sql: `INSERT INTO SkuCostListingScopeLink
              (listingKey,skuCostId) VALUES (?,?)`,
        args: ["walmart:1:SKU-FACT", "fact-cost"],
      },
      {
        sql: `INSERT INTO SkuComponentEvidence
              (id,skuCostId,componentIndex,evidenceStatus,
               targetCanonicalVariantId,contentCanonicalVariantId,contentObservationId)
              VALUES (?,?,?,?,?,?,?)`,
        args: [
          "fact-evidence",
          "fact-cost",
          0,
          "FACT",
          variantId,
          null,
          null,
        ],
      },
    ], "write");

    const rows = await readCanonicalListingComponents(
      db,
      manifestSha256,
      capturedAt,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].skuCostId, "fact-cost");
    assert.equal(rows[0].evidenceStatus, "FACT");
    assert.equal(rows[0].recipeTargetCanonicalVariantId, variantId);
    assert.equal(rows[0].recipeVariantDecisionId, "decision-1");
    assert.equal(rows[0].decisionStatus, "exact_confirmed");
    assert.equal(rows[0].decisionCanonicalVariantId, variantId);
  } finally {
    db.close();
  }
});

test("field-partition reconciliation remains canonical on the next audit", () => {
  const base = snapshot();
  const originalComponent = compile(base).scopes[0].components[0];
  assert.ok(originalComponent.targetIdentity);
  assert.ok(originalComponent.targetVariant);
  const canonicalIdentity = {
    brand: "Acme",
    productLine: "Crunch Chips Barbecue",
    flavor: null,
    form: "Bag",
    size: "8 oz",
    outerPackCount: 1,
  };
  const canonical = buildCanonicalProductVariantKey(canonicalIdentity);
  const canonicalVariant = {
    canonicalVariantId: canonical.canonicalVariantId,
    variantKey: canonical.variantKey,
    identityHash: canonical.identityHash,
    keyVersion: canonical.keyVersion,
    identityJson: canonical.identityJson,
  };
  const physicalIdentity = {
    brand: canonical.normalized.brand,
    identityTokens: ["barbecue", "chips", "crunch"],
    modifiers: [],
    form: canonical.normalized.form,
    size: canonical.normalized.size,
    outerPackCount: canonical.normalized.outerPackCount,
  };
  const sourceTargets = [
    {
      listingKey: "ptls1:canonical",
      originalCanonicalVariantId: canonical.canonicalVariantId,
      originalTargetIdentitySha256:
        productTruthOperationalSha256(canonicalIdentity),
      overlappingProductFlavorTokens: 0,
    },
    {
      listingKey: "ptls1:test",
      originalCanonicalVariantId:
        originalComponent.targetVariant.canonicalVariantId,
      originalTargetIdentitySha256:
        productTruthOperationalSha256(originalComponent.targetIdentity),
      overlappingProductFlavorTokens: 0,
    },
  ];
  const reconciliation = {
    schemaVersion:
      "product-truth-legacy-bridge-field-partition-reconciliation/1.0.0",
    mode: "LEXICALLY_EQUIVALENT_DONOR_GRAPH",
    donorProductId: "donor-1",
    canonicalListingKey: "ptls1:canonical",
    canonicalTargetIdentity: canonicalIdentity,
    canonicalTargetVariant: canonicalVariant,
    physicalIdentitySha256:
      productTruthOperationalSha256(physicalIdentity),
    sourceTargets,
    sourceTargetsSha256: productTruthOperationalSha256(sourceTargets),
  };
  const sourceEvidence = {
    schemaVersion:
      "product-truth-legacy-bridge-recipe-component-source/1.0.0",
    identityProof: "STRICT_TITLE_MATCH",
    matcherReasonCodes: [
      "IDENTITY_EXACT",
      "SIZE_EXACT",
      "TITLE_FALLBACK_IDENTITY_PROVEN",
    ],
    sourceSnapshotSha256: "1".repeat(64),
    bridgePlanSha256: "2".repeat(64),
    sourceBinding: {},
    identityReconciliation: reconciliation,
  };
  const componentEvidence = {
    schemaVersion:
      "product-truth-listing-recipe-component-evidence/1.0.0",
    listingKey: "ptls1:test",
    componentIndex: 0,
    quantity: 1,
    product: "Acme Crunch Chips",
    flavor: "Barbecue",
    size: "8 oz",
    targetCanonicalVariantId: canonical.canonicalVariantId,
    donorProductId: "donor-1",
    variantDecisionId: "decision-1",
    sourceComponentId: "component-1",
    sourceEvidenceSha256: productTruthOperationalSha256(sourceEvidence),
    sourceEvidence,
  };
  const recipeComponentEvidenceJson =
    renderProductTruthOperationalJson(componentEvidence);
  const canonicalRow = {
    listingKey: "ptls1:test",
    skuCostId: "cost-1",
    componentIndex: 0,
    evidenceStatus: "REJECT",
    targetCanonicalVariantId: canonical.canonicalVariantId,
    contentCanonicalVariantId: canonical.canonicalVariantId,
    contentObservationId: "content-1",
    observedContentCanonicalVariantId: canonical.canonicalVariantId,
    decisionId: "decision-1",
    decisionStatus: "exact_confirmed",
    decisionCanonicalVariantId: canonical.canonicalVariantId,
    recipeTargetCanonicalVariantId: canonical.canonicalVariantId,
    recipeDonorProductId: "donor-1",
    recipeVariantDecisionId: "decision-1",
    recipeComponentEvidenceHash:
      productTruthOperationalSha256(componentEvidence),
    recipeComponentEvidenceJson,
  };
  const reconciled = compile(snapshot({
    canonicalDonorBindings: [{
      donorProductId: "donor-1",
      canonicalVariantId: canonical.canonicalVariantId,
      decisionId: "decision-1",
      decisionStatus: "exact_confirmed",
      decidedAt: "2026-07-26T11:30:00.000Z",
    }],
    canonicalListingComponents: [canonicalRow],
  }));
  assert.equal(reconciled.scopes[0].disposition, "ALREADY_CANONICAL");
  assert.equal(reconciled.scopes[0].components[0].disposition, "ALREADY_CANONICAL");
  assert.equal(reconciled.scopes[0].blockers.length, 0);

  const tampered = compile(snapshot({
    canonicalDonorBindings: [{
      donorProductId: "donor-1",
      canonicalVariantId: canonical.canonicalVariantId,
      decisionId: "decision-1",
      decisionStatus: "exact_confirmed",
      decidedAt: "2026-07-26T11:30:00.000Z",
    }],
    canonicalListingComponents: [{
      ...canonicalRow,
      recipeComponentEvidenceHash: "0".repeat(64),
    }],
  }));
  assert.equal(tampered.scopes[0].disposition, "QUARANTINE");
  assert.ok(tampered.scopes[0].blockers.some(
    (item) => item.code === "CANONICAL_LISTING_STATE_INVALID",
  ));
});

test("form/product field partition reuses an exact donor decision and remains canonical", () => {
  const base = snapshot({
    donors: [donor({ identityStatus: "exact_confirmed" })],
  });
  const originalComponent = compile(base).scopes[0].components[0];
  assert.ok(originalComponent.targetIdentity);
  assert.ok(originalComponent.targetVariant);
  const canonicalIdentity = {
    brand: "Acme",
    productLine: "Bag Crunch Chips Barbecue",
    flavor: null,
    form: null,
    size: "8 oz",
    outerPackCount: 1,
  };
  const canonical = buildCanonicalProductVariantKey(canonicalIdentity);
  const decisionId = "decision-form-partition";
  const binding = {
    donorProductId: "donor-1",
    canonicalVariantId: canonical.canonicalVariantId,
    canonicalIdentityJson: canonical.identityJson,
    decisionId,
    decisionStatus: "exact_confirmed",
    decidedAt: "2026-07-26T11:30:00.000Z",
  };
  const candidate = compile(snapshot({
    donors: [donor({ identityStatus: "exact_confirmed" })],
    canonicalDonorBindings: [binding],
  }));
  assert.equal(
    candidate.scopes[0].disposition,
    "EXACT_CANONICALIZATION_CANDIDATE",
  );
  assert.equal(candidate.scopes[0].writeEligible, true);

  const canonicalVariant = {
    canonicalVariantId: canonical.canonicalVariantId,
    variantKey: canonical.variantKey,
    identityHash: canonical.identityHash,
    keyVersion: canonical.keyVersion,
    identityJson: canonical.identityJson,
  };
  const sourceTargets = [{
    listingKey: "ptls1:test",
    originalCanonicalVariantId:
      originalComponent.targetVariant.canonicalVariantId,
    originalTargetIdentitySha256:
      productTruthOperationalSha256(originalComponent.targetIdentity),
    overlappingProductFlavorTokens: 0,
  }];
  const reconciliation = {
    schemaVersion:
      "product-truth-legacy-bridge-field-partition-reconciliation/2.0.0",
    mode: "LEXICALLY_EQUIVALENT_DONOR_GRAPH",
    donorProductId: "donor-1",
    canonicalListingKey: "ptls1:test",
    canonicalDecisionId: decisionId,
    canonicalTargetIdentity: canonicalIdentity,
    canonicalTargetVariant: canonicalVariant,
    physicalIdentitySha256: productTruthOperationalSha256({
      brand: canonical.normalized.brand,
      identityTokens: ["bag", "barbecue", "chips", "crunch"],
      modifiers: [],
      size: canonical.normalized.size,
      outerPackCount: canonical.normalized.outerPackCount,
    }),
    sourceTargets,
    sourceTargetsSha256: productTruthOperationalSha256(sourceTargets),
  };
  const sourceEvidence = {
    schemaVersion:
      "product-truth-legacy-bridge-recipe-component-source/1.0.0",
    identityProof: "STRICT_TITLE_MATCH",
    matcherReasonCodes: [
      "IDENTITY_EXACT",
      "SIZE_EXACT",
      "TITLE_FALLBACK_IDENTITY_PROVEN",
    ],
    sourceSnapshotSha256: "1".repeat(64),
    bridgePlanSha256: "2".repeat(64),
    sourceBinding: {},
    identityReconciliation: reconciliation,
    supersedesInvalidCanonicalCostIds: [],
  };
  const componentEvidence = {
    schemaVersion:
      "product-truth-listing-recipe-component-evidence/1.0.0",
    listingKey: "ptls1:test",
    componentIndex: 0,
    quantity: 1,
    product: "Crunch Chips",
    flavor: "Barbecue",
    size: "8 oz",
    targetCanonicalVariantId: canonical.canonicalVariantId,
    donorProductId: "donor-1",
    variantDecisionId: decisionId,
    sourceComponentId: "component-1",
    sourceEvidenceSha256: productTruthOperationalSha256(sourceEvidence),
    sourceEvidence,
  };
  const evidenceJson = renderProductTruthOperationalJson(componentEvidence);
  const reconciled = compile(snapshot({
    donors: [donor({ identityStatus: "exact_confirmed" })],
    canonicalDonorBindings: [binding],
    canonicalListingComponents: [{
      listingKey: "ptls1:test",
      skuCostId: "cost-form-partition",
      componentIndex: 0,
      evidenceStatus: "REJECT",
      targetCanonicalVariantId: canonical.canonicalVariantId,
      contentCanonicalVariantId: canonical.canonicalVariantId,
      contentObservationId: "content-form-partition",
      observedContentCanonicalVariantId: canonical.canonicalVariantId,
      decisionId,
      decisionStatus: "exact_confirmed",
      decisionCanonicalVariantId: canonical.canonicalVariantId,
      recipeTargetCanonicalVariantId: canonical.canonicalVariantId,
      recipeDonorProductId: "donor-1",
      recipeVariantDecisionId: decisionId,
      recipeComponentEvidenceHash:
        productTruthOperationalSha256(componentEvidence),
      recipeComponentEvidenceJson: evidenceJson,
    }],
  }));
  assert.equal(reconciled.scopes[0].disposition, "ALREADY_CANONICAL");
  assert.equal(reconciled.scopes[0].writeEligible, false);
});

test("an exact donor already bound to another variant fails closed", () => {
  const conflictingVariantId = `cpv1:${"f".repeat(64)}`;
  const plan = compile(snapshot({
    canonicalDonorBindings: [{
      donorProductId: "donor-1",
      canonicalVariantId: conflictingVariantId,
      decisionId: "decision-conflict",
      decisionStatus: "exact_confirmed",
      decidedAt: "2026-07-26T11:30:00.000Z",
    }],
  }));
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.ok(plan.scopes[0].components[0].blockers.some(
    (item) => item.code === "CANONICAL_DONOR_VARIANT_CONFLICT",
  ));
});

test("partial or mismatched current canonical evidence fails closed", () => {
  const targetVariantId = compile(snapshot()).scopes[0].components[0].targetVariant?.canonicalVariantId;
  assert.ok(targetVariantId);
  const plan = compile(snapshot({
    canonicalListingComponents: [{
      listingKey: "ptls1:test",
      skuCostId: "cost-1",
      componentIndex: 0,
      evidenceStatus: "REJECT",
      targetCanonicalVariantId: targetVariantId,
      contentCanonicalVariantId: targetVariantId,
      contentObservationId: "content-1",
      observedContentCanonicalVariantId: targetVariantId,
      decisionStatus: "rejected",
      decisionCanonicalVariantId: targetVariantId,
    }],
  }));
  assert.equal(plan.scopes[0].disposition, "QUARANTINE");
  assert.equal(plan.scopes[0].components[0].disposition, "QUARANTINE");
  assert.ok(plan.scopes[0].blockers.some(
    (item) => item.code === "CANONICAL_LISTING_STATE_INVALID",
  ));
});

test("canonical snapshot binding and plan bytes are deterministic", () => {
  const value = snapshot();
  const first = compile(value);
  const second = compile(value);
  assert.equal(renderProductTruthLegacyBridgePlan(first), renderProductTruthLegacyBridgePlan(second));

  const snapshotJson = renderProductTruthLegacyBridgeSnapshot(value);
  assert.throws(
    () => compileProductTruthLegacyBridgePlan({
      snapshot: value,
      snapshotJson,
      snapshotSha256: "0".repeat(64),
      generatedAt: "2026-07-26T13:00:00.000Z",
    }),
    /LEGACY_BRIDGE_SNAPSHOT_SHA256_MISMATCH/,
  );
});
