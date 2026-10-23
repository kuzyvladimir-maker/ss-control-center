import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRateProfile,
  DEFAULT_RATE_PROFILE,
} from "../temp-class/profile";

test("parseRateProfile accepts the three values, defaults otherwise", () => {
  assert.equal(parseRateProfile("summer"), "summer");
  assert.equal(parseRateProfile("SHADOW"), "shadow");
  assert.equal(parseRateProfile(" live "), "live");
  assert.equal(parseRateProfile("garbage"), DEFAULT_RATE_PROFILE);
  assert.equal(parseRateProfile(null), DEFAULT_RATE_PROFILE);
  assert.equal(DEFAULT_RATE_PROFILE, "shadow");
});
