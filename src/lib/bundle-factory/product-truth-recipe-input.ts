/**
 * @deprecated Compatibility facade. Product Truth SQL, validation, public
 * types, and version ownership live behind the canonical sourcing read
 * contract. New consumers must import from product-truth-read-contract.ts.
 */
export {
  PRODUCT_TRUTH_READ_CONTRACT_VERSION as BUNDLE_FACTORY_RECIPE_INPUT_CONTRACT_VERSION,
  DEFAULT_WALMART_PILOT_PRICE_MAX_AGE_MS,
  DEFAULT_WALMART_PILOT_ZIP,
  ProductTruthNewSkuReadError as ProductTruthRecipeInputError,
  buildProductTruthNewSkuRecipeComponentFromRows as buildProductTruthRecipeComponentFromRows,
  listProductTruthWalmartPilotCandidates as listWalmartPilotCandidates,
  readProductTruthNewSkuView as readProductTruthRecipeInput,
} from "@/lib/sourcing/product-truth-read-contract";

export type {
  ProductTruthNewSkuRecipeRequest as ProductTruthRecipeRequest,
  ProductTruthNewSkuReadOptions as ProductTruthRecipeReadOptions,
  ProductTruthNewSkuView as ProductTruthRecipeInput,
  ProductTruthWalmartPilotCandidate as WalmartPilotCandidate,
} from "@/lib/sourcing/product-truth-read-contract";
