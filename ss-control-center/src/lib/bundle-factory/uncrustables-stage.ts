/**
 * Stage-последовательность Uncrustables-конвейера как библиотека
 * (uncrustables-studio-integration-plan.md, Lib-экстракции; источник —
 * проверенный на 22 живых листингах scripts/_publish_batch12_stage1.ts).
 *
 * ОДИН кандидат: GenerationJob → BundleDraft (draft_components с
 * официальными аллергенами/ингредиентами) → GeneratedContent → РЕАЛЬНЫЙ
 * runComplianceGate → promoteDraftToChannelSkus (SKU mint + UPC claim) →
 * operator ship-specs (канонические band-ы) → operator-declared inventory.
 *
 * Ничего не рендерит и не сабмитит: марketplace-запись создаёт submit-этап
 * за пермитом preflight-а. Все внешние эффекты — через deps (тестируемо).
 */

import {
  allergensFor,
  INGREDIENTS,
  UPC_OVERRIDES,
} from "./uncrustables-official-ingredients";
import { shipSpecBandFor } from "./uncrustables-ship-specs";

export const DEFAULT_OPERATOR_DECLARED_QTY = 10;

export interface UncrustablesStageComponentInput {
  flavor: string;
  qty: number;
  donor_title: string | null;
}

export interface UncrustablesStageCandidateInput {
  slug: string;
  title: string;
  bullets: string[];
  description: string;
  /** Точный R2 MAIN, уже прошедший human APPROVE gate. */
  mainImageUrl: string;
  packCount: number;
  costCents: number | null;
  comps: UncrustablesStageComponentInput[];
  /** brief.source в GenerationJob (у студии — свой маркер). */
  briefSource: string;
  ownerOrder: string;
  actor: string;
  operatorDeclaredQty?: number;
}

export interface StagedChannelSku {
  channel_sku_id: string;
  sku: string;
  upc: string;
  price_cents: number;
}

export type UncrustablesStageResult =
  | {
      ok: true;
      draftId: string;
      masterBundleId: string;
      skus: StagedChannelSku[];
    }
  | {
      ok: false;
      stage: "INPUT" | "DONOR" | "COMPLIANCE" | "PROMOTE";
      error: string;
      draftId?: string;
      blockedRuleIds?: string[];
    };

/** Ровно то подмножество Prisma, которое использует stage-последовательность. */
export interface UncrustablesStagePrisma {
  donorProduct: {
    findFirst(args: unknown): Promise<{
      id: string;
      title: string;
      upc: string | null;
      mainImageUrl: string | null;
      offers: unknown[];
    } | null>;
  };
  generationJob: { create(args: unknown): Promise<{ id: string }> };
  bundleDraft: {
    create(args: unknown): Promise<{ id: string }>;
    findUnique(args: unknown): Promise<{ master_bundle_id: string | null } | null>;
  };
  generatedContent: {
    create(args: unknown): Promise<{ id: string }>;
    update(args: unknown): Promise<unknown>;
  };
  masterBundle: {
    findUnique(args: unknown): Promise<{ packaging_spec: unknown } | null>;
    update(args: unknown): Promise<unknown>;
  };
  channelSKU: {
    findMany(args: unknown): Promise<
      { id: string; sku: string; upc: string; price_cents: number }[]
    >;
    update(args: unknown): Promise<unknown>;
  };
}

export interface UncrustablesStageDeps {
  prisma: UncrustablesStagePrisma;
  donorUnitPriceCents: (donor: unknown) => number | null | undefined;
  runComplianceGate: (
    payload: unknown,
    options: { actor: string },
  ) => Promise<{
    decision: string;
    compliance_check_id?: string | null;
    rules: { rule_id: string; passed: boolean }[];
  }>;
  promoteDraftToChannelSkus: (draftId: string) => Promise<unknown>;
  withVerifiedPhysicalPackageSpecs: (
    existingSpec: unknown,
    band: unknown,
  ) => unknown;
  now?: () => Date;
}

const R2_MAIN_PATTERN = /^https:\/\/[^@]*\.r2\.dev\//;

/** Прогоняет одного кандидата через полную stage-последовательность. */
export async function stageUncrustablesCandidate(
  input: UncrustablesStageCandidateInput,
  deps: UncrustablesStageDeps,
): Promise<UncrustablesStageResult> {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());
  const qtyDeclared = input.operatorDeclaredQty ?? DEFAULT_OPERATOR_DECLARED_QTY;

  if (!R2_MAIN_PATTERN.test(input.mainImageUrl)) {
    return {
      ok: false,
      stage: "INPUT",
      error: `MAIN не на credential-free R2: ${input.mainImageUrl}`,
    };
  }
  if (
    !Number.isInteger(input.packCount) ||
    input.packCount <= 0 ||
    input.comps.length === 0 ||
    input.comps.reduce((sum, c) => sum + c.qty, 0) !== input.packCount
  ) {
    return {
      ok: false,
      stage: "INPUT",
      error: "packCount не равен сумме компонентов или состав пуст.",
    };
  }

  // ---- components: донор по точному title, manufacturer UPC, unit price,
  // официальные ингредиенты и аллергены.
  const components: Record<string, unknown>[] = [];
  for (const c of input.comps) {
    const donor = await prisma.donorProduct.findFirst({
      where: { title: c.donor_title ?? "___none___" },
      select: {
        id: true,
        title: true,
        upc: true,
        mainImageUrl: true,
        bestPrice: true,
        offers: {
          where: { isFirstParty: true, via: "direct", price: { gt: 0 } },
          select: { price: true, packSizeSeen: true, pricePerUnit: true },
        },
      },
    });
    if (!donor) {
      return {
        ok: false,
        stage: "DONOR",
        error: `донор не найден: ${c.donor_title}`,
      };
    }
    const upc = donor.upc?.trim() || UPC_OVERRIDES[c.flavor];
    if (!upc) {
      return {
        ok: false,
        stage: "DONOR",
        error: `нет manufacturer UPC: ${c.flavor}`,
      };
    }
    const unit = deps.donorUnitPriceCents(donor) ?? null;
    if (!unit || !Number.isInteger(unit) || unit <= 0) {
      return { ok: false, stage: "DONOR", error: `нет unit price: ${c.flavor}` };
    }
    components.push({
      research_pool_id: donor.id,
      product_name: c.flavor,
      brand: "Uncrustables",
      flavor: c.flavor,
      manufacturer_upc: upc,
      qty: c.qty,
      unit_price_cents: unit,
      ingredients: INGREDIENTS[c.flavor],
      allergen_declaration: allergensFor(c.flavor),
      donor_image_urls: donor.mainImageUrl ? [donor.mainImageUrl] : [],
    });
  }

  // ---- job + draft + content
  const job = await prisma.generationJob.create({
    data: {
      brief: JSON.stringify({
        source: input.briefSource,
        owner_order: input.ownerOrder,
        slug: input.slug,
      }),
      bundles_target: 1,
      current_stage: "CONTENT",
      status: "RUNNING",
      notes: `Uncrustables stage lib, actor=${input.actor}`,
    },
  });
  const draft = await prisma.bundleDraft.create({
    data: {
      generation_job_id: job.id,
      draft_name: input.title,
      brand: "Uncrustables",
      category: "FROZEN_GROCERY",
      composition_type:
        input.comps.length > 1 ? "MIXED_FLAVOR" : "SINGLE_FLAVOR",
      pack_count: input.packCount,
      draft_components: JSON.stringify(components),
      draft_main_image_url: input.mainImageUrl,
      draft_cost_cents: input.costCents,
      status: "GENERATED",
      approved_at: now(),
      approved_by: "owner",
      target_channels: JSON.stringify(["AMAZON_SALUTEM"]),
    },
  });
  const content = await prisma.generatedContent.create({
    data: {
      bundle_draft_id: draft.id,
      channel: "AMAZON_SALUTEM",
      template: "amazon",
      title: input.title,
      bullets_json: JSON.stringify(input.bullets),
      description: input.description,
      main_image_url: input.mainImageUrl,
    },
  });

  // ---- реальный compliance gate
  const decision = await deps.runComplianceGate(
    {
      bundle_draft_id: draft.id,
      title: input.title,
      brand: "Uncrustables",
      bullets: [...input.bullets],
      description: input.description,
      main_image_url: input.mainImageUrl,
      bundle_components: input.comps.map((c) => ({
        brand: "Uncrustables",
        product_name: c.flavor,
      })),
    },
    { actor: input.actor },
  );
  if (decision.decision !== "CAN_PUBLISH") {
    return {
      ok: false,
      stage: "COMPLIANCE",
      error: "compliance gate BLOCKED",
      draftId: draft.id,
      blockedRuleIds: decision.rules
        .filter((r) => !r.passed)
        .map((r) => r.rule_id),
    };
  }
  await prisma.generatedContent.update({
    where: { id: content.id },
    data: {
      compliance_status: "CAN_PUBLISH",
      compliance_check_id: decision.compliance_check_id ?? null,
    },
  });

  // ---- promote: MasterBundle + BundleComponents + ChannelSKU
  await deps.promoteDraftToChannelSkus(draft.id);
  const fresh = await prisma.bundleDraft.findUnique({
    where: { id: draft.id },
    select: { master_bundle_id: true },
  });
  const masterBundleId = fresh?.master_bundle_id;
  if (!masterBundleId) {
    return {
      ok: false,
      stage: "PROMOTE",
      error: "promote не создал master bundle",
      draftId: draft.id,
    };
  }

  // ---- operator ship-specs (канонический band) + operator-declared qty
  const band = shipSpecBandFor(input.packCount);
  const mb = await prisma.masterBundle.findUnique({
    where: { id: masterBundleId },
    select: { packaging_spec: true },
  });
  const spec = deps.withVerifiedPhysicalPackageSpecs(
    mb?.packaging_spec ?? null,
    band,
  );
  await prisma.masterBundle.update({
    where: { id: masterBundleId },
    data: { packaging_spec: spec, total_weight_oz: band.weight_oz },
  });
  const skus = await prisma.channelSKU.findMany({
    where: { master_bundle_id: masterBundleId },
    select: { id: true, sku: true, upc: true, price_cents: true, title: true },
  });
  const staged: StagedChannelSku[] = [];
  for (const s of skus) {
    await prisma.channelSKU.update({
      where: { id: s.id },
      data: {
        package_length_in: band.length_in,
        package_width_in: band.width_in,
        package_height_in: band.height_in,
        package_weight_oz: band.weight_oz,
        available_quantity: qtyDeclared,
        inventory_checked_at: now(),
      },
    });
    staged.push({
      channel_sku_id: s.id,
      sku: s.sku,
      upc: s.upc,
      price_cents: s.price_cents,
    });
  }
  return { ok: true, draftId: draft.id, masterBundleId, skus: staged };
}
