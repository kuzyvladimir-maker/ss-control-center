/**
 * Turn a Bundle Factory API failure into something the operator can act on.
 *
 * The shared error handler answers unrecognised exceptions with
 * `{ error: "Internal server error", detail: "<the real message>" }`. Pages
 * that rendered only `error` therefore showed the least useful three words
 * available while the actual cause — "this component has no verified
 * manufacturer allergen declaration" — sat unread in the same response.
 *
 * Client-safe: no imports, no server-only types.
 */

export function describeBundleFactoryFailure(
  data: unknown,
  fallback = "Request failed",
): string {
  const body = (data ?? {}) as {
    error?: unknown;
    detail?: unknown;
    searched_for?: unknown;
    matched_variants?: unknown;
    ready_variants?: unknown;
    requested_listings?: unknown;
    next_step?: unknown;
  };
  const headline = typeof body.error === "string" && body.error.trim()
    ? body.error.trim()
    : fallback;
  const lines = [headline];
  if (typeof body.searched_for === "string" && body.searched_for.trim()) {
    lines.push(`Searched for: “${body.searched_for.trim()}”`);
  }
  if (typeof body.matched_variants === "number") {
    const ready = typeof body.ready_variants === "number" ? body.ready_variants : 0;
    const requested = typeof body.requested_listings === "number"
      ? body.requested_listings
      : null;
    lines.push(
      `Catalogue: ${body.matched_variants} matching product(s), ${ready} ready`
      + (requested === null ? "" : ` of ${requested} requested`),
    );
  }
  if (typeof body.next_step === "string" && body.next_step.trim()) {
    lines.push(body.next_step.trim());
  } else if (
    typeof body.detail === "string"
    && body.detail.trim()
    && body.detail.trim() !== headline
  ) {
    lines.push(body.detail.trim());
  }
  return lines.join("\n");
}
