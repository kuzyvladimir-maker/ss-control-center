/**
 * Queue a batch of listings for publishing, and read the factory switch.
 *
 * The batch lives on the SERVER. The page that queued it may be closed the next
 * second: the cron backstop advances it either way. That is the difference
 * between "press publish and wait" and a factory.
 *
 * POST — queue the selected drafts. One owner decision, one stated count.
 * GET  — the current mode and the rolling ceiling, for the switch in the UI.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import { readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  FACTORY_MODES,
  isFactoryMode,
  readFactoryMode,
  writeFactoryMode,
} from "@/lib/bundle-factory/factory-mode";
import {
  readFactoryRails,
  setFactoryPaused,
} from "@/lib/bundle-factory/walmart-factory-rails";
import {
  enqueuePublishBatch,
  listOpenPublishBatches,
  readPublishCapState,
} from "@/lib/bundle-factory/publish-queue";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "bundle-factory-publish-batches[GET]",
  async (request: NextRequest) => {
    const auth = await requireModuleAccess(request, "bundle-factory");
    if (auth instanceof NextResponse) return auth;
    const [mode, cap, open, rails] = await Promise.all([
      readFactoryMode(),
      readPublishCapState(),
      listOpenPublishBatches(5),
      readFactoryRails(),
    ]);
    return NextResponse.json({
      ok: true,
      mode,
      modes: FACTORY_MODES,
      rails,
      cap,
      open_batches: open,
    });
  },
);

export const POST = withErrorHandler(
  "bundle-factory-publish-batches[POST]",
  async (request: NextRequest) => {
    const auth = await requireModuleAccess(request, "bundle-factory");
    if (auth instanceof NextResponse) return auth;
    const body = (await readJson<{
      draftIds?: unknown;
      note?: unknown;
      mode?: unknown;
      paused?: unknown;
      approvalConfirmed?: unknown;
    }>(request)) ?? {};

    // The switch shares this route so the UI has one place to read and write
    // the factory's operating state.
    // The pause is a separate handle from the mode on purpose: stopping the
    // line should not also forget whether it was running itself.
    if (typeof body.paused === "boolean") {
      await setFactoryPaused(body.paused, auth.username ?? "operator");
      return NextResponse.json({ ok: true, rails: await readFactoryRails() });
    }

    if (body.mode !== undefined) {
      if (!isFactoryMode(body.mode)) {
        return NextResponse.json(
          { error: `mode must be one of ${FACTORY_MODES.join(", ")}` },
          { status: 400 },
        );
      }
      const mode = await writeFactoryMode(body.mode, auth.username ?? "operator");
      return NextResponse.json({ ok: true, mode });
    }

    const draftIds = Array.isArray(body.draftIds)
      ? body.draftIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (draftIds.length === 0) {
      return NextResponse.json(
        { error: "Select at least one listing to publish." },
        { status: 400 },
      );
    }
    // Queuing is the moment the owner's decision is taken; it is stated once,
    // for a known count, exactly as a per-listing press states it once each.
    if (body.approvalConfirmed !== true) {
      return NextResponse.json({
        error:
          "Publishing a batch requires approvalConfirmed=true from the operator "
          + "confirmation dialog.",
      }, { status: 400 });
    }

    const result = await enqueuePublishBatch({
      draftIds,
      actor: auth.username ?? "operator",
      ...(typeof body.note === "string" ? { note: body.note } : {}),
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  },
);
