const ADVISOR_PRICE_ATTRIBUTE_ROOTS = new Set([
  "purchasable_offer",
  "business_price",
  "discounted_price",
  "list_price",
]);

export const ADVISOR_PRICE_WRITE_BLOCKED_ERROR =
  "Growth Advisor cannot write or roll back offer pricing; use the sealed pricing workflow";

/** Growth Advisor is a structural/content remediation surface, not a price
 * authority. Accept dotted names and JSON-pointer-like paths so callers cannot
 * bypass the rule by addressing a nested offer field. */
export function isGrowthAdvisorPriceAttribute(attribute: string): boolean {
  const root = attribute
    .trim()
    .replace(/^\/+attributes\//, "")
    .split(/[./]/, 1)[0]
    ?.trim();
  return Boolean(root && ADVISOR_PRICE_ATTRIBUTE_ROOTS.has(root));
}
