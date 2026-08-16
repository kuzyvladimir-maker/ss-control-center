/**
 * Union loader for sealed Uncrustables owner-approval manifests
 * (uncrustables-studio-integration-plan.md, решение 4).
 *
 * Источники объединения:
 *  - статические repo-манифесты (v3 batch 1+2, trial1, будущие экспорты) —
 *    компилируются в бандл и есть всегда;
 *  - динамически зарегистрированные sealed-манифесты (Phase A: DB-записи
 *    `UncrustablesOwnerApprovalManifestRecord`, читаемые студией) —
 *    добавляются через registerSealedOwnerApprovalManifest() ПОСЛЕ полной
 *    верификации.
 *
 * КАЖДЫЙ манифест союза проходит идентичный полный набор проверок
 * (schema/immutable/SHA-seal/registry binding/per-proof authenticity), а
 * proof_id и review-subject уникальны ЧЕРЕЗ ВСЕ манифесты. Один битый
 * манифест — throw, публикация закрыта целиком: fail closed.
 */

import approvalsV3Json from "./data/uncrustables-main-owner-approvals-v3.json";
import trialApprovalsJson from "./data/uncrustables-main-owner-approvals-trial1.json";

import { KNOWN_UNCRUSTABLES_AUTHENTICITY_REGISTRIES,
  MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY } from "./uncrustables-authenticity-merged";
import {
  evaluateUncrustablesMainAuthenticity,
  uncrustablesAuthenticitySha256,
  uncrustablesAuthenticityStableJson,
  verifyUncrustablesAuthenticityRegistry,
  type UncrustablesAuthenticityRegistry,
  type UncrustablesMainAuthenticityInput,
} from "./uncrustables-main-authenticity";

export const UNCRUSTABLES_MAIN_OWNER_APPROVALS_SCHEMA =
  "uncrustables-main-owner-approvals/v2" as const;

export interface UncrustablesOwnerApprovedMainProof
  extends Omit<UncrustablesMainAuthenticityInput, "registry"> {
  proof_id: string;
  asin: string;
  approval_scope: "style-reference-only" | "production-main";
  production_eligible: boolean;
  pixel_dimensions: { width: number; height: number };
  /** Required for production-main. A transformed image is a different asset
   * and must identify both its input and exact output bytes. */
  production_provenance?: {
    origin: "raw-generation" | "derived-artifact";
    output_sha256: string;
    source_image_sha256?: string;
    transformation_manifest: {
      kind: "generation-manifest";
      locator: string;
      sha256: string;
    };
  };
  human_approval: NonNullable<
    UncrustablesMainAuthenticityInput["human_approval"]
  >;
}

export interface UncrustablesMainOwnerApprovalManifestBody {
  schema_version: typeof UNCRUSTABLES_MAIN_OWNER_APPROVALS_SCHEMA;
  immutable: true;
  manifest_id: string;
  captured_at: string;
  approved_by: string;
  registry_sha256: string;
  entries: UncrustablesOwnerApprovedMainProof[];
}

export interface UncrustablesMainOwnerApprovalManifest
  extends UncrustablesMainOwnerApprovalManifestBody {
  sha256: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function digestObject(value: unknown): string {
  return uncrustablesAuthenticitySha256(
    uncrustablesAuthenticityStableJson(value),
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Статическая часть союза: sealed repo-манифесты, порядок = порядок выпуска. */
export const STATIC_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS = [
  approvalsV3Json,
  trialApprovalsJson,
] as unknown as UncrustablesMainOwnerApprovalManifest[];

/** Динамически зарегистрированные sealed-манифесты (DB-записи студии). */
const registeredManifests: UncrustablesMainOwnerApprovalManifest[] = [];

/** Полный союз: статические + зарегистрированные, в порядке добавления. */
export function unionUncrustablesOwnerApprovalManifests(): UncrustablesMainOwnerApprovalManifest[] {
  return [
    ...STATIC_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS,
    ...registeredManifests,
  ];
}

/**
 * Верифицирует ОДИН манифест против registry и НАКАПЛИВАЕМЫХ уникальностей.
 * Мутирует переданные множества (это и обеспечивает кросс-манифестную
 * уникальность при обходе союза). Throw при любом дрейфе.
 */
export function verifySealedOwnerApprovalManifest(
  manifest: UncrustablesMainOwnerApprovalManifest,
  registry: UncrustablesAuthenticityRegistry,
  proofIds: Set<string>,
  approvedSubjects: Set<string>,
): void {
  if (
    manifest.schema_version !== UNCRUSTABLES_MAIN_OWNER_APPROVALS_SCHEMA ||
    manifest.immutable !== true ||
    !nonEmpty(manifest.manifest_id) ||
    !nonEmpty(manifest.approved_by) ||
    !nonEmpty(manifest.captured_at) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    !SHA256_PATTERN.test(manifest.sha256)
  ) {
    throw new Error("Owner-approval manifest is incomplete or unsupported.");
  }
  const { sha256: claimedManifestSha, ...manifestBody } = manifest;
  if (claimedManifestSha.toLowerCase() !== digestObject(manifestBody)) {
    throw new Error("Owner-approval manifest SHA-256 seal does not match.");
  }
  // Манифест сам называет реестр, против которого он подписан. Ищем его среди
  // известных: MERGED (подписанная история) и GENERATION (после owner-ревью
  // дополнительных розничных коробок). Неизвестный хеш — отказ.
  const boundRegistry =
    registry.sha256.toLowerCase() === manifest.registry_sha256.toLowerCase()
      ? registry
      : KNOWN_UNCRUSTABLES_AUTHENTICITY_REGISTRIES.find(
          (candidate) =>
            candidate.sha256.toLowerCase() === manifest.registry_sha256.toLowerCase(),
        );
  if (!boundRegistry) {
    throw new Error("Owner-approval manifest is bound to another registry.");
  }

  for (const proof of manifest.entries) {
    if (
      !nonEmpty(proof.proof_id) ||
      !nonEmpty(proof.sku) ||
      !nonEmpty(proof.asin) ||
      proof.image?.kind !== "generated-main" ||
      !SHA256_PATTERN.test(proof.image?.sha256 ?? "") ||
      proof.generation_manifest?.kind !== "generation-manifest" ||
      !SHA256_PATTERN.test(proof.generation_manifest?.sha256 ?? "") ||
      !Number.isInteger(proof.pixel_dimensions?.width) ||
      !Number.isInteger(proof.pixel_dimensions?.height) ||
      proof.pixel_dimensions.width <= 0 ||
      proof.pixel_dimensions.height <= 0 ||
      !proof.human_approval
    ) {
      throw new Error("Owner-approval manifest contains an incomplete proof.");
    }
    if (proofIds.has(proof.proof_id)) {
      throw new Error(`Duplicate owner-approved proof_id: ${proof.proof_id}.`);
    }
    proofIds.add(proof.proof_id);
    // Пруф адресуется байтами, поэтому совпадения id уже мало: главный дубль,
    // который надо ловить, — ДВА одобрения на один и тот же товар. Байтовый
    // страж здесь намеренно не ставится: архивные фикстуры законно
    // переиспользуют один файл на несколько слагов.
    const subjectKey = `subject:${proof.sku.toLowerCase()}|${proof.asin.toLowerCase()}`;
    if (proofIds.has(subjectKey)) {
      throw new Error(`Duplicate owner-approved listing: ${proof.sku} / ${proof.asin}.`);
    }
    proofIds.add(subjectKey);
    if (approvedSubjects.has(proof.human_approval.subject_sha256.toLowerCase())) {
      throw new Error("Two owner-approved proofs reuse the same review subject.");
    }
    approvedSubjects.add(proof.human_approval.subject_sha256.toLowerCase());
    if (
      proof.human_approval.reviewer !== manifest.approved_by ||
      proof.human_approval.decision !== "APPROVED"
    ) {
      throw new Error(`Proof ${proof.proof_id} lacks the declared owner approval.`);
    }
    if (proof.approval_scope === "style-reference-only") {
      if (proof.production_eligible !== false || proof.production_provenance) {
        throw new Error(
          `Style proof ${proof.proof_id} must not authorize production bytes.`,
        );
      }
    } else if (proof.approval_scope === "production-main") {
      const provenance = proof.production_provenance;
      if (
        proof.production_eligible !== true ||
        proof.pixel_dimensions.width < 2000 ||
        proof.pixel_dimensions.height < 2000 ||
        !provenance ||
        (provenance.origin !== "raw-generation" &&
          provenance.origin !== "derived-artifact") ||
        provenance.output_sha256.toLowerCase() !== proof.image.sha256.toLowerCase() ||
        provenance.transformation_manifest?.kind !== "generation-manifest" ||
        !nonEmpty(provenance.transformation_manifest.locator) ||
        !SHA256_PATTERN.test(provenance.transformation_manifest.sha256) ||
        (provenance.origin === "derived-artifact" &&
          (!SHA256_PATTERN.test(provenance.source_image_sha256 ?? "") ||
            provenance.source_image_sha256?.toLowerCase() ===
              proof.image.sha256.toLowerCase()))
      ) {
        throw new Error(
          `Production proof ${proof.proof_id} lacks 2000px+ exact derived/generation provenance.`,
        );
      }
    } else {
      throw new Error(`Proof ${proof.proof_id} has an unknown approval scope.`);
    }
    const result = evaluateUncrustablesMainAuthenticity({
      ...proof,
      registry: boundRegistry,
    });
    if (!result.pass || !result.verified) {
      throw new Error(
        `Production proof ${proof.proof_id} fails authenticity: ${result.hard_fails
          .map((item) => item.code)
          .join(", ")}.`,
      );
    }
  }
}

/**
 * Верифицирует ВЕСЬ союз (registry + каждый манифест + кросс-манифестная
 * уникальность proof_id/subject). Throw при любом дрейфе — fail closed.
 */
export function verifyUncrustablesOwnerApprovalManifestUnion(
  registry: UncrustablesAuthenticityRegistry = MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY as unknown as UncrustablesAuthenticityRegistry,
  manifests: UncrustablesMainOwnerApprovalManifest[] = unionUncrustablesOwnerApprovalManifests(),
): void {
  verifyUncrustablesAuthenticityRegistry(registry);
  const proofIds = new Set<string>();
  const approvedSubjects = new Set<string>();
  for (const manifest of manifests) {
    verifySealedOwnerApprovalManifest(
      manifest,
      registry,
      proofIds,
      approvedSubjects,
    );
  }
}

/**
 * Регистрирует дополнительный sealed-манифест (например, DB-запись студии).
 * Перед принятием союз ЦЕЛИКОМ переверифицируется вместе с кандидатом; битый
 * кандидат не попадает в союз. Возврат false = манифест уже зарегистрирован
 * (идемпотентность по sha256).
 */
export function registerSealedOwnerApprovalManifest(
  manifest: UncrustablesMainOwnerApprovalManifest,
): boolean {
  const already = unionUncrustablesOwnerApprovalManifests().some(
    (existing) => existing.sha256.toLowerCase() === manifest.sha256?.toLowerCase(),
  );
  if (already) return false;
  verifyUncrustablesOwnerApprovalManifestUnion(undefined, [
    ...unionUncrustablesOwnerApprovalManifests(),
    manifest,
  ]);
  registeredManifests.push(manifest);
  return true;
}

/** Только для тестов: убрать зарегистрированные манифесты. */
export function __clearRegisteredOwnerApprovalManifestsForTests(): void {
  registeredManifests.length = 0;
}

/** Все пруфы союза (после верификации вызывающей стороной). */
export function allUnionOwnerApprovedProofs(): UncrustablesOwnerApprovedMainProof[] {
  return unionUncrustablesOwnerApprovalManifests().flatMap(
    (manifest) => manifest.entries,
  );
}

/** Манифест, содержащий пруф — к его sha пиннится пермит. */
export function unionManifestContainingProof(
  proofId: string,
): UncrustablesMainOwnerApprovalManifest {
  const manifest = unionUncrustablesOwnerApprovalManifests().find((candidate) =>
    candidate.entries.some((proof) => proof.proof_id === proofId),
  );
  if (!manifest) {
    throw new Error(`No sealed owner-approval manifest contains proof ${proofId}.`);
  }
  return manifest;
}
