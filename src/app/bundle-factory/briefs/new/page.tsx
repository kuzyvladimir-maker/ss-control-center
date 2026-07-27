/**
 * Bundle Factory — old "New Brief" entry (Perplexity research flow).
 *
 * Phase 7: superseded by the single donor-sourced build flow. Kept as a
 * redirect so old links/bookmarks land on the one create door instead of a
 * second, conflicting entry. The legacy NewBriefForm is no longer reachable
 * from the UI.
 */

import { redirect } from "next/navigation";

export default function NewBriefPage() {
  redirect("/bundle-factory/new");
}
