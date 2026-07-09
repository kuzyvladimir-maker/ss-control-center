/** Bundle temperature classification — pure, dependency-free, so both the image
 *  pipeline and the Amazon publish path can use it without dragging prisma /
 *  the compliance gate along. */

/** Frozen/refrigerated → cold-chain (drives the frozen shipping template, the
 *  cooler hero image, and Amazon's `is_heat_sensitive` attribute). */
export function isColdCategory(category: string | null | undefined): boolean {
  const c = (category || "").toUpperCase();
  return c.includes("FROZEN") || c.includes("REFRIGERATED");
}
