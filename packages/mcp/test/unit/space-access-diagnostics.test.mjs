// Issue #534: enrich-on-404 space-access diagnostics.
//
// When a tool is handed a well-formed but non-existent/inaccessible spaceId, the
// server answers the space-permissions check with an opaque 404 ("Space
// permissions not found"). The client wrapper (withSpaceAccessDiagnostics) turns
// ONLY that 404 into an actionable message naming the bad spaceId and the spaces
// the token can actually see — while FAILING OPEN (rethrowing the original
// server error unchanged) on every source of uncertainty.
//
// These tests drive the assembled DocmostClient with its inner seams
// (enumerateSpacePages / client.post / paginateAllWithMeta) stubbed at runtime,
// mirroring the stub-client style of error-diagnostics.test.mjs. Only criterion
// 9 (createPage is NOT wrapped) uses a real offline http server, because
// createPage's 404 arrives over a bare-axios multipart path.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import axios, { AxiosError } from "axios";
import {
  DocmostClient,
  formatSpaceNotAccessible,
} from "../../build/client.js";

// Two accessible spaces (id + name is all getAccessibleSpaceIndex maps/uses).
const SPACES = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Engineering" },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Design" },
];
// A well-formed UUID that is NOT among the accessible spaces.
const BAD = "99999999-9999-4999-8999-999999999999";

// Build an AxiosError shaped exactly as the response interceptor would hand it
// on a 404 — status readable, axios.isAxiosError() true.
function make404(url = "/pages/tree") {
  const config = { method: "post", url, baseURL: "http://host.example/api" };
  const response = {
    status: 404,
    statusText: "Not Found",
    data: { message: "Space permissions not found" },
    headers: {},
    config,
  };
  return new AxiosError(
    "Request failed with status code 404",
    "ERR_BAD_REQUEST",
    config,
    {},
    response,
  );
}

// A client whose token is pre-set (so ensureAuthenticated never hits the
// network) and whose /spaces sweep is a counted stub. Individual tests override
// enumerateSpacePages / client.post to shape the method-under-test's outcome.
function makeClient({ spaces = SPACES, truncated = false } = {}) {
  const c = new DocmostClient("http://127.0.0.1:1/api", "u@example.com", "pw");
  c.token = "t";
  c.client.defaults.headers.common["Authorization"] = "Bearer t";
  c._spacesFetches = 0;
  c.paginateAllWithMeta = async (endpoint) => {
    if (endpoint === "/spaces") {
      c._spacesFetches++;
      return { items: spaces, truncated };
    }
    throw new Error(`unexpected paginate endpoint ${endpoint}`);
  };
  return c;
}

// --- Criterion 1: bad spaceId on getTree -> actionable rewrite --------------
test("getTree with a non-existent spaceId is rewritten into an actionable hint", async () => {
  const c = makeClient();
  c.enumerateSpacePages = async () => {
    throw make404();
  };

  await assert.rejects(
    () => c.getTree(BAD),
    (e) => {
      assert.ok(e.message.includes(BAD), "names the passed spaceId");
      // At least one valid "id (name)" pair.
      assert.ok(
        e.message.includes(`${SPACES[0].id} (${SPACES[0].name})`),
        "lists an accessible id (name)",
      );
      assert.ok(e.message.includes("listSpaces"), "points at listSpaces");
      assert.ok(
        !e.message.includes("Space permissions not found"),
        "the opaque server text is replaced",
      );
      return true;
    },
  );
  assert.equal(c._spacesFetches, 1, "one /spaces sweep on the enrichment path");
});

// --- Criterion 2: happy path -> no /spaces request --------------------------
test("getTree with a valid spaceId returns the tree and makes NO /spaces request", async () => {
  const c = makeClient();
  // Spy client.post to prove no /spaces POST is issued on the happy path.
  const posted = [];
  c.client.post = async (url) => {
    posted.push(url);
    throw new Error(`unexpected post ${url}`);
  };
  c.enumerateSpacePages = async () => ({ pages: [], truncated: false });

  const res = await c.getTree(SPACES[0].id);
  assert.ok(Array.isArray(res), "tree returned as before");
  assert.equal(c._spacesFetches, 0, "no /spaces sweep on the happy path");
  assert.ok(
    !posted.includes("/spaces"),
    "no /spaces POST on the happy path",
  );
});

// --- Criterion 3: short-TTL cache + refetch after expiry --------------------
test("two bad getTree within TTL share ONE /spaces fetch; a refetch happens after TTL", async () => {
  const c = makeClient();
  c.enumerateSpacePages = async () => {
    throw make404();
  };

  await assert.rejects(() => c.getTree(BAD), /не найден среди/);
  await assert.rejects(() => c.getTree(BAD), /не найден среди/);
  assert.equal(c._spacesFetches, 1, "second call served from cache");

  // Age the cache past the default 60s TTL -> exactly one refetch.
  assert.ok(c.spaceIndexCache, "a complete result was cached");
  c.spaceIndexCache.fetchedAt = Date.now() - 10 * 60 * 1000;
  await assert.rejects(() => c.getTree(BAD), /не найден среди/);
  assert.equal(c._spacesFetches, 2, "exactly one refetch after TTL");
});

// --- Criterion 4: no spaceId -> wrapper inert -------------------------------
test("listPages WITHOUT spaceId is inert (raw error propagates, no /spaces sweep)", async () => {
  const c = makeClient();
  c.client.post = async () => {
    throw make404("/pages/recent");
  };
  await assert.rejects(
    () => c.listPages(),
    (e) => {
      assert.equal(e.response?.status, 404, "raw server 404 propagates");
      assert.ok(!/не найден среди/.test(e.message ?? ""), "not rewritten");
      return true;
    },
  );
  assert.equal(c._spacesFetches, 0, "no /spaces sweep without a spaceId");
});

test("search WITHOUT spaceId is inert (raw error propagates, no /spaces sweep)", async () => {
  const c = makeClient();
  c.client.post = async () => {
    throw make404("/search");
  };
  await assert.rejects(
    () => c.search("query"),
    (e) => {
      assert.equal(e.response?.status, 404, "raw server 404 propagates");
      assert.ok(!/не найден среди/.test(e.message ?? ""), "not rewritten");
      return true;
    },
  );
  assert.equal(c._spacesFetches, 0, "no /spaces sweep without a spaceId");
});

// --- Criterion 5: incomplete listing -> fail open ---------------------------
test("a truncated /spaces listing (!complete) fails OPEN with the original 404", async () => {
  const c = makeClient({ truncated: true });
  c.enumerateSpacePages = async () => {
    throw make404();
  };
  await assert.rejects(
    () => c.getTree(BAD),
    (e) => {
      assert.equal(e.response?.status, 404, "original server error preserved");
      assert.ok(!/не найден среди/.test(e.message ?? ""), "no false rewrite");
      return true;
    },
  );
  assert.equal(c.spaceIndexCache, null, "a truncated result is never cached");
});

// --- Criterion 6: /spaces fetch fails -> fail open; in-flight nulled on reject
test("a /spaces fetch failure fails OPEN, logs under DEBUG, and never memoizes the rejected in-flight promise", async () => {
  const c = makeClient();
  let fetchCount = 0;
  c.paginateAllWithMeta = async () => {
    fetchCount++;
    throw new Error("network boom");
  };
  c.enumerateSpacePages = async () => {
    throw make404();
  };

  const prevDebug = process.env.DEBUG;
  process.env.DEBUG = "1";
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.map(String).join(" "));
  try {
    await assert.rejects(
      () => c.getTree(BAD),
      (e) => {
        assert.equal(e.response?.status, 404, "original 404 rethrown");
        return true;
      },
    );
  } finally {
    console.error = origErr;
    if (prevDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = prevDebug;
  }

  assert.ok(
    errs.some((l) => l.includes("space-diag: /spaces fetch failed")),
    "a DEBUG stderr line is emitted",
  );
  assert.equal(c.spaceIndexInFlight, null, "in-flight promise nulled on reject");

  // The rejected in-flight promise must NOT be reused: a second enrichment does
  // a genuinely fresh fetch (fetchCount increments to 2).
  await assert.rejects(
    () => c.getTree(BAD),
    (e) => e.response?.status === 404,
  );
  assert.equal(fetchCount, 2, "fresh fetch — rejected promise not memoized");
});

// --- Criterion 7: zero accessible spaces ------------------------------------
test("zero accessible spaces yields the dedicated 'no accessible spaces' message", async () => {
  const c = makeClient({ spaces: [] });
  c.enumerateSpacePages = async () => {
    throw make404();
  };
  await assert.rejects(
    () => c.getTree(BAD),
    (e) => {
      assert.ok(
        e.message.includes("доступных тебе спейсов нет"),
        "the zero-spaces branch fired",
      );
      assert.ok(e.message.includes(BAD), "still names the bad spaceId");
      return true;
    },
  );
});

// --- Criterion 8: abort/cap during enrichment -------------------------------
test("an aborted signal (custom/TimeoutError reason) propagates its reason, not a rewrite, and skips the sweep", async () => {
  const c = makeClient();
  const ac = new AbortController();
  const reason = new Error("per-call cap exceeded");
  reason.name = "TimeoutError"; // NOT 'AbortError' — hole B
  ac.abort(reason);
  c.setToolAbortSignal(ac.signal);
  // Simulate paginateAll's throwIfAborted(): the inner op rejects with the
  // signal's reason (not an AxiosError).
  c.enumerateSpacePages = async () => {
    throw ac.signal.reason;
  };

  await assert.rejects(
    () => c.getTree(BAD),
    (e) => {
      assert.equal(e, reason, "the abort/cap reason itself propagates");
      assert.equal(e.name, "TimeoutError");
      assert.ok(!/не найден среди/.test(e.message ?? ""), "no rewrite");
      return true;
    },
  );
  assert.equal(c._spacesFetches, 0, "abort short-circuits before any sweep");
});

// --- Criterion 9: createPage is NOT wrapped (real offline server) -----------
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}
function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
}
const openServers = [];
function spawn(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const { port } = server.address();
      resolve({ baseURL: `http://127.0.0.1:${port}/api` });
    });
  });
}
after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
});

test("createPage with an inaccessible spaceId returns the server error as-is (NOT wrapped)", async () => {
  const { baseURL } = await spawn(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/auth/login") {
      sendJson(res, 200, { success: true }, {
        "Set-Cookie": "authToken=t; Path=/; HttpOnly",
      });
      return;
    }
    if (req.url === "/api/pages/import") {
      // The space-permissions 404 createPage would see for a bad spaceId.
      sendJson(res, 404, { message: "Space permissions not found" });
      return;
    }
    sendJson(res, 404, {});
  });

  const client = new DocmostClient(baseURL, "u@example.com", "pw");
  // Prove the diagnostics path is never entered from createPage.
  let idxCalls = 0;
  const realIdx = client.getAccessibleSpaceIndex.bind(client);
  client.getAccessibleSpaceIndex = async () => {
    idxCalls++;
    return realIdx();
  };

  await assert.rejects(
    () => client.createPage("Title", "body", BAD),
    (e) => {
      assert.equal(e.response?.status, 404, "the raw server 404 surfaces");
      assert.ok(
        !/не найден среди/.test(e.message ?? ""),
        "createPage's 404 is NOT rewritten (multi-cause path)",
      );
      return true;
    },
  );
  assert.equal(idxCalls, 0, "createPage never invokes the space diagnostics");
});

// --- formatSpaceNotAccessible unit shape ------------------------------------
test("formatSpaceNotAccessible caps the inline list at 10 and appends a (+N ещё) tail", () => {
  const many = Array.from({ length: 13 }, (_, i) => ({
    id: `id-${i}`,
    name: `Space ${i}`,
  }));
  const msg = formatSpaceNotAccessible("getTree", BAD, many);
  assert.ok(msg.includes("id-0 (Space 0)"));
  assert.ok(msg.includes("id-9 (Space 9)"), "10th entry (index 9) is shown");
  assert.ok(!msg.includes("id-10 (Space 10)"), "the 11th is collapsed");
  assert.ok(msg.includes("(+3 ещё, см. listSpaces)"), "tail counts the remainder");
});
