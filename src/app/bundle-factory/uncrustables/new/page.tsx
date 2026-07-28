/**
 * Uncrustables Studio — new run (planner).
 *
 * Server shell for the client-side recipe planner. All planning math
 * (validateRecipe, listing copy, price model) is pure library code shared
 * with the API, so the client can preview it live before submitting.
 */

import { PageHead } from "@/components/kit";
import { PlannerClient } from "./PlannerClient";

export const dynamic = "force-dynamic";

export default function NewUncrustablesRunPage() {
  return (
    <>
      <PageHead
        title="New Uncrustables run"
        subtitle="Plan recipes with the box-planner, then create the run to queue renders"
      />
      <PlannerClient />
    </>
  );
}
