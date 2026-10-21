import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findShippedPackage,
  pickShippedPackage,
  type ShippedPackageRow,
} from "../package-history";

const TITLE = "Salutem Vita – Multi-Grain English Muffins, 6 Count, 12 oz, Gift Set – Pack of 2";
const row = (o: Partial<ShippedPackageRow>): ShippedPackageRow => ({
  sku: "SKU-A",
  product: TITLE,
  qty: 1,
  weight: 4,
  boxSize: "11x6x8",
  orderNumber: "111-0000000-0000001",
  createdAt: new Date("2026-09-02T12:00:00Z"),
  ...o,
});

test("same SKU + qty shipped before → its package", () => {
  const got = pickShippedPackage([row({})], { sku: "SKU-A", product: TITLE, qty: 1 });
  assert.deepEqual(got, {
    weight: 4,
    boxSize: "11x6x8",
    matchedBy: "sku",
    fromOrder: "111-0000000-0000001",
  });
});

test("same listing title under ANOTHER SKU → its package (the English Muffins case)", () => {
  const got = pickShippedPackage([row({ sku: "1C3Y-BRWN-ZXZH" })], {
    sku: "743269734452",
    product: TITLE,
    qty: 1,
  });
  assert.equal(got?.matchedBy, "product");
  assert.equal(got?.weight, 4);
});

test("SKU match beats a newer title match; newest wins within a tier", () => {
  const rows = [
    row({ sku: "OTHER", weight: 9, createdAt: new Date("2026-10-10") }),
    row({ weight: 5, createdAt: new Date("2026-09-01") }),
    row({ weight: 6, createdAt: new Date("2026-09-20") }),
  ];
  const got = pickShippedPackage(rows, { sku: "SKU-A", product: TITLE, qty: 1 });
  assert.equal(got?.matchedBy, "sku");
  assert.equal(got?.weight, 6);
});

test("different quantity never matches (2 boxes ≠ 1 box)", () => {
  assert.equal(
    pickShippedPackage([row({ qty: 1 })], { sku: "SKU-A", product: TITLE, qty: 2 }),
    null,
  );
});

test("unusable rows are skipped: no weight, zero weight, unparseable box", () => {
  const rows = [
    row({ weight: null }),
    row({ weight: 0 }),
    row({ boxSize: "big-ish" }),
  ];
  assert.equal(pickShippedPackage(rows, { sku: "SKU-A", product: TITLE, qty: 1 }), null);
});

test("short generic titles are not used to match", () => {
  const got = pickShippedPackage([row({ sku: "X", product: "Gift Set" })], {
    sku: "Y",
    product: "Gift Set",
    qty: 1,
  });
  assert.equal(got, null);
});

test("findShippedPackage queries bought rows by SKU/title and qty", async () => {
  let seen: Record<string, unknown> | null = null;
  const db = {
    shippingPlanItem: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        seen = args.where;
        return [row({})];
      },
    },
  };
  const got = await findShippedPackage(db, { sku: "SKU-A", product: TITLE, qty: 1 });
  assert.equal(got?.weight, 4);
  assert.equal(seen!.status, "bought");
  assert.equal(seen!.qty, 1);
  assert.deepEqual(seen!.OR, [{ sku: "SKU-A" }, { product: TITLE }]);
});

test("nothing to match on → no query, null", async () => {
  const db = {
    shippingPlanItem: {
      findMany: async () => {
        throw new Error("must not query");
      },
    },
  };
  assert.equal(await findShippedPackage(db, { sku: "", product: "short", qty: 1 }), null);
});
