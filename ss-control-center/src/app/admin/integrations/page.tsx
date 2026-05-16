"use client";

// /admin/integrations
//
// Operator-side health + manual triggers for the external integrations.
// Currently:
//   - DriveStatusCard:  Google Drive OAuth status + env var snapshot
//   - DriveBackfillCard: manual trigger of the Layer-2 back-fill scan
//
// Admin role is enforced at the API layer (requireAdmin inside each route);
// page itself is reached through the /api/* middleware's session check.

import { PageHead } from "@/components/kit";
import DriveStatusCard from "./DriveStatusCard";
import DriveBackfillCard from "./DriveBackfillCard";

export default function IntegrationsAdminPage() {
  return (
    <div className="space-y-5">
      <PageHead
        title="Integrations"
        subtitle={
          <span>
            Health checks and manual triggers for external services.
          </span>
        }
      />
      <div className="grid gap-3 md:grid-cols-2">
        <DriveStatusCard />
        <DriveBackfillCard />
      </div>
    </div>
  );
}
