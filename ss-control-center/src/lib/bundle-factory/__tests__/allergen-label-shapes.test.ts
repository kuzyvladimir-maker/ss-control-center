import assert from "node:assert/strict";
import test from "node:test";

import {
  allergenDeclarationFromLabel,
  allergenDeclarationIsEmpty,
} from "../allergen-declaration";
import { describeBundleFactoryFailure } from "../api-error-text";

test("a declaration is read from whichever shape the donor published", () => {
  // Printed sentence.
  assert.deepEqual(
    allergenDeclarationFromLabel("Contains: Wheat, Milk, Soy."),
    { contains: ["Wheat", "Milk", "Soy"], may_contain: [] },
  );
  // Structured list — this is the shape that silently produced an EMPTY
  // declaration when fed to the text-only parser, which then blocked
  // promotion with "no verified manufacturer allergen declaration" while the
  // allergens sat right there in the snapshot.
  assert.deepEqual(
    allergenDeclarationFromLabel(["celery", "fish", "gluten", "Milk", "milk"]),
    { contains: ["celery", "fish", "gluten", "Milk"], may_contain: [] },
  );
  // Already parsed.
  assert.deepEqual(
    allergenDeclarationFromLabel({ contains: ["Milk"], may_contain: ["Peanuts"] }),
    { contains: ["Milk"], may_contain: ["Peanuts"] },
  );
  // Unknown shape stays empty — the caller still refuses to publish food
  // without a declaration, and nothing is inferred from ingredients.
  assert.ok(allergenDeclarationIsEmpty(allergenDeclarationFromLabel(42)));
  assert.ok(allergenDeclarationIsEmpty(allergenDeclarationFromLabel(null)));
  assert.ok(allergenDeclarationIsEmpty(
    allergenDeclarationFromLabel("Ingredients: water, wheat flour, milk"),
  ));
});

test("an API failure shows its real cause, not 'Internal server error'", () => {
  const text = describeBundleFactoryFailure({
    error: "Internal server error",
    detail: 'Draft x component "Clam Chowder" has no verified manufacturer allergen declaration',
  });
  assert.match(text, /Internal server error/);
  assert.match(text, /no verified manufacturer allergen declaration/);

  // A 422 that already explains itself is not padded with a duplicate line.
  const diagnosed = describeBundleFactoryFailure({
    error: "The donor catalogue has no exact product matching this request.",
    searched_for: "Прогрессо",
    matched_variants: 0,
    ready_variants: 0,
    requested_listings: 5,
    next_step: "Check the brand spelling.",
  });
  assert.match(diagnosed, /Searched for: “Прогрессо”/);
  assert.match(diagnosed, /0 matching product\(s\), 0 ready of 5 requested/);
  assert.match(diagnosed, /Check the brand spelling\./);
});
