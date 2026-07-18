"use strict";

const path = require("path");

const REQUIRED_IMAGE_MODEL = "gpt-image-2";

/**
 * Wrap the application prompt for the Codex image worker.
 *
 * Reference order is a production contract:
 *   ref-1 = immutable kit/layout anchor
 *   ref-2..N = exact product-art donors in recipe order
 *
 * Every filename is named explicitly. The previous implementation described
 * only ref-1 and ref-2 even when the request contained multiple product
 * donors, which allowed later flavors in a mixed recipe to be omitted.
 */
function buildPrompt(userPrompt, size, refFiles) {
  let sizeHint = "";
  if (size) {
    const [w, h] = String(size).split("x").map((n) => parseInt(n, 10));
    if (w && h) {
      const shape = w === h
        ? "square"
        : w > h
          ? "landscape, wider than tall"
          : "portrait, taller than wide";
      sizeHint = ` Compose it as a ${shape} image, roughly ${w}x${h} pixels.`;
    }
  }

  const files = Array.isArray(refFiles) ? refFiles : [];
  let refHint = "";
  if (files.length === 1) {
    const reference = path.basename(files[0]);
    refHint =
      ` Reference image ${reference} is in the current working directory. ` +
      `Pass it to the image_gen tool as an input/reference image and match ` +
      `only the roles assigned to it by the application prompt.`;
  } else if (files.length >= 2) {
    const anchor = path.basename(files[0]);
    const donors = files.slice(1).map((file, index) => ({
      filename: path.basename(file),
      recipeIndex: index + 1,
    }));
    const donorRoles = donors
      .map(
        ({ filename, recipeIndex }) =>
          `${filename} is DONOR PRODUCT REFERENCE #${recipeIndex} for recipe component #${recipeIndex}; ` +
          `copy that component's genuine retail packaging only from ${filename}`,
      )
      .join(". ");
    const allFiles = files.map((file) => path.basename(file)).join(", ");

    refHint =
      ` ${files.length} ordered reference image files are in the current working directory. ` +
      `${anchor} is the KIT ANCHOR — use it ONLY for the cooler, gel packs, camera, lighting, and overall layout; never copy its third-party products. ` +
      `${donorRoles}. Every donor corresponds to a distinct recipe component in the exact supplied order. ` +
      `Show every recipe component and keep each donor's real brand, flavor name, colors, art, and genuine pack count separate. ` +
      `Do not omit a later donor, merge two donor designs, substitute one donor for another, invent package art, or create generic wrappers/cartons. ` +
      `Pass ALL ${files.length} files to image_gen in this exact order: ${allFiles}.`;
  }

  return (
    `Generate an image: ${userPrompt}.${sizeHint}${refHint} ` +
    `Use the imagegen skill with the built-in image_gen tool. The required image model is ${REQUIRED_IMAGE_MODEL}; ` +
    `do not use a legacy model or a non-image_gen fallback. ` +
    `Do not ask any questions and do not request confirmation; just generate and save the image.`
  );
}

module.exports = { buildPrompt, REQUIRED_IMAGE_MODEL };
