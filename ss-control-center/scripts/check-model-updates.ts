// ─────────────────────────────────────────────────────────────────────────
//  Model-update checker (read-only).
//
//  Asks Anthropic's live Models API which Claude models exist right now, and
//  compares them against what we have pinned in src/lib/ai-models.ts. If a
//  newer model has shipped than anything we use, it says so — then a human
//  decides whether to upgrade (change ONE line in src/lib/ai-models.ts).
//
//  It changes NOTHING. Safe to run any time.
//
//    npx tsx scripts/check-model-updates.ts
//
//  Needs ANTHROPIC_API_KEY (read from .env.local / .env, same as other scripts).
// ─────────────────────────────────────────────────────────────────────────
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE } from "@/lib/ai-models";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    console.error(
      "✗ ANTHROPIC_API_KEY is missing/invalid. Add it to .env.local, then re-run.",
    );
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey });

  // Which models we currently pin, by tier.
  const pinned: Record<string, string> = {
    premium: CLAUDE.premium,
    balanced: CLAUDE.balanced,
    cheap: CLAUDE.cheap,
  };
  const pinnedIds = new Set(Object.values(pinned));

  // Pull the live Claude model list (SDK auto-paginates on iteration).
  const models: { id: string; name: string; released: string }[] = [];
  for await (const m of anthropic.models.list()) {
    if (!m.id.startsWith("claude-")) continue;
    models.push({
      id: m.id,
      name: (m as { display_name?: string }).display_name ?? m.id,
      released: String((m as { created_at?: string }).created_at ?? "").slice(0, 10),
    });
  }
  // Newest first.
  models.sort((a, b) => (a.released < b.released ? 1 : -1));

  // The release date of the newest model we actually use.
  const newestPinnedDate = models
    .filter((m) => pinnedIds.has(m.id))
    .map((m) => m.released)
    .sort()
    .pop() ?? "";

  console.log("\n  Currently pinned (src/lib/ai-models.ts):");
  for (const [tier, id] of Object.entries(pinned)) {
    const live = models.find((m) => m.id === id);
    const note = live ? `released ${live.released}` : "⚠ NOT in live list (renamed/retired?)";
    console.log(`    ${tier.padEnd(9)} → ${id.padEnd(22)} ${note}`);
  }

  const newer = models.filter(
    (m) => !pinnedIds.has(m.id) && m.released > newestPinnedDate,
  );

  console.log("\n  All live Claude models (newest first):");
  for (const m of models) {
    const mark = pinnedIds.has(m.id)
      ? " ← pinned"
      : m.released > newestPinnedDate
        ? " 🆕 newer than anything you use"
        : "";
    console.log(`    ${m.released}  ${m.id.padEnd(26)} ${m.name}${mark}`);
  }

  if (newer.length === 0) {
    console.log("\n  ✓ You're on the newest models. Nothing to do.\n");
  } else {
    console.log(
      `\n  🆕 ${newer.length} newer model(s) available. To upgrade a tier, change its\n` +
        "     one line in src/lib/ai-models.ts (CLAUDE.premium / .balanced / .cheap),\n" +
        "     then skim the migration notes before shipping:\n" +
        "     https://platform.claude.com/docs/en/about-claude/models/migration-guide\n",
    );
  }
}

main().catch((e) => {
  console.error("check-model-updates failed:", e?.message ?? e);
  process.exit(1);
});
