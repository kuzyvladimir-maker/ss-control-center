/**
 * Typed error classes that `withErrorHandler` in api-utils.ts maps to
 * specific HTTP status codes. Throw these from pipelines and library
 * code so route handlers don't have to re-implement the same state
 * checks just to return the right status.
 */

export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
}

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}
