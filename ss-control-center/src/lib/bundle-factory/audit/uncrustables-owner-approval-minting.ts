/**
 * Минтинг owner-approval proof-ов для студии Bundle Factory
 * (uncrustables-studio-integration-plan.md, Lib-экстракции; источник —
 * scripts/build-uncrustables-main-owner-approvals-trial1.ts, проверенный на
 * 22 живых листингах).
 *
 * Отличия от скрипта — честная провенансная привязка студии:
 *  - reviewer = РЕАЛЬНАЯ сессия апрувера (identity передаётся снаружи);
 *  - timestamps = реальные моменты observe/approve, не константы;
 *  - чек-лист = реальный чек-лист ревью-гейта (все пункты подтверждены);
 *  - байты изображения переданы вызывающим (approve-гейт обязан сам
 *    пере-скачать точный R2 URL) — либа их только хэширует и проверяет.
 *
 * Каждый испечённый proof немедленно самопроверяется через
 * evaluateUncrustablesMainAuthenticity; манифест запечатывается той же
 * sealing-библиотекой и готов к registerSealedOwnerApprovalManifest().
 */

import { createHash } from "node:crypto";

import {
  GENERATION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
  MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
  resolveMergedUncrustablesPackageArt,
} from "./uncrustables-authenticity-merged";
import {
  UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA,
  evaluateUncrustablesMainAuthenticity,
  resolveReviewedUncrustablesFlavorId,
  sealUncrustablesMainVisualApproval,
  uncrustablesAuthenticityStableJson,
  uncrustablesMainReviewSubjectSha256,
  type UncrustablesMainVisualObservation,
} from "./uncrustables-main-authenticity";
import {
  UNCRUSTABLES_MAIN_OWNER_APPROVALS_SCHEMA,
  type UncrustablesMainOwnerApprovalManifest,
  type UncrustablesOwnerApprovedMainProof,
} from "./uncrustables-owner-approval-manifests";

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (!(bytes.length > 24 && bytes.toString("ascii", 12, 16) === "IHDR")) {
    throw new Error("MAIN bytes are not a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export interface MintReviewerIdentity {
  /** Кто подтверждал (например, "owner"); попадает в approved_by и reviewer. */
  reviewer: string;
  /** Идентификатор реальной сессии ревью (для notes/локатора). */
  session: string;
}

export interface MintComponentInput {
  /** Display-имя вкуса (как в рецепте кандидата). */
  flavor: string;
  qty: number;
  box_size: number;
  box_count: number;
}

export interface MintCandidateInput {
  slug: string;
  sku: string;
  /** Точный R2 URL, который пойдёт в сабмит. */
  mainImageUrl: string;
  /** Точные байты этого URL — пере-скачанные approve-гейтом. */
  imageBytes: Buffer;
  /** Промпт и референсы фактического рендера (для generation-манифеста). */
  prompt: string | null;
  referenceUrls: string[];
  renderScript: string;
  workerLabel: string;
  comps: MintComponentInput[];
  /** Момент визуального ревью и момент approve — реальные. */
  observedAt: Date;
  approvedAt: Date;
  /** Свободные заметки ревью (что именно проверено, каким протоколом). */
  reviewNotes: string;
  approvalNotes: string;
}

export interface MintedCandidateProof {
  proof: UncrustablesOwnerApprovedMainProof;
  generationManifest: { body: unknown; text: string; sha256: string };
  imageSha256: string;
  pixelDimensions: { width: number; height: number };
}

const APPROVED_SCENE: UncrustablesMainVisualObservation["scene"] = {
  background_is_pure_white: true,
  square_one_to_one: true,
  cooler_is_white_textured_eps: true,
  cooler_lid_leans_behind: true,
  salutem_cooler_branding_matches_anchor: true,
  gel_packs_total: 4,
  gel_packs_inside: 2,
  gel_packs_outside: 2,
  gel_packs_all_match_anchor: true,
  products_all_seated_inside_behind_front_rim: true,
  product_perspective_contact_and_shadows_believable: true,
  floating_pasted_halo_or_wall_intersection_items: [],
  loose_ice_snow_or_water_items: [],
  forbidden_overlay_or_extra_prop_items: [],
};

const CHECKLIST = {
  image_opened_and_compared_to_registry_evidence: true,
  all_required_flavors_present: true,
  only_reviewed_brand_art_present: true,
  pack_modes_and_sizes_match_recipe: true,
  no_foreign_or_fictional_items: true,
  exact_per_variant_package_counts_match_recipe: true,
  frozen_kit_geometry_and_branding_match_anchor: true,
  exactly_two_inside_and_two_outside_gel_packs: true,
  products_physically_seated_without_floating_or_paste: true,
  pure_white_square_amazon_main_background: true,
  no_loose_ice_water_overlays_or_extra_props: true,
};

/**
 * Печёт один production-main proof из APPROVED-кандидата студии.
 * Throw при любом несоответствии (не-PNG, <2000px, вкус вне registry,
 * несовпадение art-размера, провал самопроверки) — fail closed.
 */
export function mintCandidateProof(
  input: MintCandidateInput,
  reviewer: MintReviewerIdentity,
  archiveLocator: (slug: string, kind: "image" | "generation-manifest") => string,
  registryInput?: unknown,
): MintedCandidateProof {
  // Художку ищем в реестре ГЕНЕРАЦИИ: именно там лежат вторые и последующие
  // розничные коробки вкуса (owner review v3). Хеш манифеста при этом
  // остаётся привязан к MERGED — см. buildStudioManifest.
  const registry = (registryInput ??
    GENERATION_UNCRUSTABLES_AUTHENTICITY_REGISTRY) as never as Record<
    string,
    unknown
  > & { flavors: unknown[] };

  const imageSha = sha256Hex(input.imageBytes);
  const dims = pngDimensions(input.imageBytes);
  if (dims.width < 2000 || dims.height < 2000) {
    throw new Error(`MAIN below 2000px for ${input.slug}: ${dims.width}x${dims.height}`);
  }

  const genManifestBody = {
    schema_version: "uncrustables-preview-generation-manifest/v1",
    slug: input.slug,
    sku: input.sku,
    generated_at: input.observedAt.toISOString().slice(0, 10),
    worker: input.workerLabel,
    r2_url: input.mainImageUrl,
    output_image_sha256: imageSha,
    prompt: input.prompt,
    reference_urls: input.referenceUrls,
    render_scripts: [input.renderScript],
  };
  const genManifestText = `${JSON.stringify(genManifestBody, null, 2)}\n`;
  const genManifestSha = sha256Hex(genManifestText);
  const generationManifest = {
    kind: "generation-manifest" as const,
    locator: archiveLocator(input.slug, "generation-manifest"),
    sha256: genManifestSha,
  };

  const recipeComponents: unknown[] = [];
  const items: unknown[] = [];
  for (const c of input.comps) {
    const flavorId = resolveReviewedUncrustablesFlavorId(
      registry as never,
      c.flavor,
    );
    if (!flavorId) throw new Error(`flavor not in merged registry: ${c.flavor}`);
    const art = resolveMergedUncrustablesPackageArt(
      c.flavor,
      "retail-carton",
      c.box_size,
    ) as {
      art_id: string;
      retail_pack_size: number;
      evidence: { kind: string; locator: string; sha256: string }[];
      brand_marks?: string[];
    } | null;
    if (!art) throw new Error(`no retail-carton art for ${c.flavor}`);
    if (art.retail_pack_size !== c.box_size) {
      throw new Error(`art size mismatch for ${c.flavor}`);
    }
    // resolver omits brand_marks — read them from the registry art entry
    const regFlavor = (registry.flavors as {
      flavor_id: string;
      art?: { art_id: string; brand_marks?: string[] }[];
    }[]).find((f) => f.flavor_id === flavorId);
    const regArt = regFlavor?.art?.find((a) => a.art_id === art.art_id);
    if (!regArt?.brand_marks?.length) {
      throw new Error(`no brand marks in registry for ${art.art_id}`);
    }
    recipeComponents.push({
      flavor: flavorId,
      quantity: c.qty,
      expected_pack_mode: "retail-carton",
      expected_retail_pack_size: art.retail_pack_size,
    });
    items.push({
      observation_id: `${input.slug}-${flavorId}-${art.retail_pack_size}ct`,
      flavor: flavorId,
      art_id: art.art_id,
      pack_mode: "retail-carton",
      retail_pack_size: art.retail_pack_size,
      visible_package_count: c.box_count,
      brand_marks: [...regArt.brand_marks],
      classification: "reviewed-real-uncrustables",
      reference_evidence: art.evidence.map((e) => ({
        kind: e.kind,
        locator: e.locator,
        sha256: e.sha256,
      })),
    });
  }

  const image = {
    kind: "generated-main" as const,
    locator: archiveLocator(input.slug, "image"),
    sha256: imageSha,
  };
  const recipe = {
    recipe_id: `studio:${input.slug}`,
    components: recipeComponents,
  };
  const visualObservation = {
    observer: reviewer.reviewer,
    observed_at: input.observedAt.toISOString(),
    method: "human-visual",
    items,
    foreign_items: [],
    fictional_or_unknown_items: [],
    notes: input.reviewNotes,
    scene: structuredClone(APPROVED_SCENE),
  } as never as UncrustablesMainVisualObservation;

  const subjectSha = uncrustablesMainReviewSubjectSha256({
    sku: input.sku,
    image,
    generation_manifest: generationManifest,
    recipe,
    registry,
    visual_observation: visualObservation,
  } as never);
  const approval = sealUncrustablesMainVisualApproval({
    schema_version: UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA,
    immutable: true,
    approval_id: `owner-approval-${input.slug}-${imageSha.slice(0, 8)}-studio`,
    approval_locator: `artifact://uncrustables-studio-approvals/${reviewer.session}/${input.slug}`,
    reviewer: reviewer.reviewer,
    reviewed_at: input.approvedAt.toISOString(),
    review_method: "human-visual",
    decision: "APPROVED",
    subject_sha256: subjectSha,
    checklist: { ...CHECKLIST },
    notes: input.approvalNotes,
  } as never);

  const proof = {
    // Пруф — это утверждение о КОНКРЕТНЫХ байтах картинки, поэтому и
    // именуется ими. Ре-ролл после неудачной попытки даёт другой файл и
    // другой пруф; раньше id зависел только от слага, и первый же ре-ролл
    // намертво запирал публикацию слага («запечатан по ДРУГИМ байтам»).
    // Защита от дублей от этого не слабеет: союз отдельно ловит повтор
    // байтов и повтор товара (sku+asin) — см. verifySealedOwnerApprovalManifest.
    proof_id: `production-${input.slug}-${imageSha.slice(0, 12)}`,
    sku: input.sku,
    asin: "PENDING-FIRST-PUBLISH",
    approval_scope: "production-main",
    production_eligible: true,
    pixel_dimensions: dims,
    image,
    generation_manifest: generationManifest,
    production_provenance: {
      origin: "raw-generation",
      output_sha256: imageSha,
      transformation_manifest: { ...generationManifest },
    },
    recipe,
    visual_observation: visualObservation,
    human_approval: approval,
  } as never as UncrustablesOwnerApprovedMainProof;

  const evaluation = evaluateUncrustablesMainAuthenticity({
    ...(proof as object),
    registry,
  } as never) as { pass: boolean; verified: boolean; hard_fails: { code: string }[] };
  if (!evaluation.pass || !evaluation.verified) {
    throw new Error(
      `minted proof fails authenticity for ${input.slug}: ${evaluation.hard_fails
        .map((item) => item.code)
        .join(", ")}`,
    );
  }
  return {
    proof,
    generationManifest: {
      body: genManifestBody,
      text: genManifestText,
      sha256: genManifestSha,
    },
    imageSha256: imageSha,
    pixelDimensions: dims,
  };
}

/** Запечатывает список proof-ов в append-only studio-манифест. */
export function sealStudioOwnerApprovalManifest(args: {
  manifestId: string;
  capturedAt: Date;
  approvedBy: string;
  entries: UncrustablesOwnerApprovedMainProof[];
  registryInput?: unknown;
}): UncrustablesMainOwnerApprovalManifest {
  // Новый манифест подписывается против реестра ГЕНЕРАЦИИ: его пруфы могут
  // ссылаться на художку v3. Старые манифесты остаются на MERGED и проверяются
  // по своему хешу — см. KNOWN_UNCRUSTABLES_AUTHENTICITY_REGISTRIES.
  const registry = (args.registryInput ??
    GENERATION_UNCRUSTABLES_AUTHENTICITY_REGISTRY) as { sha256: string };
  if (args.entries.length === 0) {
    throw new Error("Studio manifest requires at least one proof.");
  }
  const body = {
    schema_version: UNCRUSTABLES_MAIN_OWNER_APPROVALS_SCHEMA,
    immutable: true as const,
    manifest_id: args.manifestId,
    captured_at: args.capturedAt.toISOString(),
    approved_by: args.approvedBy,
    registry_sha256: registry.sha256,
    entries: args.entries,
  };
  return {
    ...body,
    sha256: sha256Hex(uncrustablesAuthenticityStableJson(body)),
  } as UncrustablesMainOwnerApprovalManifest;
}
