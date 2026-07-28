/**
 * A+ module catalog + JSON builders (API 2020-11-01 component shapes).
 *
 * We use a focused, reliable subset of the 15 standard module types for the
 * generator's storyboard. Char limits per module are enforced by the qualification
 * gate (qualification.ts) and ultimately by Amazon's validate endpoint.
 * Spec source: docs/wiki/aplus-content-knowledge-base.md.
 */

export const MAX_MODULES = 7; // Amazon rejects > 7 for sellers

export interface TextComponent { value: string; decoratorSet?: unknown[] }
export interface ParagraphComponent { textList: TextComponent[] }
export interface ImageComponent {
  uploadDestinationId: string;
  imageCropSpecification: { size: { width: { value: number; units: "pixels" }; height: { value: number; units: "pixels" } } };
  altText: string;
}

// Per-module character limits (for the gate). body limits are generous; we keep
// copy tight anyway.
export const MODULE_LIMITS = {
  STANDARD_HEADER_IMAGE_TEXT: { headline: 150, subheadline: 150, body: 6000, image: [970, 600] },
  STANDARD_SINGLE_SIDE_IMAGE: { headline: 160, body: 1000, image: [300, 300] },
  STANDARD_TEXT: { headline: 160, body: 5000 },
  STANDARD_PRODUCT_DESCRIPTION: { body: 6000 },
  STANDARD_COMPANY_LOGO: { image: [600, 180] },
} as const;

function text(value: string): TextComponent { return { value, decoratorSet: [] }; }
function paragraph(value: string): ParagraphComponent { return { textList: [text(value)] }; }
function image(uploadDestinationId: string, w: number, h: number, altText: string): ImageComponent {
  return {
    uploadDestinationId,
    imageCropSpecification: { size: { width: { value: w, units: "pixels" }, height: { value: h, units: "pixels" } } },
    altText: altText.slice(0, 100),
  };
}

export interface ModuleJSON { contentModuleType: string; [k: string]: unknown }

export function headerImageText(opts: { headline: string; body: string; img?: ImageComponent }): ModuleJSON {
  return {
    contentModuleType: "STANDARD_HEADER_IMAGE_TEXT",
    standardHeaderImageText: {
      headline: text(opts.headline),
      block: { image: opts.img, headline: text(""), body: paragraph(opts.body) },
    },
  };
}
export function singleSideImage(opts: { position: "LEFT" | "RIGHT"; headline: string; body: string; img?: ImageComponent }): ModuleJSON {
  return {
    contentModuleType: "STANDARD_SINGLE_SIDE_IMAGE",
    standardSingleSideImage: {
      imagePositionType: opts.position,
      block: { image: opts.img, headline: text(opts.headline), body: paragraph(opts.body) },
    },
  };
}
export function standardText(opts: { headline: string; body: string }): ModuleJSON {
  return { contentModuleType: "STANDARD_TEXT", standardText: { headline: text(opts.headline), body: paragraph(opts.body) } };
}
export function productDescription(opts: { body: string }): ModuleJSON {
  return { contentModuleType: "STANDARD_PRODUCT_DESCRIPTION", standardProductDescription: { body: paragraph(opts.body) } };
}
export function companyLogo(opts: { img: ImageComponent }): ModuleJSON {
  return { contentModuleType: "STANDARD_COMPANY_LOGO", standardCompanyLogo: { companyLogo: opts.img } };
}

/** 3-image "Top benefits" block (each cell = image + headline + short body).
 *  Verified high-converting food-A+ module. 300x300 images, stack on mobile. */
export function threeImageText(opts: { headline: string; cells: { headline: string; body: string; img?: ImageComponent }[] }): ModuleJSON {
  const c = opts.cells;
  const block = (i: number) => ({ image: c[i]?.img, headline: text((c[i]?.headline ?? "").slice(0, 160)), body: paragraph((c[i]?.body ?? "").slice(0, 1000)) });
  return {
    contentModuleType: "STANDARD_THREE_IMAGE_TEXT",
    standardThreeImageText: { headline: text(opts.headline.slice(0, 70)), block1: block(0), block2: block(1), block3: block(2) },
  };
}

/** 4-image grid with a per-cell headline + short body — the "lifestyle grid"
 *  module that makes A+ look like a landing page (e.g. Frito-Lay's 4 captions). */
export function fourImageText(opts: { headline: string; cells: { headline: string; body: string; img?: ImageComponent }[] }): ModuleJSON {
  const c = opts.cells;
  const block = (i: number) => ({ image: c[i]?.img, headline: text((c[i]?.headline ?? "").slice(0, 160)), body: paragraph((c[i]?.body ?? "").slice(0, 1000)) });
  return {
    contentModuleType: "STANDARD_FOUR_IMAGE_TEXT",
    standardFourImageText: { headline: text(opts.headline.slice(0, 70)), block1: block(0), block2: block(1), block3: block(2), block4: block(3) },
  };
}

export { image as buildImage };

export interface AplusDocument {
  name: string;
  contentType: "EBC";
  locale: "en-US";
  contentModuleList: ModuleJSON[];
}

/** Assemble a content document, capping at MAX_MODULES. */
export function assembleDocument(name: string, modules: ModuleJSON[]): AplusDocument {
  return { name: name.slice(0, 100), contentType: "EBC", locale: "en-US", contentModuleList: modules.slice(0, MAX_MODULES) };
}
