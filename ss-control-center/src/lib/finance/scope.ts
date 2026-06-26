// Finance scope = which pool a row belongs to. The Finance Core engine is shared
// between the business pool (marketplace payouts) and the personal pool (owner's
// draw + bills + credit cards). Every shared read filters by scope so the two
// pools never mix; business is the default so existing callers are unaffected.

import type { NextRequest } from "next/server";

export type Scope = "business" | "personal";

/** Read scope from a request query (`?scope=personal`); default "business". */
export function scopeOf(req: NextRequest): Scope {
  return req.nextUrl.searchParams.get("scope") === "personal" ? "personal" : "business";
}

/** Read scope from a parsed JSON body; default "business". */
export function scopeFromBody(b: unknown): Scope {
  return (b as { scope?: string })?.scope === "personal" ? "personal" : "business";
}
