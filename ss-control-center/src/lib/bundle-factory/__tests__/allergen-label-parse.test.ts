import assert from "node:assert/strict";
import test from "node:test";

import {
  allergenDeclarationFromLabelText,
} from "../allergen-declaration";

test("reads only the manufacturer's explicit allergen statement", () => {
  assert.deepEqual(
    allergenDeclarationFromLabelText("Contains: Egg, Wheat, Milk, Soy."),
    { contains: ["Egg", "Wheat", "Milk", "Soy"], may_contain: [] },
  );

  // The real Campbell's payload keeps the statement at the end of the
  // ingredient blob; the parser must find it there.
  assert.deepEqual(
    allergenDeclarationFromLabelText(
      "Ingredients: Chicken Stock, Eggs, Salt.\n\nContains: Egg, Wheat, Milk, Soy.",
    ),
    { contains: ["Egg", "Wheat", "Milk", "Soy"], may_contain: [] },
  );

  // "and" separates labels, and a precautionary line stays precautionary — it
  // must never be promoted into the positive declaration.
  assert.deepEqual(
    allergenDeclarationFromLabelText(
      "Contains: Milk and Soy. May contain: Tree Nuts, Peanuts.",
    ),
    { contains: ["Milk", "Soy"], may_contain: ["Tree Nuts", "Peanuts"] },
  );
});

test("never infers an allergen from the ingredient list", () => {
  // Milk and wheat appear as ingredients, but with no printed statement the
  // declaration stays empty so the publish gate refuses rather than guesses.
  assert.deepEqual(
    allergenDeclarationFromLabelText(
      "Ingredients: water, wheat flour, milk, salt, tomatoes",
    ),
    { contains: [], may_contain: [] },
  );
  assert.deepEqual(
    allergenDeclarationFromLabelText(null),
    { contains: [], may_contain: [] },
  );
});
