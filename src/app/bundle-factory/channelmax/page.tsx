import {
  Activity,
  Camera,
  Database,
  FileCheck2,
  LockKeyhole,
} from "lucide-react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PageHead, Panel, PanelBody, PanelHeader, Sep } from "@/components/kit";
import { verifySession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ChannelMaxControls } from "./ChannelMaxControls";

export const dynamic = "force-dynamic";

const ACCOUNT_ID = "channelmax:amznus:salutem-solutions";
const ACCOUNT_LABEL = "Amazon US · Salutem Solutions";
const PAGE_PATH = "/bundle-factory/channelmax";

type JobView = {
  id: string;
  operation: string;
  mutation: boolean;
  status: string;
  expectedActiveRows: number | null;
  includeInactive: boolean | null;
  attempts: number;
  maxAttempts: number;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  eventCount: number;
  evidenceCount: number;
};

type StatusCount = { status: string; count: number };

function expectedScope(payloadJson: string): {
  expectedActiveRows: number | null;
  includeInactive: boolean | null;
} {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { expectedActiveRows: null, includeInactive: null };
    }
    const record = payload as Record<string, unknown>;
    return {
      expectedActiveRows: Number.isInteger(record.expected_active_rows)
        ? (record.expected_active_rows as number)
        : null,
      includeInactive:
        typeof record.include_inactive === "boolean"
          ? record.include_inactive
          : null,
    };
  } catch {
    return { expectedActiveRows: null, includeInactive: null };
  }
}

function formatDate(value: Date | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

function operationLabel(operation: string): string {
  const labels: Record<string, string> = {
    SNAPSHOT_INVENTORY: "Inventory snapshot",
    DISCOVER_MANUAL_MODEL: "Discover manual model",
    UPLOAD_MANUAL_ASSIGNMENT: "Upload assignment",
    VERIFY_UPLOAD_TASK: "Verify upload",
    EXPORT_INVENTORY: "Inventory export",
    OBSERVE_POST_UPLOAD_HOLD: "Post-upload observation",
    RECONCILE_MUTATION: "Mutation reconciliation",
  };
  return labels[operation] ?? operation.toLowerCase().replaceAll("_", " ");
}

function statusCount(rows: StatusCount[], status: string): number {
  return rows.find((row) => row.status === status)?.count ?? 0;
}

export default async function ChannelMaxControlPage() {
  const token = (await cookies()).get("sscc-session")?.value;
  const session = token ? verifySession(token) : null;
  if (!session) redirect("/login");
  const pageUser = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { role: true },
  });
  if (pageUser?.role !== "admin") {
    redirect(`/no-access?from=${encodeURIComponent(PAGE_PATH)}`);
  }

  let jobs: JobView[] = [];
  let statusCounts: StatusCount[] = [];
  let storageReady = true;
  let snapshotActive = false;

  try {
    const [recent, grouped, activeSnapshot] = await Promise.all([
      prisma.channelMaxAgentJob.findMany({
        where: { accountId: ACCOUNT_ID },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          operation: true,
          mutation: true,
          status: true,
          payloadJson: true,
          attempts: true,
          maxAttempts: true,
          queuedAt: true,
          startedAt: true,
          completedAt: true,
          leaseExpiresAt: true,
          lastHeartbeatAt: true,
          _count: { select: { events: true, evidence: true } },
        },
      }),
      prisma.channelMaxAgentJob.groupBy({
        by: ["status"],
        where: { accountId: ACCOUNT_ID },
        _count: { _all: true },
      }),
      prisma.channelMaxAgentJob.findFirst({
        where: {
          accountId: ACCOUNT_ID,
          operation: "SNAPSHOT_INVENTORY",
          status: { in: ["QUEUED", "RUNNING"] },
        },
        select: { id: true },
      }),
    ]);

    jobs = recent.map((job) => ({
      id: job.id,
      operation: job.operation,
      mutation: job.mutation,
      status: job.status,
      ...expectedScope(job.payloadJson),
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      leaseExpiresAt: job.leaseExpiresAt,
      lastHeartbeatAt: job.lastHeartbeatAt,
      eventCount: job._count.events,
      evidenceCount: job._count.evidence,
    }));
    statusCounts = grouped.map((row) => ({
      status: row.status,
      count: row._count._all,
    }));
    snapshotActive = activeSnapshot !== null;
  } catch {
    storageReady = false;
    snapshotActive = false;
  }

  const latestHeartbeat = jobs
    .map((job) => job.lastHeartbeatAt)
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const evidenceCount = jobs.reduce((sum, job) => sum + job.evidenceCount, 0);
  return (
    <>
      <PageHead
        title="ChannelMAX control plane"
        subtitle={
          <>
            <span className="font-medium text-ink-2">{ACCOUNT_LABEL}</span>
            <Sep />
            <span>Read-only browser-worker orchestration and evidence</span>
          </>
        }
        actions={
          <ChannelMaxControls
            storageReady={storageReady}
            snapshotActive={snapshotActive}
          />
        }
      />

      <section
        aria-label="Mutation safety lock"
        className="rounded-[14px] border border-warn-strong/35 bg-warn-tint px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-md bg-surface p-1.5 text-warn-strong">
            <LockKeyhole size={16} aria-hidden="true" />
          </span>
          <div>
            <div className="text-[13px] font-semibold text-warn-strong">
              Mutation pipeline LOCKED
            </div>
            <p className="mt-0.5 max-w-4xl text-[12px] leading-relaxed text-ink-2">
              Price edits, repricer changes, uploads, and browser actions are not
              available here. The release gate stays closed until owner step-up,
              immutable evidence, exact Chrome targeting, and rollback/reconciliation
              pass an end-to-end canary.
            </p>
          </div>
        </div>
      </section>

      {!storageReady && (
        <div
          role="alert"
          className="rounded-[14px] border border-danger/30 bg-danger-tint px-4 py-3 text-[12.5px] text-danger"
        >
          ChannelMAX queue storage is not ready. Apply the ChannelMAX database
          migration before starting the read-only worker.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          icon={<Database size={15} />}
          label="Queued jobs"
          value={statusCount(statusCounts, "QUEUED")}
          detail="Awaiting the iMac worker"
        />
        <MetricCard
          icon={<Activity size={15} />}
          label="Running"
          value={statusCount(statusCounts, "RUNNING")}
          detail={latestHeartbeat ? `Heartbeat ${formatDate(latestHeartbeat)}` : "No heartbeat yet"}
        />
        <MetricCard
          icon={<FileCheck2 size={15} />}
          label="Succeeded"
          value={statusCount(statusCounts, "SUCCEEDED")}
          detail="Read-only jobs completed"
        />
        <MetricCard
          icon={<Camera size={15} />}
          label="Managed evidence"
          value={evidenceCount}
          detail="Files attached to recent jobs"
        />
      </div>

      <Panel>
        <PanelHeader
          title="Recent ChannelMAX jobs"
          count={jobs.length}
          right={
            <span className="text-[11px] text-ink-3">
              Expected scope: 164 active rows · inactive excluded
            </span>
          }
        />
        <PanelBody className="p-0">
          {jobs.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <div className="text-[13px] font-medium text-ink">
                No ChannelMAX jobs yet
              </div>
              <p className="mx-auto mt-1 max-w-lg text-[12px] leading-relaxed text-ink-3">
                Queue a read-only inventory snapshot. It can observe and capture
                evidence, but it cannot change ChannelMAX or Amazon data.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[1040px] w-full text-[12px] text-ink">
                <thead className="bg-surface-tint text-[10.5px] uppercase tracking-wider text-ink-3">
                  <tr>
                    <Th>Operation</Th>
                    <Th>Status</Th>
                    <Th>Expected scope</Th>
                    <Th>Lease / heartbeat</Th>
                    <Th className="text-right">Attempt</Th>
                    <Th className="text-right">Events</Th>
                    <Th className="text-right">Evidence</Th>
                    <Th>Queued</Th>
                    <Th>Completed</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {jobs.map((job) => (
                    <tr key={job.id} className="align-top hover:bg-bg-elev/40">
                      <Td>
                        <div className="font-medium text-ink">
                          {operationLabel(job.operation)}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className="font-mono text-[10.5px] text-ink-3">
                            {job.id.slice(0, 12)}
                          </span>
                          <ModeBadge mutation={job.mutation} />
                        </div>
                      </Td>
                      <Td><StatusBadge status={job.status} /></Td>
                      <Td>
                        <div className="tabular-nums">
                          {job.expectedActiveRows ?? "—"} active rows
                        </div>
                        <div className="mt-0.5 text-[10.5px] text-ink-3">
                          {job.includeInactive === null
                            ? "Inactive scope n/a"
                            : job.includeInactive
                              ? "Includes inactive"
                              : "Inactive excluded"}
                        </div>
                      </Td>
                      <Td>
                        <LeaseState job={job} />
                        <div className="mt-0.5 text-[10.5px] text-ink-3">
                          Heartbeat {formatDate(job.lastHeartbeatAt)}
                        </div>
                      </Td>
                      <Td className="text-right font-mono tabular-nums">
                        {job.attempts}/{job.maxAttempts}
                      </Td>
                      <Td className="text-right font-mono tabular-nums text-ink-2">
                        {job.eventCount}
                      </Td>
                      <Td className="text-right font-mono tabular-nums text-ink-2">
                        {job.evidenceCount}
                      </Td>
                      <Td className="whitespace-nowrap text-ink-2">
                        {formatDate(job.queuedAt)}
                      </Td>
                      <Td className="whitespace-nowrap text-ink-2">
                        {formatDate(job.completedAt)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PanelBody>
      </Panel>
    </>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="rounded-[14px] border border-rule bg-surface p-3.5">
      <div className="flex items-center gap-2 text-ink-3">
        {icon}
        <span className="text-[11px] font-medium uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="mt-2 font-mono text-[23px] font-semibold tabular-nums text-ink">
        {value.toLocaleString("en-US")}
      </div>
      <div className="mt-0.5 truncate text-[10.5px] text-ink-3" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function ModeBadge({ mutation }: { mutation: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${
        mutation
          ? "bg-danger-tint text-danger"
          : "bg-green-soft text-green-ink"
      }`}
    >
      {mutation ? "Mutation" : "Read only"}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    QUEUED: "bg-silver-tint text-ink-2",
    RUNNING: "bg-warn-tint text-warn-strong",
    SUCCEEDED: "bg-green-soft text-green-ink",
    FAILED: "bg-danger-tint text-danger",
    AMBIGUOUS: "bg-danger-tint text-danger",
    CANCELLED: "bg-bg-elev text-ink-3",
    PENDING_APPROVAL: "bg-warn-tint text-warn-strong",
  };
  return (
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-[10.5px] font-medium ${
        variants[status] ?? "bg-bg-elev text-ink-3"
      }`}
    >
      {status.toLowerCase().replaceAll("_", " ")}
    </span>
  );
}

function LeaseState({ job }: { job: JobView }) {
  if (job.status === "QUEUED") {
    return <span className="text-ink-2">Awaiting worker</span>;
  }
  if (job.status !== "RUNNING") {
    return <span className="text-ink-3">No active lease</span>;
  }
  if (!job.leaseExpiresAt) {
    return <span className="text-danger">Lease not recorded</span>;
  }
  return (
    <span className="text-ink-2">
      Leased until {formatDate(job.leaseExpiresAt)}
    </span>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2.5 text-left font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 ${className}`}>{children}</td>;
}
