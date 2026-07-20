/**
 * Materialize the owner's EXPLICIT verbal approval (Vladimir, chat 2026-07-19:
 * «Да, делай изменения везде… Меняй крон, меняй настройки в Channel Max. Всё,
 * что угодно можешь делать. Мне важно, чтобы наши листинги имели правильные
 * настройки и в Amazon, и в ChannelMax.») into the exact sealed
 * BaseOfferLiveAuthorization artifact the sealed executor requires.
 *
 * This script creates NOTHING beyond what the owner already authorized in that
 * message: the base-offer preserve patch (price/min/max/B2B to canon; sale
 * prices and list_price structurally untouched). It validates the artifact with
 * the engine's own assertBaseOfferLiveAuthorization against the freshly
 * captured snapshot + binding before writing, so a drifted/stale input fails
 * closed here rather than at apply time.
 *
 * Usage:
 *   npx tsx scripts/author-uncrustables-base-offer-authorization.ts \
 *     --live-selection=PATH --snapshot=PATH --rollback-binding=PATH \
 *     --output=PATH [--ttl-minutes=12]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  sha256,
  stableJson,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import {
  BASE_OFFER_LIVE_AUTHORIZATION_SCHEMA,
  assertBaseOfferLiveAuthorization,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-live-contract";
import { getMerchantToken } from "../src/lib/amazon-sp-api/sellers";

const PLAN_PATH =
  "data/repairs/base-offer-preserve/uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-plan.json";
const FULL_SELECTION_PATH =
  "data/repairs/base-offer-preserve/uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-selection.json";

interface Options {
  liveSelection: string | null;
  snapshot: string | null;
  rollbackBinding: string | null;
  output: string | null;
  ttlMinutes: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    liveSelection: null,
    snapshot: null,
    rollbackBinding: null,
    output: null,
    ttlMinutes: 12,
  };
  for (const arg of argv) {
    if (arg.startsWith("--live-selection=")) options.liveSelection = arg.slice(17).trim();
    else if (arg.startsWith("--snapshot=")) options.snapshot = arg.slice(11).trim();
    else if (arg.startsWith("--rollback-binding=")) options.rollbackBinding = arg.slice(19).trim();
    else if (arg.startsWith("--output=")) options.output = arg.slice(9).trim();
    else if (arg.startsWith("--ttl-minutes=")) options.ttlMinutes = Number(arg.slice(14));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.liveSelection || !options.snapshot || !options.rollbackBinding || !options.output) {
    throw new Error("--live-selection, --snapshot, --rollback-binding and --output are required.");
  }
  if (!Number.isFinite(options.ttlMinutes) || options.ttlMinutes <= 0 || options.ttlMinutes > 15) {
    throw new Error("--ttl-minutes must be within (0, 15].");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [planBytes, fullBytes, liveBytes, bindingBytes, snapshotBytes] = await Promise.all([
    readFile(PLAN_PATH),
    readFile(FULL_SELECTION_PATH),
    readFile(options.liveSelection!),
    readFile(options.rollbackBinding!),
    readFile(options.snapshot!),
  ]);
  const plan = JSON.parse(planBytes.toString("utf8"));
  const fullSelection = JSON.parse(fullBytes.toString("utf8"));
  const liveSelection = JSON.parse(liveBytes.toString("utf8"));
  const rollbackBinding = JSON.parse(bindingBytes.toString("utf8"));
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));

  const merchantId = await getMerchantToken(1);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + options.ttlMinutes * 60 * 1000);

  const body = {
    schema_version: BASE_OFFER_LIVE_AUTHORIZATION_SCHEMA,
    profile: "AMAZON_BASE_OFFER_PRESERVE_PROMO_V1" as const,
    immutable: true as const,
    authorization_id:
      `UBOLA-${createdAt.toISOString().replace(/[-:.]/g, "")}-` +
      sha256(stableJson(liveSelection.selected_action_ids)).slice(0, 12),
    owner_approved: true as const,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    permit: "APPLY_AMAZON_BASE_OFFER_PRESERVE_PROMO_V1" as const,
    source_plan_body_sha256: plan.body_sha256,
    source_full_selection_body_sha256: fullSelection.body_sha256,
    source_live_selection_body_sha256: liveSelection.body_sha256,
    source_rollback_binding_body_sha256: rollbackBinding.body_sha256,
    snapshot_file_sha256: rollbackBinding.snapshot.file_sha256,
    snapshot_body_sha256: rollbackBinding.snapshot.body_sha256,
    selected_action_ids: liveSelection.selected_action_ids,
    account: {
      store_index: 1,
      marketplace_id: "ATVPDKIKX0DER" as const,
      amazon_merchant_id: merchantId,
    },
    constraints: {
      exact_patch_path: "/attributes/purchasable_offer" as const,
      discounted_price_action_authorized: false as const,
      list_price_action_authorized: false as const,
      sales_price_action_authorized: false as const,
      coupon_action_authorized: false as const,
      one_patch_attempt_per_action: true as const,
      stable_readback_required: true as const,
    },
  };
  const authorization = { ...body, body_sha256: sha256(stableJson(body)) };

  // Fail closed HERE if anything is stale or differently bound.
  assertBaseOfferLiveAuthorization({
    plan,
    fullSelection,
    liveSelection,
    rollbackBinding,
    authorization,
    snapshot,
    snapshotBytes,
  });

  await mkdir(dirname(options.output!), { recursive: true });
  const serialized = `${JSON.stringify(authorization, null, 2)}\n`;
  await writeFile(options.output!, serialized, { flag: "wx" });
  await writeFile(`${options.output!}.sha256`, `${sha256(Buffer.from(serialized))}\n`, { flag: "wx" });
  await writeFile(
    options.output!.replace(/\.json$/, ".approval-note.md"),
    [
      "# Owner approval provenance",
      "",
      `- Authorization: ${authorization.authorization_id}`,
      `- Created: ${authorization.created_at} (TTL ${options.ttlMinutes}m)`,
      `- Selection: ${liveSelection.selection_id} (${liveSelection.selected_actions} action(s), kind ${liveSelection.kind})`,
      "- Owner instruction (Vladimir, chat 2026-07-19, verbatim):",
      "  «Да, делай изменения везде таким образом, чтобы наши листинги были с",
      "  корректными ценами. Меняй крон, меняй настройки в Channel Max. Все, что",
      "  угодно можешь делать. Мне важно, чтобы наши листинги имели правильные",
      "  настройки и в Amazon, и в Channel Max.»",
      "- Scope covered by this artifact: Amazon base-offer preserve patch only",
      "  (ALL our_price / min / max + B2B our_price to canonical 70%-ROI model;",
      "  sale prices and list_price structurally preserved).",
      "",
    ].join("\n"),
    { flag: "wx" },
  );
  console.log(`authorization: ${authorization.authorization_id}`);
  console.log(`expires_at:    ${authorization.expires_at}`);
  console.log(`written:       ${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
