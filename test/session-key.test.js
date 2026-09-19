"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  LOCAL_SESSION_PROFILE_ID,
  makeSessionKey,
  resolveSessionIdentity,
  parseSessionKey,
} = require("../src/session-key");

test("local session action ids use the same opaque profile envelope", () => {
  const key = makeSessionKey({
    profileId: LOCAL_SESSION_PROFILE_ID,
    rawSessionId: "thread-1",
  });
  assert.match(key, /^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(key.includes("thread-1"), false);
});

test("same raw session id in two remote profiles produces opaque collision-free keys", () => {
  const a = makeSessionKey({ profileId: "profile_a", rawSessionId: "same::raw" });
  const b = makeSessionKey({ profileId: "profile_b", rawSessionId: "same::raw" });
  assert.notEqual(a, b);
  assert.match(a, /^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(a.includes("same::raw"), false);
  assert.equal(a.includes("profile_a"), false);
});

test("session identity preserves raw id strictly for display", () => {
  assert.deepEqual(resolveSessionIdentity("abc", "profile_a"), {
    profileId: "profile_a",
    rawSessionId: "abc",
    sessionId: makeSessionKey({ profileId: "profile_a", rawSessionId: "abc" }),
  });
});

test("a local raw id cannot collide with a remote canonical key", () => {
  const remote = makeSessionKey({ profileId: "profile_a", rawSessionId: "thread-1" });
  const local = makeSessionKey({
    profileId: LOCAL_SESSION_PROFILE_ID,
    rawSessionId: remote,
  });
  assert.notEqual(local, remote);
});

test("parseSessionKey reverses makeSessionKey back to the raw session id", () => {
  const key = makeSessionKey({
    profileId: "profile_a",
    rawSessionId: "pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e",
  });
  const parsed = parseSessionKey(key);
  assert.deepEqual(parsed, {
    profileId: "profile_a",
    rawSessionId: "pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e",
  });
});

test("parseSessionKey rejects malformed and non-session keys", () => {
  assert.equal(parseSessionKey(""), null);
  assert.equal(parseSessionKey(null), null);
  assert.equal(parseSessionKey("thread-1"), null);
  assert.equal(parseSessionKey("s1.only"), null);
  assert.equal(parseSessionKey("s1.a.b.c"), null);
  assert.equal(parseSessionKey("v2.a.b"), null);
  // Note: an unknown-but-well-formed profile id ("no-such-profile") IS
  // parsed successfully — profile validity is dynamic (remote SSH profiles)
  // and not parseSessionKey's concern; it only reverses the envelope.
});
