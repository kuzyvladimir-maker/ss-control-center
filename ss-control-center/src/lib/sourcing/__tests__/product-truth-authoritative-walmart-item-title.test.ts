import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseProductTruthAuthoritativeWalmartOuterPackTitle,
} from "../product-truth-authoritative-walmart-item-title";

test("authoritative Walmart parser removes only explicit outer-pack syntax", () => {
  assert.deepEqual(
    parseProductTruthAuthoritativeWalmartOuterPackTitle(
      "Acme Hot Tomato Soup, 12 oz (Pack of 4)",
    ),
    {
      status: "PARSED",
      count: 4,
      baseTokens: ["acme", "hot", "tomato", "soup", "12", "oz"],
      normalizedBaseTokens: ["12", "acme", "hot", "oz", "soup", "tomato"],
    },
  );
  assert.deepEqual(
    parseProductTruthAuthoritativeWalmartOuterPackTitle(
      "Acme Snack Cakes, 12 ct",
    ),
    {
      status: "NONE",
      count: null,
      baseTokens: ["acme", "snack", "cakes", "12", "ct"],
      normalizedBaseTokens: ["12", "acme", "cakes", "ct", "snack"],
    },
  );
});

test("authoritative Walmart parser rejects contradictory outer-pack counts", () => {
  assert.equal(
    parseProductTruthAuthoritativeWalmartOuterPackTitle(
      "2 Pack Acme Soup, Pack of 3",
    ).status,
    "AMBIGUOUS",
  );
});
