/**
 * Marketplace-Rules KB loader.
 *
 * Reads selected `.md` files from `docs/marketplace-rules/<channel>/`,
 * trims them, and packages them as Anthropic system blocks with
 * `cache_control: { type: "ephemeral" }`. Each file becomes its own
 * cache breakpoint so a content-generation run that touches the same
 * KB file reuses the cached prefix instead of re-paying input cost.
 *
 * The KB ships baked into the app at `src/lib/bundle-factory/kb-content/`,
 * mirrored from the canonical `docs/marketplace-rules/` source. This
 * makes the bundle Vercel-deployable without crossing the
 * `ss-control-center/` package boundary at build time. Refresh via:
 *
 *   bash scripts/sync-kb-content.sh
 *
 * The loader runs server-side only.
 *
 * Why per-file cache breakpoints:
 *   The Anthropic prompt-cache caches everything up to a `cache_control`
 *   marker. Stacking N markers gives N independent caches that survive
 *   independently; one file changing only invalidates that one. With a
 *   bundle of 6 channels × ~1000 bundles/month, prompt caching is the
 *   single biggest cost lever — see PHASE_2_6_2 findings.
 *
 * Anthropic enforces a max of 4 cache_control markers per request. The
 * channel KB bundles below stay within that limit; if you add files,
 * either merge them or rotate by category.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type KbChannelTemplate = "amazon" | "walmart";

/**
 * Anthropic cache-control marker. Mirrors the shape used by
 * remediation/claude-rewrite.ts so the SDK accepts the same block array.
 */
export interface SystemBlockWithCache {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
}

/**
 * Files to pull per channel template. Order matters — Anthropic caches
 * the prefix up to each breakpoint, so the most stable / largest files
 * should go FIRST (their cache lives longest). The category-specific
 * files come after the template-wide ones.
 *
 * Cap at 4 entries — Anthropic's per-request cache_control marker limit.
 */
const KB_FILES_BY_TEMPLATE: Record<KbChannelTemplate, string[]> = {
  amazon: [
    "amazon/title-policy.md",
    "amazon/bullet-points-policy.md",
    "amazon/description-policy.md",
    "amazon/gift-set-policy.md",
  ],
  walmart: [
    "walmart/title-policy.md",
    "walmart/food-gift-baskets-deep-dive.md",
    "walmart/category-grocery.md",
    "walmart/multipack-policy.md",
  ],
};

/**
 * Resolve the in-package KB root. We never read the canonical
 * `docs/marketplace-rules/` directly so the bundle works on Vercel —
 * the build container doesn't include sibling directories above
 * `ss-control-center/`. Refresh via `scripts/sync-kb-content.sh`.
 */
function rulesRoot(): string {
  return resolve(process.cwd(), "src", "lib", "bundle-factory", "kb-content");
}

interface KbFileLoad {
  path: string;
  text: string;
  loaded: boolean;
  error?: string;
}

async function loadOne(path: string): Promise<KbFileLoad> {
  const absolute = join(rulesRoot(), path);
  if (!existsSync(absolute)) {
    return {
      path,
      text: "",
      loaded: false,
      error: `KB file not found at ${absolute}`,
    };
  }
  try {
    const raw = await readFile(absolute, "utf8");
    return { path, text: raw.trim(), loaded: true };
  } catch (e) {
    return {
      path,
      text: "",
      loaded: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface LoadKbResult {
  template: KbChannelTemplate;
  blocks: SystemBlockWithCache[];
  /** Files that were requested but missing — caller can log/skip. */
  missing: string[];
  /** Total bytes of KB text loaded (rough cache-write cost driver). */
  total_bytes: number;
}

/**
 * Load the KB bundle for a channel template. Returns an array of
 * Anthropic system blocks with cache_control markers attached. The
 * caller prepends its own non-cached blocks (style rules, banned-words
 * reminders) AFTER these blocks so the cache breakpoints stay at the
 * stable top of the prompt.
 *
 * If a file is missing, it's omitted (not an error) and the path is
 * returned in `missing` — the orchestrator decides whether to warn.
 */
export async function loadKnowledgeBase(
  template: KbChannelTemplate,
): Promise<LoadKbResult> {
  const paths = KB_FILES_BY_TEMPLATE[template] ?? [];
  const loaded = await Promise.all(paths.map(loadOne));

  const blocks: SystemBlockWithCache[] = [];
  const missing: string[] = [];
  let totalBytes = 0;

  for (const file of loaded) {
    if (!file.loaded) {
      missing.push(file.path);
      continue;
    }
    const block: SystemBlockWithCache = {
      type: "text",
      text: `=== KB: ${file.path} ===\n\n${file.text}\n`,
      cache_control: { type: "ephemeral" },
    };
    blocks.push(block);
    totalBytes += block.text.length;
  }

  return { template, blocks, missing, total_bytes: totalBytes };
}

/**
 * The Anthropic SDK accepts at most 4 `cache_control` markers per
 * request. If a future bundle exceeds that, this helper deduplicates
 * the LAST markers into the prior blocks so the prefix still caches.
 *
 * Exported so tests can verify the invariant.
 */
export function enforceCacheMarkerLimit(
  blocks: SystemBlockWithCache[],
  max = 4,
): SystemBlockWithCache[] {
  if (blocks.length <= max) return blocks;
  // Keep the first (max - 1) markers, then concatenate the rest into one
  // final block with a single marker.
  const head = blocks.slice(0, max - 1);
  const tail = blocks.slice(max - 1);
  const merged: SystemBlockWithCache = {
    type: "text",
    text: tail.map((b) => b.text).join("\n\n"),
    cache_control: { type: "ephemeral" },
  };
  return [...head, merged];
}
