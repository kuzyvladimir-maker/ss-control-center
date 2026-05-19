/**
 * Bundle Factory — New Brief.
 *
 * Server page wrapping the client-side multi-step form. PageHead is
 * rendered server-side; the form itself is a client island because each
 * step is fully interactive (validation, step transitions, submit).
 */

import { PageHead, Sep } from "@/components/kit";
import { NewBriefForm } from "./NewBriefForm";

export const dynamic = "force-dynamic";

export default function NewBriefPage() {
  return (
    <>
      <PageHead
        title="New Brief"
        subtitle={
          <>
            <span className="font-medium text-ink-2">Stage 1 — Brief Input</span>
            <Sep />
            <span className="text-ink-3">
              Describe the bundle idea, then Stage 2 will research retail
              candidates near Clearwater.
            </span>
          </>
        }
      />
      <NewBriefForm />
    </>
  );
}
