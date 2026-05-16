# Veeqo allocation_package sync

## Problem

`getShippingRates(allocationId)` requests rates with `from_allocation_package=true`. That means **Veeqo uses its own cached packaging for the allocation, not our DB**. Saving new L/W/H to our `PackingProfile` / `SkuShippingData` doesn't change the rates Veeqo returns — it just changes what we display.

The user noticed Veeqo "remembers" the last dimensions for a given SKU+qty composition. That's because Veeqo's own UI sets `save_for_similar_shipments: true` when packing.

## Fix

`POST /api/shipping/edit-package` now also pushes packaging to Veeqo:

```http
PUT /allocations/{allocationId}/allocation_package
{
  "allocation_package": {
    "weight": <oz>,
    "weight_unit": "oz",
    "depth": <inches, longest>,
    "width": <inches>,
    "height": <inches>,
    "dimensions_unit": "in",
    "package_provider": "CUSTOM",
    "package_selection_source": "ONE_OFF",
    "save_for_similar_shipments": true
  }
}
```

UI passes `allocationId` (from `plan.allocationId`) through to the API. Veeqo push is **best-effort**: if it fails (auth issue, allocation in non-editable state), the local DB save still succeeds and the API response includes a `veeqo: { ok: false, reason }` field so the UI can surface a warning if needed.

## Units

We convert in the client wrapper:
- Weight: lbs (UI) → oz (Veeqo) via `× 16`
- Dimensions: inches both sides (no conversion)

## Field mapping

Veeqo uses `depth / width / height`, where `depth` is the longest dimension (= shipping label length). We pass our `L` straight to `depth`.

## Sources

- [Veeqo API: Update Allocation Package](https://developers.veeqo.com/api/operations/update-allocation-package/)
- [`src/lib/veeqo/client.ts`](../../ss-control-center/src/lib/veeqo/client.ts) → `updateAllocationPackage()`
- [`src/app/api/shipping/edit-package/route.ts`](../../ss-control-center/src/app/api/shipping/edit-package/route.ts) → `pushPackageToVeeqo()`
