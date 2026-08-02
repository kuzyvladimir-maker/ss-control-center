import {
  invokeWalmartListingIntegrityFrozenProcess,
  type WalmartListingIntegrityFrozenProcessConfig,
} from "./listing-integrity-frozen-process-adapter.server";
import {
  runWalmartListingIntegrityFrozenOperatorWorkerOnce,
  type WalmartListingIntegrityFrozenWorkerBinding,
  type WalmartListingIntegrityFrozenWorkerResult,
} from "./listing-integrity-frozen-operator-worker";
import {
  verifyWalmartListingIntegrityFrozenWorkOrder,
  type WalmartListingIntegrityFrozenWorkOrder,
} from "./listing-integrity-frozen-work-order";
import type {
  ValidatedWalmartListingIntegrityRuntimeAuthority,
} from "./listing-integrity-runtime-authority";
import type {
  WalmartListingIntegrityControlState,
} from "./listing-integrity-control-plane";
import type {
  admitAndPersistWalmartListingIntegrityOperatorReceipt,
  WalmartListingIntegrityControlRawTransactionHost,
} from "./listing-integrity-control-transition-store.server";

export async function runWalmartListingIntegrityProductionWorkerOnce(input: {
  authority: ValidatedWalmartListingIntegrityRuntimeAuthority | null;
  items: readonly WalmartListingIntegrityControlState[];
  binding: WalmartListingIntegrityFrozenWorkerBinding;
  work_order: WalmartListingIntegrityFrozenWorkOrder | null;
  process_config: WalmartListingIntegrityFrozenProcessConfig;
  now: Date;
  store?: WalmartListingIntegrityControlRawTransactionHost;
  persist_receipt?: typeof admitAndPersistWalmartListingIntegrityOperatorReceipt;
}): Promise<WalmartListingIntegrityFrozenWorkerResult> {
  if (input.authority !== null && input.work_order === null) {
    throw new Error(
      "WALMART_LISTING_INTEGRITY_WORK_ORDER_REQUIRED: admitted one-SKU authority has no sealed work order",
    );
  }
  return runWalmartListingIntegrityFrozenOperatorWorkerOnce({
    authority: input.authority,
    items: input.items,
    binding: input.binding,
    ...(input.store ? { store: input.store } : {}),
    ...(input.persist_receipt ? { persist_receipt: input.persist_receipt } : {}),
    invoke_frozen_operator: async (invocation) => {
      if (!input.work_order) {
        throw new Error("WALMART_LISTING_INTEGRITY_WORK_ORDER_REQUIRED");
      }
      const workOrder = verifyWalmartListingIntegrityFrozenWorkOrder({
        work_order: input.work_order,
        invocation,
        now: input.now,
      });
      return invokeWalmartListingIntegrityFrozenProcess({
        invocation,
        config: input.process_config,
        operator_args: workOrder.operator_args,
      });
    },
  });
}
