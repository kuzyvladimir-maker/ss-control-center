import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { ListingItem, ListingPatch } from "../../amazon-sp-api/listings";
import {
  BASE_OFFER_PATH,
  US_AMAZON_MARKETPLACE_ID,
  assertBaseOfferPreservePlan,
  assertBaseOfferPreserveSelection,
  buildBaseOfferPreservePreviewSet,
  sha256,
  stableJson,
  type BaseOfferPreservePlan,
  type BaseOfferPreservePlanEntry,
  type BaseOfferPreserveSelection,
} from "./uncrustables-base-offer-preserve";
import {
  assertBaseOfferLiveArm,
  assertBaseOfferLiveAuthorization,
  assertBaseOfferLiveSelection,
  assertBaseOfferRollbackBinding,
  baseOfferLiveArmToken,
  observeBaseOfferLiveState,
  type BaseOfferLiveAuthorization,
  type BaseOfferLiveMode,
  type BaseOfferLiveSelection,
  type BaseOfferRollbackBinding,
} from "./uncrustables-base-offer-live-contract";
import type { UncrustablesPreChangeSnapshot } from "./uncrustables-amazon-rollback";

export const BASE_OFFER_CHECKPOINT_SCHEMA =
  "uncrustables-amazon-base-offer-live-checkpoint/v1" as const;
export const CANONICAL_BASE_OFFER_COORDINATION_DIR =
  "data/repairs/base-offer-preserve/live-coordination" as const;

type JsonObject = Record<string, unknown>;

export type BaseOfferCheckpointStatus =
  | "OFFLINE_VALIDATED"
  | "PREVIEW_VALID"
  | "SUBMISSION_ARMED"
  | "PRE_REQUEST_ABORTED"
  | "SUBMITTED"
  | "READBACK_OBSERVED"
  | "VERIFIED"
  | "ALREADY_APPLIED"
  | "FAILED_BEFORE_SUBMISSION"
  | "AMBIGUOUS";

export interface BaseOfferCheckpointEvent {
  schema_version: typeof BASE_OFFER_CHECKPOINT_SCHEMA;
  immutable: true;
  event_id: string;
  execution_binding_sha256: string;
  sequence: number;
  previous_event_sha256: string | null;
  created_at: string;
  action_id: string;
  sku: string;
  status: BaseOfferCheckpointStatus;
  detail: JsonObject;
  body_sha256: string;
}

export interface BaseOfferCheckpointStore {
  readonly executionBindingSha256: string;
  readEvents(): Promise<BaseOfferCheckpointEvent[]>;
  append(input: {
    action_id: string;
    sku: string;
    status: BaseOfferCheckpointStatus;
    detail: JsonObject;
  }): Promise<BaseOfferCheckpointEvent>;
  acquireExecutionLease(purpose: string): Promise<() => Promise<void>>;
  assertNoPendingMutationFence(): Promise<void>;
  claimPendingMutationFence(actionId: string): Promise<void>;
  releasePendingMutationFence(actionId: string): Promise<void>;
}

function sealBody(value: Omit<BaseOfferCheckpointEvent, "body_sha256">): string {
  return sha256(stableJson(value));
}

function checkpointBody(
  event: BaseOfferCheckpointEvent,
): Omit<BaseOfferCheckpointEvent, "body_sha256"> {
  const body = { ...event } as Partial<BaseOfferCheckpointEvent>;
  delete body.body_sha256;
  return body as Omit<BaseOfferCheckpointEvent, "body_sha256">;
}

export class ImmutableBaseOfferCheckpointStore
  implements BaseOfferCheckpointStore
{
  constructor(
    private readonly rootDir: string,
    readonly executionBindingSha256: string,
    private readonly coordinationDir: string =
      CANONICAL_BASE_OFFER_COORDINATION_DIR,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[a-f0-9]{64}$/.test(executionBindingSha256)) {
      throw new Error("Checkpoint execution binding must be a SHA-256 digest.");
    }
  }

  private directory(): string {
    return path.join(this.rootDir, this.executionBindingSha256.slice(0, 20));
  }

  async readEvents(): Promise<BaseOfferCheckpointEvent[]> {
    let names: string[];
    try {
      names = (await readdir(this.directory()))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: BaseOfferCheckpointEvent[] = [];
    for (const name of names) {
      const event = JSON.parse(
        await readFile(path.join(this.directory(), name), "utf8"),
      ) as BaseOfferCheckpointEvent;
      if (
        event.schema_version !== BASE_OFFER_CHECKPOINT_SCHEMA ||
        event.immutable !== true ||
        event.execution_binding_sha256 !== this.executionBindingSha256 ||
        event.body_sha256 !== sealBody(checkpointBody(event))
      ) {
        throw new Error(`Invalid/tampered base-offer checkpoint ${name}.`);
      }
      events.push(event);
    }
    events.sort((left, right) => left.sequence - right.sequence);
    events.forEach((event, index) => {
      const previous = index === 0 ? null : events[index - 1].body_sha256;
      if (
        event.sequence !== index + 1 ||
        event.previous_event_sha256 !== previous
      ) {
        throw new Error("Base-offer checkpoint chain is incomplete or reordered.");
      }
    });
    return events;
  }

  async append(input: {
    action_id: string;
    sku: string;
    status: BaseOfferCheckpointStatus;
    detail: JsonObject;
  }): Promise<BaseOfferCheckpointEvent> {
    const events = await this.readEvents();
    const createdAt = this.now().toISOString();
    const eventId = randomUUID();
    const body: Omit<BaseOfferCheckpointEvent, "body_sha256"> = {
      schema_version: BASE_OFFER_CHECKPOINT_SCHEMA,
      immutable: true,
      event_id: eventId,
      execution_binding_sha256: this.executionBindingSha256,
      sequence: events.length + 1,
      previous_event_sha256:
        events.length === 0 ? null : events[events.length - 1].body_sha256,
      created_at: createdAt,
      action_id: input.action_id,
      sku: input.sku,
      status: input.status,
      detail: structuredClone(input.detail),
    };
    const event = { ...body, body_sha256: sealBody(body) };
    await mkdir(this.directory(), { recursive: true });
    const safeAction = input.action_id.replace(/[^A-Za-z0-9_.-]+/g, "_");
    const file = path.join(
      this.directory(),
      `${String(body.sequence).padStart(5, "0")}-${safeAction}-${input.status}-${eventId}.json`,
    );
    await writeFile(file, `${JSON.stringify(event, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return event;
  }

  async acquireExecutionLease(purpose: string): Promise<() => Promise<void>> {
    await mkdir(this.coordinationDir, { recursive: true });
    const leasePath = path.join(this.coordinationDir, "active-execution.lock");
    const leaseId = randomUUID();
    const body = {
      schema_version: "uncrustables-amazon-base-offer-live-lease/v1",
      execution_binding_sha256: this.executionBindingSha256,
      lease_id: leaseId,
      purpose,
      acquired_at: this.now().toISOString(),
      process_id: process.pid,
    };
    try {
      await writeFile(leasePath, `${JSON.stringify(body, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Base-offer live execution lease exists at ${leasePath}; no Amazon call was made.`,
        );
      }
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      const current = JSON.parse(await readFile(leasePath, "utf8")) as {
        lease_id?: unknown;
      };
      if (current.lease_id !== leaseId) {
        throw new Error("Base-offer execution lease ownership changed.");
      }
      await unlink(leasePath);
      released = true;
    };
  }

  private mutationFencePath(): string {
    return path.join(this.coordinationDir, "pending-mutation-fence.json");
  }

  async assertNoPendingMutationFence(): Promise<void> {
    try {
      const raw = JSON.parse(
        await readFile(this.mutationFencePath(), "utf8"),
      ) as { execution_binding_sha256?: unknown; action_id?: unknown };
      throw new Error(
        `Unresolved base-offer mutation fence exists for ${String(raw.action_id ?? "unknown")} / ${String(raw.execution_binding_sha256 ?? "unknown")}; no Amazon call was made.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async claimPendingMutationFence(actionId: string): Promise<void> {
    await mkdir(this.coordinationDir, { recursive: true });
    const body = {
      schema_version: "uncrustables-amazon-base-offer-pending-mutation-fence/v1",
      execution_binding_sha256: this.executionBindingSha256,
      action_id: actionId,
      claimed_at: this.now().toISOString(),
      process_id: process.pid,
    };
    try {
      await writeFile(
        this.mutationFencePath(),
        `${JSON.stringify(body, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          "A base-offer pending mutation fence already exists; no Amazon call was made.",
        );
      }
      throw error;
    }
  }

  async releasePendingMutationFence(actionId: string): Promise<void> {
    const fencePath = this.mutationFencePath();
    const raw = JSON.parse(await readFile(fencePath, "utf8")) as {
      execution_binding_sha256?: unknown;
      action_id?: unknown;
    };
    if (
      raw.execution_binding_sha256 !== this.executionBindingSha256 ||
      raw.action_id !== actionId
    ) {
      throw new Error("Refusing to release a base-offer mutation fence owned elsewhere.");
    }
    await unlink(fencePath);
  }
}

export interface BaseOfferPhysicalAccountContext {
  store_index: number;
  marketplace_id: string;
  amazon_merchant_id: string;
}

export interface BaseOfferAmazonGatewayResponse {
  status?: string;
  submissionId?: string;
  issues?: Array<{
    code?: string;
    severity?: string;
    message?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface BaseOfferAmazonGateway {
  readonly physicalMutationGuardContract?:
    "CALL_IMMEDIATELY_BEFORE_REQUEST_V1";
  getListing(
    storeIndex: number,
    sku: string,
    signal?: AbortSignal,
  ): Promise<ListingItem>;
  patchListing(
    storeIndex: number,
    sku: string,
    productType: string,
    patches: ListingPatch[],
    options: {
      validationPreview: boolean;
      signal?: AbortSignal;
      beforeRequest?: (context: BaseOfferPhysicalAccountContext) => void;
    },
  ): Promise<BaseOfferAmazonGatewayResponse>;
}

export interface ExecuteBaseOfferLiveInput {
  plan: BaseOfferPreservePlan;
  fullSelection: BaseOfferPreserveSelection;
  liveSelection: BaseOfferLiveSelection;
  rollbackBinding: BaseOfferRollbackBinding;
  snapshot: UncrustablesPreChangeSnapshot;
  snapshotBytes: Buffer;
  authorization?: BaseOfferLiveAuthorization | null;
  gateway?: BaseOfferAmazonGateway;
  checkpointStore?: BaseOfferCheckpointStore;
  mode?: BaseOfferLiveMode;
  confirmation?: string | null;
  environment?: Record<string, string | undefined>;
  requestDelayMs?: number;
  readbackAttempts?: number;
  readbackDelayMs?: number;
  stableReads?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface ExecuteBaseOfferLiveResult {
  mode: BaseOfferLiveMode;
  execution_binding_sha256: string;
  selected_actions: number;
  offline_validated_actions: number;
  preview_valid_actions: number;
  submitted_actions: number;
  verified_actions: number;
  already_applied_actions: number;
  pre_request_aborted_actions: number;
  ambiguous_actions: number;
  external_mutations_attempted: number;
  stopped_early: boolean;
}

function hasBlockingIssues(response: BaseOfferAmazonGatewayResponse): boolean {
  return (response.issues ?? []).some(
    (issue) => String(issue.severity ?? "").toUpperCase() === "ERROR",
  );
}

function responseEvidence(response: BaseOfferAmazonGatewayResponse): JsonObject {
  return {
    status: String(response.status ?? ""),
    submission_id:
      typeof response.submissionId === "string" ? response.submissionId : null,
    issues: structuredClone(response.issues ?? []),
    response_sha256: sha256(stableJson(response)),
  };
}

export function baseOfferExecutionBindingSha256(input: {
  mode: BaseOfferLiveMode;
  plan: BaseOfferPreservePlan;
  fullSelection: BaseOfferPreserveSelection;
  liveSelection: BaseOfferLiveSelection;
  rollbackBinding: BaseOfferRollbackBinding;
  authorization?: BaseOfferLiveAuthorization | null;
}): string {
  return sha256(
    stableJson({
      mode: input.mode,
      plan: input.plan.body_sha256,
      full_selection: input.fullSelection.body_sha256,
      live_selection: input.liveSelection.body_sha256,
      rollback_binding: input.rollbackBinding.body_sha256,
      authorization: input.authorization?.body_sha256 ?? null,
    }),
  );
}

function terminalAndPending(events: BaseOfferCheckpointEvent[]): {
  terminal: Set<string>;
  pending: Set<string>;
  ambiguous: Set<string>;
} {
  const terminal = new Set<string>();
  const pending = new Set<string>();
  const ambiguous = new Set<string>();
  for (const event of events) {
    if (
      [
        "VERIFIED",
        "ALREADY_APPLIED",
        "PRE_REQUEST_ABORTED",
        "FAILED_BEFORE_SUBMISSION",
      ].includes(event.status)
    ) {
      terminal.add(event.action_id);
      pending.delete(event.action_id);
    }
    if (["SUBMISSION_ARMED", "SUBMITTED"].includes(event.status)) {
      pending.add(event.action_id);
    }
    if (event.status === "AMBIGUOUS") {
      ambiguous.add(event.action_id);
      pending.add(event.action_id);
    }
  }
  return { terminal, pending, ambiguous };
}

function assertPacing(input: ExecuteBaseOfferLiveInput): {
  requestDelayMs: number;
  readbackAttempts: number;
  readbackDelayMs: number;
  stableReads: number;
} {
  const requestDelayMs = input.requestDelayMs ?? 250;
  const readbackAttempts = input.readbackAttempts ?? 6;
  const readbackDelayMs = input.readbackDelayMs ?? 5_000;
  const stableReads = input.stableReads ?? 2;
  if (
    !Number.isInteger(requestDelayMs) ||
    requestDelayMs < 200 ||
    !Number.isInteger(readbackAttempts) ||
    readbackAttempts < 2 ||
    readbackAttempts > 20 ||
    !Number.isInteger(readbackDelayMs) ||
    readbackDelayMs < 200 ||
    !Number.isInteger(stableReads) ||
    stableReads < 2 ||
    stableReads > 5 ||
    stableReads > readbackAttempts
  ) {
    throw new Error("Base-offer live pacing/readback policy is unsafe.");
  }
  return { requestDelayMs, readbackAttempts, readbackDelayMs, stableReads };
}

function selectedEntries(input: ExecuteBaseOfferLiveInput): BaseOfferPreservePlanEntry[] {
  const byAction = new Map(input.plan.entries.map((entry) => [entry.action_id, entry]));
  return input.liveSelection.selected_action_ids.map((actionId) => {
    const entry = byAction.get(actionId);
    if (!entry) throw new Error(`Selected action ${actionId} is absent from plan.`);
    return entry;
  });
}

export async function executeBaseOfferLive(
  input: ExecuteBaseOfferLiveInput,
): Promise<ExecuteBaseOfferLiveResult> {
  const mode = input.mode ?? "OFFLINE_VALIDATE";
  const now = input.now ?? (() => new Date());
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  assertBaseOfferPreservePlan(input.plan);
  assertBaseOfferPreserveSelection(input.plan, input.fullSelection);
  assertBaseOfferLiveSelection(
    input.plan,
    input.fullSelection,
    input.liveSelection,
  );
  assertBaseOfferRollbackBinding(
    input.plan,
    input.fullSelection,
    input.liveSelection,
    input.rollbackBinding,
    { snapshot: input.snapshot, snapshotBytes: input.snapshotBytes, now: now() },
  );
  const entries = selectedEntries(input);
  const bindingSha = baseOfferExecutionBindingSha256({
    mode,
    plan: input.plan,
    fullSelection: input.fullSelection,
    liveSelection: input.liveSelection,
    rollbackBinding: input.rollbackBinding,
    authorization: input.authorization,
  });
  const result: ExecuteBaseOfferLiveResult = {
    mode,
    execution_binding_sha256: bindingSha,
    selected_actions: entries.length,
    offline_validated_actions: 0,
    preview_valid_actions: 0,
    submitted_actions: 0,
    verified_actions: 0,
    already_applied_actions: 0,
    pre_request_aborted_actions: 0,
    ambiguous_actions: 0,
    external_mutations_attempted: 0,
    stopped_early: false,
  };

  if (mode === "OFFLINE_VALIDATE") {
    assertBaseOfferLiveArm({
      mode,
      confirmation: input.confirmation,
      environment: input.environment,
    });
    if (input.authorization || input.gateway || input.checkpointStore) {
      throw new Error(
        "Offline validation refuses authorization, gateway, or checkpoint capabilities.",
      );
    }
    result.offline_validated_actions = entries.length;
    return result;
  }

  const pacing = assertPacing(input);
  if (!input.gateway || !input.checkpointStore) {
    throw new Error(`${mode} requires explicit gateway and checkpoint store.`);
  }
  const gateway = input.gateway;
  const checkpointStore = input.checkpointStore;
  if (checkpointStore.executionBindingSha256 !== bindingSha) {
    throw new Error(
      "Checkpoint store is bound to a different plan/selection/rollback/mode/authorization.",
    );
  }
  let authorization: BaseOfferLiveAuthorization | null = null;
  if (mode === "APPLY") {
    if (!input.authorization) {
      throw new Error("APPLY requires a separate current owner authorization.");
    }
    authorization = assertBaseOfferLiveAuthorization({
      plan: input.plan,
      fullSelection: input.fullSelection,
      liveSelection: input.liveSelection,
      rollbackBinding: input.rollbackBinding,
      authorization: input.authorization,
      snapshot: input.snapshot,
      snapshotBytes: input.snapshotBytes,
      now: now(),
    });
    if (
      gateway.physicalMutationGuardContract !==
      "CALL_IMMEDIATELY_BEFORE_REQUEST_V1"
    ) {
      throw new Error("APPLY gateway lacks the immediate physical mutation guard.");
    }
  } else if (input.authorization) {
    throw new Error("VALIDATION_PREVIEW must not borrow APPLY authorization.");
  }
  const expectedToken = baseOfferLiveArmToken({
    mode,
    plan: input.plan,
    liveSelection: input.liveSelection,
    rollbackBinding: input.rollbackBinding,
    authorization,
  });
  assertBaseOfferLiveArm({
    mode,
    expectedToken,
    confirmation: input.confirmation,
    environment: input.environment,
  });

  const existingEvents = await checkpointStore.readEvents();
  const prior = terminalAndPending(existingEvents);
  const selectedActionIds = new Set(entries.map((entry) => entry.action_id));
  const blocked = [...prior.pending].filter((actionId) =>
    selectedActionIds.has(actionId),
  );
  const repeated = [...prior.terminal].filter((actionId) =>
    selectedActionIds.has(actionId),
  );
  if (blocked.length > 0 || repeated.length > 0) {
    throw new Error(
      `Checkpoint state blocks replay (pending=${blocked.join(",") || "none"}; terminal=${repeated.join(",") || "none"}). No Amazon call was made.`,
    );
  }

  const releaseLease = await checkpointStore.acquireExecutionLease(
    `${mode}:${input.liveSelection.selection_id}`,
  );
  try {
    if (mode === "APPLY") {
      await checkpointStore.assertNoPendingMutationFence();
    }
    for (const entry of entries) {
      try {
        input.signal?.throwIfAborted();
        let live = await gateway.getListing(
          entry.store_index,
          entry.sku,
          input.signal,
        );
        let observation = observeBaseOfferLiveState(entry, live);
        if (!observation.preservation_ok) {
          throw new Error(`${entry.action_id} promo/list preservation CAS failed.`);
        }
        if (observation.classification === "DESIRED") {
          await checkpointStore.append({
            action_id: entry.action_id,
            sku: entry.sku,
            status: "ALREADY_APPLIED",
            detail: {
              state_sha256: observation.state_sha256,
              checks: observation.checks,
            },
          });
          result.already_applied_actions++;
          continue;
        }
        const previewSet = buildBaseOfferPreservePreviewSet(entry, live);
        assertNoForbiddenBaseOfferPatchMembers([entry.actual_patch]);
        if (
          stableJson(previewSet.actual_merge_patch) !== stableJson(entry.actual_patch) ||
          stableJson(previewSet.validation_preview_patch) !==
            stableJson(entry.validation_preview_patch)
        ) {
          throw new Error(`${entry.action_id} preview surrogate drifted from FINAL v3.`);
        }
        const previewResponse = await gateway.patchListing(
          entry.store_index,
          entry.sku,
          entry.product_type,
          [previewSet.validation_preview_patch],
          { validationPreview: true, signal: input.signal },
        );
        if (
          String(previewResponse.status ?? "") !== "VALID" ||
          hasBlockingIssues(previewResponse)
        ) {
          throw new Error(
            `VALIDATION_PREVIEW rejected ${entry.action_id}: ${stableJson(responseEvidence(previewResponse))}`,
          );
        }
        await checkpointStore.append({
          action_id: entry.action_id,
          sku: entry.sku,
          status: "PREVIEW_VALID",
          detail: {
            actual_patch_sha256: sha256(stableJson(entry.actual_patch)),
            preview_patch_sha256: sha256(
              stableJson(entry.validation_preview_patch),
            ),
            ...responseEvidence(previewResponse),
          },
        });
        result.preview_valid_actions++;
        await sleep(pacing.requestDelayMs);
        live = await gateway.getListing(entry.store_index, entry.sku, input.signal);
        observation = observeBaseOfferLiveState(entry, live);
        if (!observation.preservation_ok) {
          throw new Error(`${entry.action_id} promo/list drifted after preview.`);
        }
        if (observation.classification === "DESIRED") {
          await checkpointStore.append({
            action_id: entry.action_id,
            sku: entry.sku,
            status: "ALREADY_APPLIED",
            detail: {
              after_preview: true,
              state_sha256: observation.state_sha256,
              checks: observation.checks,
            },
          });
          result.already_applied_actions++;
          continue;
        }
        buildBaseOfferPreservePreviewSet(entry, live);
        if (mode === "VALIDATION_PREVIEW") continue;

        // Re-check every freshness/authority/arm binding immediately before
        // creating the one-way crash fence and physical request.
        assertBaseOfferRollbackBinding(
          input.plan,
          input.fullSelection,
          input.liveSelection,
          input.rollbackBinding,
          { snapshot: input.snapshot, snapshotBytes: input.snapshotBytes, now: now() },
        );
        authorization = assertBaseOfferLiveAuthorization({
          plan: input.plan,
          fullSelection: input.fullSelection,
          liveSelection: input.liveSelection,
          rollbackBinding: input.rollbackBinding,
          authorization: authorization!,
          snapshot: input.snapshot,
          snapshotBytes: input.snapshotBytes,
          now: now(),
        });
        assertBaseOfferLiveArm({
          mode,
          expectedToken,
          confirmation: input.confirmation,
          environment: input.environment,
        });
        await sleep(pacing.requestDelayMs);
        live = await gateway.getListing(entry.store_index, entry.sku, input.signal);
        observation = observeBaseOfferLiveState(entry, live);
        if (!observation.preservation_ok) {
          throw new Error(`${entry.action_id} promo/list drifted before write.`);
        }
        if (observation.classification === "DESIRED") {
          await checkpointStore.append({
            action_id: entry.action_id,
            sku: entry.sku,
            status: "ALREADY_APPLIED",
            detail: {
              immediately_before_write: true,
              state_sha256: observation.state_sha256,
              checks: observation.checks,
            },
          });
          result.already_applied_actions++;
          continue;
        }
        const immediatePreviewSet = buildBaseOfferPreservePreviewSet(entry, live);
        if (
          stableJson(immediatePreviewSet.actual_merge_patch) !==
            stableJson(previewSet.actual_merge_patch)
        ) {
          throw new Error(`${entry.action_id} actual patch changed after preview.`);
        }
        await checkpointStore.claimPendingMutationFence(entry.action_id);
        const armed = await checkpointStore.append({
          action_id: entry.action_id,
          sku: entry.sku,
          status: "SUBMISSION_ARMED",
          detail: {
            plan_body_sha256: input.plan.body_sha256,
            live_selection_body_sha256: input.liveSelection.body_sha256,
            rollback_binding_body_sha256: input.rollbackBinding.body_sha256,
            authorization_body_sha256: authorization.body_sha256,
            before_state_sha256: observation.state_sha256,
            actual_patch_sha256: sha256(stableJson(entry.actual_patch)),
            preview_patch_sha256: sha256(
              stableJson(entry.validation_preview_patch),
            ),
          },
        });
        let physicalGuardCalled = false;
        let mutationResponse: BaseOfferAmazonGatewayResponse;
        try {
          assertNoForbiddenBaseOfferPatchMembers([entry.actual_patch]);
          result.external_mutations_attempted++;
          mutationResponse = await gateway.patchListing(
            entry.store_index,
            entry.sku,
            entry.product_type,
            [entry.actual_patch],
            {
              validationPreview: false,
              signal: input.signal,
              beforeRequest: (context) => {
                if (
                  context.store_index !== entry.store_index ||
                  context.store_index !== authorization!.account.store_index ||
                  context.marketplace_id !== US_AMAZON_MARKETPLACE_ID ||
                  context.marketplace_id !== authorization!.account.marketplace_id ||
                  context.amazon_merchant_id !==
                    authorization!.account.amazon_merchant_id
                ) {
                  throw new Error(
                    `${entry.action_id} physical Amazon account context mismatched.`,
                  );
                }
                physicalGuardCalled = true;
              },
            },
          );
        } catch (error) {
          if (!physicalGuardCalled) {
            await checkpointStore.append({
              action_id: entry.action_id,
              sku: entry.sku,
              status: "PRE_REQUEST_ABORTED",
              detail: {
                armed_event_id: armed.event_id,
                physical_guard_called: false,
                error: error instanceof Error ? error.message : String(error),
              },
            });
            result.pre_request_aborted_actions++;
            await checkpointStore.releasePendingMutationFence(entry.action_id);
          } else {
            await checkpointStore.append({
              action_id: entry.action_id,
              sku: entry.sku,
              status: "AMBIGUOUS",
              detail: {
                armed_event_id: armed.event_id,
                physical_guard_called: true,
                error: error instanceof Error ? error.message : String(error),
              },
            });
            result.ambiguous_actions++;
          }
          throw error;
        }
        if (!physicalGuardCalled) {
          await checkpointStore.append({
            action_id: entry.action_id,
            sku: entry.sku,
            status: "AMBIGUOUS",
            detail: {
              armed_event_id: armed.event_id,
              error: "Gateway returned without invoking physical mutation guard.",
            },
          });
          result.ambiguous_actions++;
          throw new Error(`${entry.action_id} physical mutation guard was not invoked.`);
        }
        if (
          !["ACCEPTED", "IN_PROGRESS"].includes(
            String(mutationResponse.status ?? ""),
          ) ||
          hasBlockingIssues(mutationResponse)
        ) {
          await checkpointStore.append({
            action_id: entry.action_id,
            sku: entry.sku,
            status: "AMBIGUOUS",
            detail: {
              armed_event_id: armed.event_id,
              ...responseEvidence(mutationResponse),
            },
          });
          result.ambiguous_actions++;
          throw new Error(`${entry.action_id} mutation response was not safely accepted.`);
        }
        const submitted = await checkpointStore.append({
          action_id: entry.action_id,
          sku: entry.sku,
          status: "SUBMITTED",
          detail: {
            armed_event_id: armed.event_id,
            ...responseEvidence(mutationResponse),
          },
        });
        result.submitted_actions++;

        let stableDesiredReads = 0;
        let lastDesiredStateSha: string | null = null;
        let verified = false;
        for (let attempt = 1; attempt <= pacing.readbackAttempts; attempt++) {
          await sleep(pacing.readbackDelayMs);
          let readback: ListingItem;
          try {
            readback = await gateway.getListing(
              entry.store_index,
              entry.sku,
              input.signal,
            );
          } catch (error) {
            await checkpointStore.append({
              action_id: entry.action_id,
              sku: entry.sku,
              status: "READBACK_OBSERVED",
              detail: {
                submitted_event_id: submitted.event_id,
                attempt,
                read_error: error instanceof Error ? error.message : String(error),
              },
            });
            continue;
          }
          const readbackObservation = observeBaseOfferLiveState(entry, readback);
          if (!readbackObservation.preservation_ok) {
            await checkpointStore.append({
              action_id: entry.action_id,
              sku: entry.sku,
              status: "AMBIGUOUS",
              detail: {
                submitted_event_id: submitted.event_id,
                attempt,
                reason: "PROMO_OR_LIST_PRICE_DRIFT",
                checks: readbackObservation.checks,
              },
            });
            result.ambiguous_actions++;
            throw new Error(`${entry.action_id} readback changed promo/list state.`);
          }
          if (readbackObservation.classification === "DESIRED") {
            stableDesiredReads =
              lastDesiredStateSha === readbackObservation.state_sha256
                ? stableDesiredReads + 1
                : 1;
            lastDesiredStateSha = readbackObservation.state_sha256;
          } else {
            stableDesiredReads = 0;
            lastDesiredStateSha = null;
          }
          await checkpointStore.append({
            action_id: entry.action_id,
            sku: entry.sku,
            status: "READBACK_OBSERVED",
            detail: {
              submitted_event_id: submitted.event_id,
              attempt,
              classification: readbackObservation.classification,
              state_sha256: readbackObservation.state_sha256,
              stable_desired_reads: stableDesiredReads,
              issue_19038_absent: readbackObservation.issue_19038_absent,
              checks: readbackObservation.checks,
            },
          });
          if (stableDesiredReads >= pacing.stableReads) {
            await checkpointStore.append({
              action_id: entry.action_id,
              sku: entry.sku,
              status: "VERIFIED",
              detail: {
                submitted_event_id: submitted.event_id,
                stable_desired_reads: stableDesiredReads,
                final_state_sha256: readbackObservation.state_sha256,
                checks: readbackObservation.checks,
              },
            });
            result.verified_actions++;
            await checkpointStore.releasePendingMutationFence(entry.action_id);
            verified = true;
            break;
          }
        }
        if (!verified) {
          await checkpointStore.append({
            action_id: entry.action_id,
            sku: entry.sku,
            status: "AMBIGUOUS",
            detail: {
              submitted_event_id: submitted.event_id,
              reason: "STABLE_DESIRED_READBACK_NOT_PROVEN",
              attempts: pacing.readbackAttempts,
            },
          });
          result.ambiguous_actions++;
          throw new Error(`${entry.action_id} did not reach stable desired readback.`);
        }
      } catch (error) {
        result.stopped_early = true;
        const events = await checkpointStore.readEvents();
        const actionEvents = events.filter(
          (event) => event.action_id === entry.action_id,
        );
        const hasMutationFence = actionEvents.some((event) =>
          ["SUBMISSION_ARMED", "SUBMITTED", "AMBIGUOUS"].includes(event.status),
        );
        if (!hasMutationFence) {
          await checkpointStore.append({
            action_id: entry.action_id,
            sku: entry.sku,
            status: "FAILED_BEFORE_SUBMISSION",
            detail: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        throw error;
      }
    }
    return result;
  } finally {
    await releaseLease();
  }
}

export function assertNoForbiddenBaseOfferPatchMembers(
  patches: ListingPatch[],
): void {
  if (patches.length !== 1) {
    throw new Error("Base-offer execution requires exactly one patch operation.");
  }
  const patch = patches[0];
  if (patch.path !== BASE_OFFER_PATH || patch.op !== "merge") {
    throw new Error("Base-offer execution patch surface is invalid.");
  }
  const bytes = stableJson(patch);
  if (bytes.includes("discounted_price") || bytes.includes("list_price")) {
    throw new Error("Base-offer execution patch contains promo/list members.");
  }
}
