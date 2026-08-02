/**
 * Turn a free-form request into a build spec the operator confirms.
 *
 * Reads nothing, spends nothing on providers beyond one small language-model
 * call, and creates nothing. The answer is a proposal: the build page shows it
 * back and the owner accepts or edits it before any readiness check runs.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import { readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  WalmartRequestInterpreterError,
  interpretWalmartRequest,
} from "@/lib/bundle-factory/walmart-request-interpreter";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
  "bundle-factory-studio-interpret",
  async (request: NextRequest) => {
    const auth = await requireModuleAccess(request, "bundle-factory");
    if (auth instanceof NextResponse) return auth;
    const body = (await readJson<{ prompt?: unknown }>(request)) ?? {};
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    try {
      const interpretation = await interpretWalmartRequest(prompt);
      return NextResponse.json({ ok: true, interpretation });
    } catch (error) {
      if (error instanceof WalmartRequestInterpreterError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.code === "PROMPT_LENGTH" ? 400 : 422 },
        );
      }
      throw error;
    }
  },
);
