/**
 * RETIRED 2026-07-01 — DO NOT RUN.
 *
 * This script used to GENERATE "AVAILABLE" UPCs by counting sequentially within
 * our owned SpeedyBarcode prefixes (742259/789232/617261) with a valid GS1 check
 * digit but NO check that the barcode was free on Amazon. That produced a fake
 * pool whose low sequences were already burned — e.g. 742259000027 collided with
 * ASIN B08P277HSC and 742259000034 with B0H75VN18Z (Amazon error 8541), which
 * blocked the first end-to-end publish. All 2,996 generated rows are now
 * QUARANTINED.
 *
 * The real pool is the verified-free SpeedyBarcode export (13,239 codes), loaded
 * via scripts/_import-speedy-pool.ts and self-cleaned at publish time by the
 * burn-on-reject loop (src/lib/bundle-factory/distribution/upc-burn.ts). Never
 * fabricate barcodes again.
 */

console.error(
  "seed-upc-pool-available.ts is RETIRED — it generated Amazon-colliding UPCs.\n" +
    "Load the verified SpeedyBarcode pool with scripts/_import-speedy-pool.ts instead.\n" +
    "Publishing self-cleans burned barcodes via the burn-on-reject loop (upc-burn.ts).",
);
process.exit(1);
