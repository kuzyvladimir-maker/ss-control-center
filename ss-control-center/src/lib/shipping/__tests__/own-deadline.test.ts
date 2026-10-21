import { test } from "node:test";
import assert from "node:assert/strict";
import { addDaysYmd, bucketForYmd, ownShipBy } from "../own-deadline";

test("our ship-by = placed date (Pacific) + 2 days", () => {
  // 2026-10-20 15:00 UTC = Oct 20 in Pacific → ship by Oct 22.
  assert.equal(ownShipBy("2026-10-20T15:00:00Z"), "2026-10-22");
  // 2026-10-21 03:00 UTC is still Oct 20 evening in Pacific.
  assert.equal(ownShipBy("2026-10-21T03:00:00Z"), "2026-10-22");
});

test("month / year rollover", () => {
  assert.equal(addDaysYmd("2026-10-31", 2), "2026-11-02");
  assert.equal(addDaysYmd("2026-12-31", 2), "2027-01-02");
});

test("missing or broken placement date → no deadline", () => {
  assert.equal(ownShipBy(null), null);
  assert.equal(ownShipBy(""), null);
  assert.equal(ownShipBy("not a date"), null);
});

test("buckets: the order surfaces on its deadline day", () => {
  const today = "2026-10-21";
  assert.equal(bucketForYmd("2026-10-20", today), "overdue");
  assert.equal(bucketForYmd("2026-10-21", today), "today");
  assert.equal(bucketForYmd("2026-10-22", today), "tomorrow");
  assert.equal(bucketForYmd("2026-10-23", today), "dayafter");
  assert.equal(bucketForYmd("2026-10-30", today), "later");
});
