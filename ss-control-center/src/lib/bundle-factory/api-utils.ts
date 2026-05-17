/**
 * Tiny helpers shared by Bundle Factory route handlers. Intentionally
 * dependency-light — no Zod yet (Phase 1 is skeleton). Stage 4+ will
 * tighten this up.
 */

import { NextResponse } from "next/server";

/** Wrap a route handler so unexpected exceptions return JSON 500 instead
 *  of leaking stack traces. Returns the original response on success. */
export function withErrorHandler<T extends unknown[]>(
  routeName: string,
  fn: (...args: T) => Promise<Response>
): (...args: T) => Promise<Response> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[bundle-factory/${routeName}] error:`, err);
      return NextResponse.json(
        { error: "Internal server error", detail: message },
        { status: 500 }
      );
    }
  };
}

/** Parse JSON body; return null on failure (caller decides 400 vs other). */
export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Standard 400 response when input validation fails. */
export function badRequest(message: string, detail?: unknown) {
  return NextResponse.json(
    detail !== undefined ? { error: message, detail } : { error: message },
    { status: 400 }
  );
}

/** Standard 404 response. */
export function notFound(message = "Not found") {
  return NextResponse.json({ error: message }, { status: 404 });
}

/** Parse a finite integer search-param; returns fallback if missing or NaN. */
export function intParam(
  params: URLSearchParams,
  name: string,
  fallback: number
): number {
  const raw = params.get(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
