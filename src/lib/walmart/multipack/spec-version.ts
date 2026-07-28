// MP_ITEM feed spec version used by the multipack remediation pipeline.
//
// Kept in its own module because `remediate.ts` pulls in the image compositor,
// which loads sharp's native libvips at import time. Any consumer that only
// needs this string must not be forced to load a native binary — importing it
// from `remediate.ts` took down every route that touched the value.
export const SPEC_VERSION = "5.0.20260330-14_47_14-api";
