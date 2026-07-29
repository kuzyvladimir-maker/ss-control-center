import { NextRequest, NextResponse } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import {
  productTruthStandingWaveErrorCode,
  productTruthStandingWaveJson,
} from "@/lib/sourcing/product-truth-standing-wave-web-http";
import {
  loadProductTruthStandingWaveWebRuntime,
  productTruthStandingWaveWebPublicStatus,
} from "@/lib/sourcing/product-truth-standing-wave-web-runtime";
import {
  admitProductTruthStandingWaveWebCommand,
  readProductTruthStandingWaveWebStatus,
} from "@/lib/sourcing/product-truth-standing-wave-web-store";

export const dynamic = "force-dynamic";

function parseCommandBody(value: unknown): {
  requestId: string;
  operation: "START" | "RESUME";
  sourceCommandId: string | null;
} | null {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (
    keys.length !== 3
    || keys[0] !== "operation"
    || keys[1] !== "request_id"
    || keys[2] !== "source_command_id"
    || typeof body.request_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{7,199}$/u.test(body.request_id)
    || (body.operation !== "START" && body.operation !== "RESUME")
    || (body.source_command_id !== null
      && typeof body.source_command_id !== "string")
  ) return null;
  if (
    (body.operation === "START" && body.source_command_id !== null)
    || (
      body.operation === "RESUME"
      && (
        typeof body.source_command_id !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{7,199}$/u.test(
          body.source_command_id,
        )
      )
    )
  ) return null;
  return {
    requestId: body.request_id,
    operation: body.operation,
    sourceCommandId: body.source_command_id,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireModuleAccess(request, "catalog");
  if (auth instanceof NextResponse) return auth;
  let runtime;
  try {
    runtime = loadProductTruthStandingWaveWebRuntime();
  } catch (error) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthStandingWaveErrorCode(error),
      message:
        "Standing-wave runtime configuration is invalid; no command or provider call was started.",
    }, { status: 503 });
  }
  if (runtime.status === "OFF") {
    return productTruthStandingWaveJson({
      ok: true,
      status: "OFF",
      control: productTruthStandingWaveWebPublicStatus(runtime),
      commands: [],
    });
  }
  try {
    const wave = await readProductTruthStandingWaveWebStatus({ runtime });
    return productTruthStandingWaveJson({
      ok: true,
      status: wave.activeCommandId ? "RUNNING" : "READY",
      control: productTruthStandingWaveWebPublicStatus(runtime),
      wave,
    });
  } catch (error) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthStandingWaveErrorCode(error),
      message:
        "Standing-wave status failed closed; no command or provider call was started.",
    }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireModuleAccess(request, "catalog");
  if (auth instanceof NextResponse) return auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return productTruthStandingWaveJson({
      ok: false,
      status: "INVALID_REQUEST",
      message: "Canonical JSON body is required.",
    }, { status: 400 });
  }
  const command = parseCommandBody(body);
  if (!command) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "INVALID_REQUEST",
      message:
        "Only request_id, operation START|RESUME, and source_command_id are accepted.",
    }, { status: 400 });
  }
  let runtime;
  try {
    runtime = loadProductTruthStandingWaveWebRuntime();
  } catch (error) {
    return productTruthStandingWaveJson({
      ok: false,
      status: "BLOCKED",
      code: productTruthStandingWaveErrorCode(error),
    }, { status: 503 });
  }
  if (runtime.status === "OFF") {
    return productTruthStandingWaveJson({
      ok: false,
      status: "OFF",
      control: productTruthStandingWaveWebPublicStatus(runtime),
      message:
        "Standing-wave admission is not activated; no command or provider call was started.",
    }, { status: 503 });
  }
  try {
    const commandId = await admitProductTruthStandingWaveWebCommand({
      runtime,
      requestedByUserId: auth.id,
      requestId: command.requestId,
      operation: command.operation,
      sourceCommandId: command.sourceCommandId,
    });
    const wave = await readProductTruthStandingWaveWebStatus({ runtime });
    return productTruthStandingWaveJson({
      ok: true,
      status: "ADMITTED",
      command_id: commandId,
      control: productTruthStandingWaveWebPublicStatus(runtime),
      wave,
    }, { status: 202 });
  } catch (error) {
    const code = productTruthStandingWaveErrorCode(error);
    return productTruthStandingWaveJson({
      ok: false,
      status: code === "STANDING_WAVE_WEB_ALREADY_ACTIVE"
        ? "CONFLICT"
        : "BLOCKED",
      code,
      message:
        "Standing-wave admission failed closed; no unsealed provider work was started.",
    }, {
      status: code === "STANDING_WAVE_WEB_ALREADY_ACTIVE" ? 409 : 503,
    });
  }
}
