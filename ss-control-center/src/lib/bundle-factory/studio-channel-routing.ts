/**
 * Channel routing for the prompt-driven Bundle Factory Studio.
 *
 * Walmart new-SKU creation is still part of Bundle Factory, but its pilot
 * requires the sealed Product Truth -> plan -> stage -> certify -> apply
 * workflow.  The legacy prompt-driven Studio reads mutable DonorProduct rows
 * directly and therefore must never create Walmart work in parallel.
 */

export const WALMART_CANONICAL_OPERATOR_MESSAGE =
  "Walmart new SKU creation uses the canonical Bundle Factory Walmart pilot workflow. " +
  "Run the verified `npm run walmart:new-sku -- ...` engine through Claude Code.";

export type StudioChannelRoute =
  | "LEGACY_STUDIO_ALLOWED"
  | "CANONICAL_WALMART_OPERATOR_REQUIRED";

export function studioChannelRoute(channel: string): StudioChannelRoute {
  return channel === "WALMART"
    ? "CANONICAL_WALMART_OPERATOR_REQUIRED"
    : "LEGACY_STUDIO_ALLOWED";
}
