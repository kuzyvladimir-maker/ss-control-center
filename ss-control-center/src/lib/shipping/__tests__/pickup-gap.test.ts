import { test } from "node:test";
import assert from "node:assert/strict";
import { addBusinessDaysYmd, pickupGapBusinessDays } from "../dates";

test("the reported case: planned Sun 10/25, ship Mon 10/26 → 0 pickup days, no EDD shift", () => {
  // FedEx 2Day quoted 'today' (Sunday) already counts from Monday → EDD 10/28.
  // With a 0 gap the Monday quote's 10/28 stands; the old calendar gap of 1
  // pushed it to 10/29 · 3 days.
  assert.equal(pickupGapBusinessDays("2026-10-25", "2026-10-26"), 0);
});

test("Saturday → Monday is also 0; Friday → Monday is 1; weekday → next weekday is 1", () => {
  assert.equal(pickupGapBusinessDays("2026-10-24", "2026-10-26"), 0);
  assert.equal(pickupGapBusinessDays("2026-10-23", "2026-10-26"), 1);
  assert.equal(pickupGapBusinessDays("2026-10-27", "2026-10-28"), 1);
  assert.equal(pickupGapBusinessDays("2026-10-26", "2026-10-26"), 0);
});

test("a federal holiday is not a pickup day (Thanksgiving Thu 11/26/2026)", () => {
  assert.equal(pickupGapBusinessDays("2026-11-25", "2026-11-27"), 1);
});

test("projection by business days: Fri-quoted 2Day EDD Tue → shipping Mon lands Wed, not Fri", () => {
  // Fri 10/23 quote: 2Day EDD Tue 10/27. Ship Mon 10/26 = 1 pickup day later.
  assert.equal(addBusinessDaysYmd("2026-10-27", pickupGapBusinessDays("2026-10-23", "2026-10-26")), "2026-10-28");
  assert.equal(addBusinessDaysYmd("2026-10-30", 1), "2026-11-02"); // Fri + 1 → Mon
  assert.equal(addBusinessDaysYmd("2026-10-28", 0), "2026-10-28");
});
