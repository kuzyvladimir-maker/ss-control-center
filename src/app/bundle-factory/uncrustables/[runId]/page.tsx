/**
 * Uncrustables Studio — run board.
 *
 * Server shell: resolves the run (404 when unknown) and hands off to the
 * polling client board, which drives ticks while candidates are queued.
 */

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PageHead, Sep } from "@/components/kit";
import { RunBoardClient } from "./RunBoardClient";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ runId: string }>;
}

export default async function UncrustablesRunBoardPage({ params }: PageProps) {
  const { runId } = await params;
  const run = await prisma.uncrustablesStudioRun.findUnique({
    where: { id: runId },
    select: { id: true, name: true, created_by: true, created_at: true },
  });
  if (!run) return notFound();

  return (
    <>
      <PageHead
        title={run.name}
        subtitle={
          <>
            <span>Uncrustables Studio run</span>
            <Sep />
            <span className="font-mono">{run.id}</span>
            <Sep />
            <span>{run.created_at.toISOString().slice(0, 16).replace("T", " ")}</span>
          </>
        }
      />
      <RunBoardClient runId={run.id} />
    </>
  );
}
