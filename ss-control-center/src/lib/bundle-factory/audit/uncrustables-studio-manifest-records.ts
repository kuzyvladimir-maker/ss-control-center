/**
 * Studio DB-manifest loader (uncrustables-studio-integration-plan.md,
 * решение 4 — union запечатанных манифестов).
 *
 * registerSealedOwnerApprovalManifest() держит зарегистрированные манифесты
 * в памяти модуля, поэтому после холодного старта процесса preflight видит
 * только статические repo-манифесты. Этот helper читает ВСЕ append-only
 * строки UncrustablesOwnerApprovalManifestRecord и регистрирует каждую в
 * union (идемпотентно по sha256). Регистрация переверифицирует весь союз
 * (schema/seal/registry binding/per-proof authenticity/кросс-манифестная
 * уникальность) — битая запись бросает и закрывает публикацию целиком.
 *
 * Вызывать в НАЧАЛЕ prepare- и submit-роутов студии, до любого preflight.
 */

import {
  registerSealedOwnerApprovalManifest,
  type UncrustablesMainOwnerApprovalManifest,
} from "./uncrustables-owner-approval-manifests";

/** Ровно то подмножество Prisma, которое нужно загрузчику (тестируемо). */
export interface StudioManifestRecordReader {
  uncrustablesOwnerApprovalManifestRecord: {
    findMany(args: unknown): Promise<
      { id: string; manifest_id: string; sha256: string; body_json: string }[]
    >;
  };
}

export interface EnsureStudioManifestRecordsResult {
  /** Всего строк в таблице. */
  total: number;
  /** Сколько зарегистрировано ИМЕННО этим вызовом (0 = все уже были). */
  newly_registered: number;
}

/**
 * Читает все sealed DB-манифесты студии и регистрирует их в union.
 * Идемпотентно: повторный вызов регистрирует 0 новых. Throw при любом
 * повреждении записи (не-JSON, sha-колонка не равна печати тела, провал
 * полной верификации союза) — fail closed.
 */
export async function ensureStudioManifestRecordsRegistered(
  prisma: StudioManifestRecordReader,
): Promise<EnsureStudioManifestRecordsResult> {
  const rows = await prisma.uncrustablesOwnerApprovalManifestRecord.findMany({
    orderBy: { created_at: "asc" },
    select: { id: true, manifest_id: true, sha256: true, body_json: true },
  });
  let newlyRegistered = 0;
  for (const row of rows) {
    let manifest: UncrustablesMainOwnerApprovalManifest;
    try {
      manifest = JSON.parse(row.body_json) as UncrustablesMainOwnerApprovalManifest;
    } catch (error) {
      throw new Error(
        `Studio manifest record ${row.id} (${row.manifest_id}) holds invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if ((manifest?.sha256 ?? "").toLowerCase() !== row.sha256.toLowerCase()) {
      throw new Error(
        `Studio manifest record ${row.id} (${row.manifest_id}) sha256 column does not match its body seal.`,
      );
    }
    if (registerSealedOwnerApprovalManifest(manifest)) newlyRegistered += 1;
  }
  return { total: rows.length, newly_registered: newlyRegistered };
}
