import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  acquireCollabSession,
  destroyAllSessions,
  __setCollabProviderFactory,
  __sessionCountForTests,
} from "../../build/lib/collab-session.js";
import { withPageLock } from "../../build/lib/page-lock.js";

// A stand-in for HocuspocusProvider: it shares the ydoc (so the real yjs
// read/transform/write in CollabSession.mutate runs unchanged), auto-completes
// the connect+sync handshake on a microtask (unaffected by mock timers), and
// exposes hooks to drive disconnect/close/auth-failure and the unsyncedChanges
// ack. There is no collaboration server in the test env, so every test drives
// the provider through this fake.
class FakeProvider extends EventEmitter {
  static instances = [];
  static connectCount = 0;

  static reset() {
    FakeProvider.instances = [];
    FakeProvider.connectCount = 0;
  }

  static last() {
    return FakeProvider.instances[FakeProvider.instances.length - 1];
  }

  constructor(config, opts = {}) {
    super();
    this.config = config;
    this.ydoc = config.document;
    this.synced = false;
    this.unsyncedChanges = opts.unsynced ?? 0;
    this.destroyed = false;
    FakeProvider.instances.push(this);
    FakeProvider.connectCount += 1;
    if (opts.autoSync !== false) {
      // Real HocuspocusProvider fires onSynced asynchronously after the
      // handshake; a microtask reproduces that without depending on timers.
      queueMicrotask(() => {
        if (this.destroyed) return;
        this.config.onConnect?.();
        this.synced = true;
        this.config.onSynced?.();
      });
    }
  }

  destroy() {
    this.destroyed = true;
  }

  // --- test drivers ---
  _disconnect() {
    this.config.onDisconnect?.();
  }
  _close() {
    this.config.onClose?.();
  }
  _authFail() {
    this.config.onAuthenticationFailed?.();
  }
  _ack() {
    this.unsyncedChanges = 0;
    this.emit("unsyncedChanges", { number: 0 });
  }
}

/** Build a provider factory that stamps every provider with the given opts. */
function factory(opts = {}) {
  return (config) => new FakeProvider(config, opts);
}

/** A minimal, schema-valid ProseMirror doc for a write. */
function docWith(text) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: String(text) }] },
    ],
  };
}

const ENV_KEYS = [
  "MCP_COLLAB_SESSION_IDLE_MS",
  "MCP_COLLAB_SESSION_MAX_AGE_MS",
  "MCP_COLLAB_SESSION_MAX_ENTRIES",
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  FakeProvider.reset();
  __setCollabProviderFactory(factory());
});

afterEach(() => {
  destroyAllSessions();
  __setCollabProviderFactory(null);
  mock.timers.reset();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("acquire opens one provider; reuse returns the SAME live session", async () => {
  const a = await acquireCollabSession("page-1", "tok", "http://h/api");
  const b = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.equal(a, b, "same (wsUrl,page,token) must reuse the session");
  assert.equal(FakeProvider.connectCount, 1, "exactly one connect/sync");
  assert.equal(__sessionCountForTests(), 1);
});

test("N mutates on one page open the provider ONCE (coalesced series)", async () => {
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  for (let i = 0; i < 20; i++) {
    const r = await session.mutate(() => docWith(`edit ${i}`));
    assert.ok(r && r.doc, "each mutate resolves a MutationResult");
  }
  assert.equal(
    FakeProvider.connectCount,
    1,
    "20 mutates must not reconnect — one live provider for the whole series",
  );
});

test("mutate preserves the transform-abort no-op report (null transform)", async () => {
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  const r = await session.mutate(() => null);
  assert.equal(r.verify.changed, false);
  assert.equal(r.verify.summary, "no changes (transform aborted)");
});

test("registry key includes the token: different tokens => different sessions", async () => {
  const a = await acquireCollabSession("page-1", "tok-A", "http://h/api");
  const b = await acquireCollabSession("page-1", "tok-B", "http://h/api");
  assert.notEqual(a, b, "different tokens must never share a session");
  assert.equal(FakeProvider.connectCount, 2);
  assert.equal(__sessionCountForTests(), 2);
  // Same token reuses.
  const a2 = await acquireCollabSession("page-1", "tok-A", "http://h/api");
  assert.equal(a, a2);
  assert.equal(FakeProvider.connectCount, 2);
});

test("disconnect at any time kills the session and removes it from the registry", async () => {
  const a = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 1);
  FakeProvider.last()._disconnect();
  assert.equal(__sessionCountForTests(), 0, "dead session is deregistered");
  // Re-acquire opens a brand new provider.
  const b = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(a, b);
  assert.equal(FakeProvider.connectCount, 2);
});

test("an in-flight mutate rejects with the connection-closed text on disconnect", async () => {
  __setCollabProviderFactory(factory({ unsynced: 1 })); // stay pending after write
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  const p = session.mutate(() => docWith("x"));
  // The write happened synchronously; persistence is pending. Now the socket drops.
  FakeProvider.last()._disconnect();
  await assert.rejects(
    p,
    /Collaboration connection closed before the update was persisted\/synced/,
  );
});

test("auth failure rejects the pending open with the auth error text", async () => {
  __setCollabProviderFactory(factory({ autoSync: false }));
  const p = acquireCollabSession("page-1", "tok", "http://h/api");
  // Let the provider be constructed, then fail auth.
  await Promise.resolve();
  FakeProvider.last()._authFail();
  await assert.rejects(
    p,
    /Authentication failed for collaboration connection/,
  );
  assert.equal(__sessionCountForTests(), 0);
});

test("mutate-error invalidates the session (caller destroys; re-acquire is fresh)", async () => {
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  await assert.rejects(
    session.mutate(() => {
      throw new Error("afterText not found");
    }),
    /afterText not found/,
  );
  // The production caller destroys on failure; mirror that here.
  session.destroy("mutate failed");
  assert.equal(__sessionCountForTests(), 0);
  const fresh = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(fresh, session);
  assert.equal(FakeProvider.connectCount, 2);
});

test("a pending write resolves when the server acks (unsyncedChanges -> 0)", async () => {
  __setCollabProviderFactory(factory({ unsynced: 1 }));
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  const p = session.mutate(() => docWith("y"));
  FakeProvider.last()._ack();
  const r = await p;
  assert.ok(r.doc);
});

test("concurrent mutate on one session: the second rejects, the first is unaffected", async () => {
  __setCollabProviderFactory(factory({ unsynced: 1 })); // first stays pending after write
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  // First mutate: write happens synchronously, persistence ack still pending.
  const first = session.mutate(() => docWith("first"));
  // Second overlapping mutate on the SAME session must fail fast.
  await assert.rejects(
    session.mutate(() => docWith("second")),
    /mutate already in-flight; caller must serialize \(hold the page lock\)/,
  );
  // The first op is untouched: its rejector was not clobbered. Ack it now.
  FakeProvider.last()._ack();
  const r = await first;
  assert.ok(r.doc, "the first in-flight mutate still resolves on its own ack");
  assert.equal(FakeProvider.connectCount, 1, "no reconnect from the rejected overlap");
});

test("sequential mutates on one session both succeed (the guard doesn't break serialized use)", async () => {
  const session = await acquireCollabSession("page-1", "tok", "http://h/api");
  // Await the first fully, then run the second: inflightReject was cleared by
  // localFinish before the first settled, so the guard is clear for the second.
  const r1 = await session.mutate(() => docWith("one"));
  assert.ok(r1.doc, "first sequential mutate resolves");
  const r2 = await session.mutate(() => docWith("two"));
  assert.ok(r2.doc, "second sequential mutate resolves — guard not tripped");
  assert.equal(FakeProvider.connectCount, 1, "sequential mutates reuse one provider");
});

test("connect timeout rejects with the connect-timeout text and fires the metric hook", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  __setCollabProviderFactory(factory({ autoSync: false }));
  let metricFired = 0;
  const p = acquireCollabSession("page-1", "tok", "http://h/api", {
    onConnectTimeout: () => {
      metricFired += 1;
    },
  });
  mock.timers.tick(25000);
  await assert.rejects(p, /Connection timeout to collaboration server/);
  assert.equal(metricFired, 1);
  assert.equal(__sessionCountForTests(), 0);
});

test("idle TTL destroys the session; re-acquire reconnects", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  process.env.MCP_COLLAB_SESSION_IDLE_MS = "1000";
  const a = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 1);
  mock.timers.tick(1000); // idle fires
  assert.equal(__sessionCountForTests(), 0, "idle timeout destroyed it");
  const b = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(a, b);
  assert.equal(FakeProvider.connectCount, 2);
});

test("max age is enforced at acquire (destroy + open fresh), idle held off", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  process.env.MCP_COLLAB_SESSION_MAX_AGE_MS = "1000";
  process.env.MCP_COLLAB_SESSION_IDLE_MS = "10000000"; // never fires in this test
  const a = await acquireCollabSession("page-1", "tok", "http://h/api");
  mock.timers.tick(2000); // past max age, below idle
  const b = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(a, b, "a session past its max age must be replaced");
  assert.equal(FakeProvider.connectCount, 2);
});

test("registry cap: least-recently-used session is destroy-evicted", async () => {
  process.env.MCP_COLLAB_SESSION_MAX_ENTRIES = "2";
  const s1 = await acquireCollabSession("page-1", "tok", "http://h/api");
  const p1prov = FakeProvider.last();
  const s2 = await acquireCollabSession("page-2", "tok", "http://h/api");
  const p2prov = FakeProvider.last();
  assert.equal(__sessionCountForTests(), 2);

  // Touch page-1 so page-2 becomes the least-recently-used entry.
  assert.equal(await acquireCollabSession("page-1", "tok", "http://h/api"), s1);
  assert.equal(FakeProvider.connectCount, 2, "reuse must not reconnect");

  // A third distinct page (cap 2) must evict the LRU (page-2), not page-1.
  const s3 = await acquireCollabSession("page-3", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 2);
  assert.equal(FakeProvider.connectCount, 3);
  assert.equal(p2prov.destroyed, true, "the LRU provider was destroy-evicted");
  assert.equal(p1prov.destroyed, false, "the MRU page-1 survived");

  // page-1 still reused (survived), page-3 still reused.
  assert.equal(await acquireCollabSession("page-1", "tok", "http://h/api"), s1);
  assert.equal(await acquireCollabSession("page-3", "tok", "http://h/api"), s3);
  assert.equal(FakeProvider.connectCount, 3, "no extra reconnects");
});

test("MCP_COLLAB_SESSION_IDLE_MS=0 disables the cache (legacy provider-per-op)", async () => {
  process.env.MCP_COLLAB_SESSION_IDLE_MS = "0";
  const s1 = await acquireCollabSession("page-1", "tok", "http://h/api");
  // Never registered (ephemeral).
  assert.equal(__sessionCountForTests(), 0);
  const r1 = await s1.mutate(() => docWith("a"));
  assert.ok(r1.doc);
  // After its single op the ephemeral session self-destroyed.
  assert.equal(FakeProvider.instances[0].destroyed, true);
  // A second op opens a BRAND NEW provider (no reuse).
  const s2 = await acquireCollabSession("page-1", "tok", "http://h/api");
  assert.notEqual(s1, s2);
  assert.equal(FakeProvider.connectCount, 2);
});

test("replaceImage-shaped flow: acquire under an EXTERNAL page lock does not deadlock and reuses one session", async () => {
  const pageId = "page-lock";
  // Mirror replaceImage: hold ONE withPageLock across scan (read-only) + write,
  // each going through the non-locking acquireCollabSession.
  const result = await withPageLock(pageId, async () => {
    // pass 1: read-only scan (transform returns null -> no write)
    const scan = await acquireCollabSession(pageId, "tok", "http://h/api");
    const scanRes = await scan.mutate(() => null);
    assert.equal(scanRes.verify.changed, false);
    // pass 2: the actual write, same held lock
    const write = await acquireCollabSession(pageId, "tok", "http://h/api");
    return write.mutate(() => docWith("repointed"));
  });
  assert.ok(result.doc, "the locked scan+write completed without deadlock");
  assert.equal(
    FakeProvider.connectCount,
    1,
    "both passes under the held lock reuse ONE live session",
  );
});

test("destroyAllSessions tears down every cached session", async () => {
  await acquireCollabSession("page-1", "tok", "http://h/api");
  await acquireCollabSession("page-2", "tok", "http://h/api");
  assert.equal(__sessionCountForTests(), 2);
  const provs = [...FakeProvider.instances];
  destroyAllSessions();
  assert.equal(__sessionCountForTests(), 0);
  assert.ok(provs.every((p) => p.destroyed), "all providers destroyed");
});
