/**
 * Build the ADDITIVE authenticity-registry extension from the owner's gallery
 * approvals (2026-07-21/22): 10 flavors approved via the interactive review
 * gallery; evidence = the exact retailer image bytes shown there, archived
 * under data/audits/uncrustables-approved-reference-gallery-20260722/.
 *
 * DELIBERATELY A SEPARATE FILE, NOT A REPLACEMENT: the sealed MAIN-approvals
 * manifest (uncrustables-main-owner-approvals-v2.json) binds registry v1's
 * SHA-256 (preflight :183), and its per-SKU approval subjects embed that hash —
 * replacing v1 would orphan Codex's sealed approvals. Resolution consults v1
 * first, then this extension (see resolveMergedUncrustablesPackageArt).
 *
 * The output is validated with the engine's own verifyUncrustablesAuthenticityRegistry
 * plus a cross-file alias-ambiguity check against v1 BEFORE writing. Raspberry
 * (№3) is excluded until the owner verdicts the replacement photo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  uncrustablesAuthenticitySha256,
  uncrustablesAuthenticityStableJson,
  verifyUncrustablesAuthenticityRegistry,
} from "../src/lib/bundle-factory/audit/uncrustables-main-authenticity";
import { PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY } from "../src/lib/bundle-factory/audit/uncrustables-main-production-preflight";

const INPUT = "data/audits/uncrustables-approved-reference-gallery-20260722/approved-input.json";
const OUT = "src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v2-extension.json";
const PENDING = new Set<string>(); // 2026-07-22: owner approved all 11 incl. raspberry (clean 4ct carton)

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[®™]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface ApprovedInput {
  n: number;
  label: string;
  donor_title: string | null;
  upc: string | null;
  file: string;
  sha256: string;
  pack_size: number;
}

function main(): void {
  const input = (JSON.parse(readFileSync(INPUT, "utf8")) as ApprovedInput[]).filter(
    (i) => !PENDING.has(i.label),
  );
  const flavors = input.map((i) => {
    const flavorId = normalizeLabel(i.label).replace(/ /g, "-");
    // Aliases must cover every name the system actually shows: the gallery
    // label, the source donor title, AND the engine's dedupe labels, which
    // carry a brand prefix when the catalog's brand column is inconsistent
    // ("Smuckers Peanut Butter & Grape Jelly"). Ambiguity across the merged
    // registry is rejected by the verifier, so prophylactic aliases are safe.
    const aliases = Array.from(
      new Set([
        i.label,
        `Smuckers ${i.label}`,
        `Smucker's ${i.label}`,
        `Smuckers Uncrustables ${i.label}`,
        ...(i.donor_title ? [i.donor_title.trim()] : []),
      ]),
    );
    return {
      flavor_id: flavorId,
      display_name: i.label,
      aliases,
      art: [
        {
          art_id: `${flavorId}-carton-us-${i.pack_size}ct-2026-v2`,
          pack_mode: "retail-carton",
          retail_pack_size: i.pack_size,
          market: "US",
          brand_marks: ["Smucker's", "Uncrustables"],
          evidence: [
            { kind: "reviewed-artifact", locator: i.file, sha256: i.sha256 },
          ],
        },
      ],
    };
  });

  const body = {
    schema_version: "uncrustables-authenticity-registry/v1",
    immutable: true,
    registry_id: "uncrustables-us-reviewed-package-art-2026-07-22-v2-extension",
    reviewed_at: "2026-07-22T00:00:00.000Z",
    reviewed_by: "owner",
    review_method: "human-visual-with-source-evidence",
    brand: {
      product_brand: "Uncrustables",
      owner: "The J.M. Smucker Company",
      market: "US",
      allowed_marks: ["Smucker's", "Uncrustables"],
    },
    flavors,
  };
  const registry = { ...body, sha256: uncrustablesAuthenticitySha256(uncrustablesAuthenticityStableJson(body)) };

  // ACCEPTANCE GATE = the engine's validator run on the MERGE of v1 + this
  // extension (the same merge the runtime resolver uses). This is strictly
  // stronger than validating the extension alone: the verifier itself checks
  // cross-file alias ambiguity, duplicate art ids, and the both-pack-modes
  // invariant (the wrapper art lives in v1).
  const v1 = PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY as unknown as Record<string, unknown> & {
    flavors: unknown[];
  };
  const mergedBody = {
    schema_version: "uncrustables-authenticity-registry/v1",
    immutable: true,
    registry_id: "uncrustables-us-reviewed-package-art-merged-v1-plus-v2ext",
    reviewed_at: body.reviewed_at,
    reviewed_by: "owner",
    review_method: "human-visual-with-source-evidence",
    brand: body.brand,
    flavors: [...v1.flavors, ...flavors],
  };
  const merged = {
    ...mergedBody,
    sha256: uncrustablesAuthenticitySha256(uncrustablesAuthenticityStableJson(mergedBody)),
  };
  verifyUncrustablesAuthenticityRegistry(merged as never);

  const serialized = `${JSON.stringify(registry, null, 1)}\n`;
  writeFileSync(OUT, serialized);
  writeFileSync(`${OUT}.sha256`, `${uncrustablesAuthenticitySha256(Buffer.from(serialized))}\n`);
  console.log(`flavors: ${flavors.length} (raspberry pending owner re-verdict)`);
  console.log(`registry sha256: ${registry.sha256}`);
  console.log(`written: ${OUT}`);
}

main();
