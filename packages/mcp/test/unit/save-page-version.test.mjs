import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  destroyAllSessions,
  __setCollabProviderFactory,
} from "../../build/lib/collab-session.js";
import { savePageVersionRealtime } from "../../build/lib/collaboration.js";

// #370 — unit coverage for the MCP client transport of the explicit save-version.
// There is no collaboration server in the test env, so a fake HocuspocusProvider
// drives the stateless round-trip: it auto-completes the connect/sync handshake on
// a microtask (like the real provider), records sends, and — depending on the
// `reply` opt — either broadcasts a `version.saved` stateless message back or stays
// silent (to exercise the bounded-timeout path).
class FakeProvider extends EventEmitter {
  static instances = [];

  static reset() {
    FakeProvider.instances = [];
  }

  constructor(config, opts = {}) {
    super();
    this.config = config;
    this.synced = false;
    this.unsyncedChanges = 0;
    this.destroyed = false;
    this.sent = [];
    this.opts = opts;
    FakeProvider.instances.push(this);
    // Real HocuspocusProvider fires onSynced asynchronously after the handshake;
    // a microtask reproduces that without depending on timers (so mock.timers on
    // setTimeout does not stall the connect).
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.config.onConnect?.();
      this.synced = true;
      this.config.onSynced?.();
    });
  }

  destroy() {
    this.destroyed = true;
  }

  sendStateless(payload) {
    this.sent.push(payload);
    const reply = this.opts.reply;
    if (!reply) return; // silent → the caller must hit its timeout
    // Broadcast the configured server reply on a microtask, mirroring
    // document.broadcastStateless landing back on this provider's `stateless` event.
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.emit("stateless", { payload: JSON.stringify(reply) });
    });
  }
}

const ENV_KEYS = [
  "MCP_COLLAB_SESSION_IDLE_MS",
  "MCP_COLLAB_SESSION_MAX_AGE_MS",
  "MCP_COLLAB_SESSION_MAX_ENTRIES",
  "MCP_COLLAB_TOKEN_TTL_MS",
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  FakeProvider.reset();
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

test("resolves with the server's version.saved reply (historyId/kind/alreadySaved)", async () => {
  __setCollabProviderFactory(
    (config) =>
      new FakeProvider(config, {
        reply: {
          type: "version.saved",
          historyId: "hist-42",
          kind: "agent",
          alreadySaved: false,
        },
      }),
  );

  const result = await savePageVersionRealtime(
    "11111111-1111-4111-8111-111111111111",
    "collab-tok",
    "http://host/api",
  );

  assert.deepEqual(result, {
    historyId: "hist-42",
    kind: "agent",
    alreadySaved: false,
  });
  // The client actually asked the server to save a version (the stateless send).
  const provider = FakeProvider.instances.at(-1);
  assert.deepEqual(
    provider.sent.map((p) => JSON.parse(p)),
    [{ type: "save-version" }],
  );
});

test("surfaces alreadySaved=true (promote-not-dup / no-op save)", async () => {
  __setCollabProviderFactory(
    (config) =>
      new FakeProvider(config, {
        reply: {
          type: "version.saved",
          historyId: "hist-7",
          kind: "manual",
          alreadySaved: true,
        },
      }),
  );

  const result = await savePageVersionRealtime(
    "22222222-2222-4222-8222-222222222222",
    "collab-tok",
    "http://host/api",
  );

  assert.deepEqual(result, {
    historyId: "hist-7",
    kind: "manual",
    alreadySaved: true,
  });
});

test("rejects on a bounded timeout when the server never replies", async () => {
  __setCollabProviderFactory((config) => new FakeProvider(config, {})); // silent

  mock.timers.enable({ apis: ["setTimeout"] });
  const p = savePageVersionRealtime("33333333-3333-4333-8333-333333333333", "collab-tok", "http://host/api");
  // Swallow the eventual rejection so an unhandled-rejection does not race the tick.
  p.catch(() => {});

  // Flush the (microtask-driven) connect handshake + the stateless send so the
  // ack timer is armed before we advance the clock.
  await new Promise((r) => setImmediate(r));
  // Advance well past the 20s ack window; the connect timer (25s) does not fire.
  mock.timers.tick(20000 + 100);

  await assert.rejects(p, /Timeout waiting for a stateless reply/);
});
