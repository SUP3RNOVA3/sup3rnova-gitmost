import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asPageId,
  asSlugId,
  isPageId,
  isSlugId,
  SLUG_ID_RE,
} from "../../build/lib/page-id.js";

// A real canonical page UUID (UUIDv7-shaped) and a real 10-char slugId.
const UUID = "019f499a-9f8c-7d68-b7be-ce100d7c6c56";
const SLUG = "aB3xQ7kR2p";

test("isPageId accepts a canonical UUID and rejects a slugId / garbage", () => {
  assert.equal(isPageId(UUID), true);
  assert.equal(isPageId(SLUG), false);
  assert.equal(isPageId("not-a-uuid"), false);
  assert.equal(isPageId(""), false);
  assert.equal(isPageId(undefined), false);
  assert.equal(isPageId(123), false);
});

test("isSlugId accepts the 10-char slug format and rejects a UUID / wrong length", () => {
  assert.equal(isSlugId(SLUG), true);
  assert.equal(isSlugId(UUID), false);
  assert.equal(isSlugId("short"), false); // < 10 chars
  assert.equal(isSlugId("aB3xQ7kR2pX"), false); // 11 chars
  assert.equal(isSlugId("aB3xQ7kR2!"), false); // illegal char
  assert.equal(isSlugId(""), false);
  assert.equal(isSlugId(null), false);
});

test("SLUG_ID_RE is anchored (no substring match inside a longer string)", () => {
  assert.equal(SLUG_ID_RE.test(`prefix-${SLUG}`), false);
  assert.equal(SLUG_ID_RE.test(`${SLUG}-suffix`), false);
});

test("asPageId returns the branded value unchanged for a valid UUID", () => {
  assert.equal(asPageId(UUID), UUID);
});

test("asPageId throws an actionable error for a slugId (the #260 swap)", () => {
  assert.throws(() => asPageId(SLUG), /canonical page UUID/);
  // The offending value and a custom label are surfaced for self-correction.
  assert.throws(() => asPageId("garbage", "targetPageId"), /targetPageId/);
  assert.throws(() => asPageId("garbage", "targetPageId"), /garbage/);
});

test("asSlugId returns the branded value unchanged for a valid slugId", () => {
  assert.equal(asSlugId(SLUG), SLUG);
});

test("asSlugId throws for a UUID cross-wired where a slugId is required", () => {
  assert.throws(() => asSlugId(UUID), /10-char page slugId/);
  assert.throws(() => asSlugId("nope"), /nope/);
});
