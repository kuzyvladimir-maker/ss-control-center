/**
 * Immutable Product Truth content capture kinds.
 *
 * Search snippets are evidence, but never content truth. Both exact capture
 * kinds below are bound to an exact donor/variant/source identity. The field
 * snapshot kind deliberately permits null facts so each consumer can enforce
 * its own required-field readiness without discarding other paid evidence.
 */
export const EXACT_COMPLETE_CONTENT_CAPTURE = "exact_complete_v1" as const;
export const EXACT_FIELD_SNAPSHOT_CAPTURE = "exact_field_snapshot_v2" as const;
export const LEGACY_MATERIALIZED_CONTENT_CAPTURE = "legacy_materialized_bridge" as const;

export type ExactProductContentCapture =
  | typeof EXACT_COMPLETE_CONTENT_CAPTURE
  | typeof EXACT_FIELD_SNAPSHOT_CAPTURE
  | typeof LEGACY_MATERIALIZED_CONTENT_CAPTURE;

export function exactProductContentCapture(
  content: Record<string, unknown> | null | undefined,
): ExactProductContentCapture | null {
  const capture = content?._capture;
  return capture === EXACT_COMPLETE_CONTENT_CAPTURE
    || capture === EXACT_FIELD_SNAPSHOT_CAPTURE
    || capture === LEGACY_MATERIALIZED_CONTENT_CAPTURE
    ? capture
    : null;
}

export function isExactProductContentCapture(
  content: Record<string, unknown> | null | undefined,
): boolean {
  return exactProductContentCapture(content) !== null;
}
