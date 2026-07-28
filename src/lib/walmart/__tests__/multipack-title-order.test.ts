import assert from "node:assert/strict";
import test from "node:test";

import {
  hasFrontLoadedPackCount,
  validateListingContent,
} from "../multipack/guidelines";
import { buildMultipackListing } from "../multipack/content";

const CURRENT_FAISALX_1183_TITLE =
  "Pepperidge Farm Butter Hot Dog Buns, Top Sliced, 8-Ct Bag (Pack of 6)";

test("standard grocery title keeps exact product identity before Pack Count", () => {
  assert.equal(hasFrontLoadedPackCount(CURRENT_FAISALX_1183_TITLE), false);

  const gaps = validateListingContent({
    title: CURRENT_FAISALX_1183_TITLE,
    keyFeatures: [
      "Made with real butter",
      "Top sliced hot dog buns",
      "Six 14 oz bags with 8 buns per bag",
    ],
    description: "x".repeat(700),
    imageCount: 6,
  });

  assert.equal(
    gaps.some((gap) => gap.field === "title" && gap.issue.includes("front-loaded")),
    false,
  );
});

test("variant numbers and a legitimate hamburger-bun identity are not treated as Pack Count", () => {
  const numericVariantTitle =
    "Pepperidge Farm Whole Grain Thin Sliced 15 Grain Bread, 22 oz (Pack of 2)";
  const legitimateHamburgerTitle =
    "Sara Lee Artesano White Bakery Buns, 8 count, Soft Hamburger Buns, 19 oz Bag (Pack of 2)";

  assert.equal(hasFrontLoadedPackCount(numericVariantTitle), false);
  assert.equal(hasFrontLoadedPackCount(legitimateHamburgerTitle), false);
});

test("validator flags Pack of N at the beginning of a standard grocery title", () => {
  const gaps = validateListingContent({
    title: "Pack of 6 Pepperidge Farm Butter Hot Dog Buns, Top Sliced, 14 oz",
    keyFeatures: [
      "Made with real butter",
      "Top sliced hot dog buns",
      "Six 14 oz bags with 8 buns per bag",
    ],
    description: "x".repeat(700),
    imageCount: 6,
  });

  assert.ok(
    gaps.some((gap) => (
      gap.field === "title"
      && gap.severity === "med"
      && gap.issue.includes("lead with brand and exact product identity")
    )),
  );
});

test("multipack builder appends count after the product identity", () => {
  const content = buildMultipackListing(
    "Pepperidge Farm Butter Hot Dog Buns, Top Sliced, 14 oz",
    6,
    { noun: "bags" },
  );

  assert.match(content.title, /^Pepperidge Farm Butter Hot Dog Buns/);
  assert.match(content.title, /6-Pack \(6 bags\)$/);
  assert.equal(hasFrontLoadedPackCount(content.title), false);
});
