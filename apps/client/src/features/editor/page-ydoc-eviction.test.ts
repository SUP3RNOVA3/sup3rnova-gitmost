import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDefaultStore } from "jotai";
import { QueryClient } from "@tanstack/react-query";
import type { IndexeddbPersistence } from "y-indexeddb";
import type { ICurrentUser } from "@/features/user/types/user.types";

/**
 * #564 guard 3 — access revoked (403) or page deleted (404) must destroy the
 * page's LOCAL ydoc, on disk, whether or not the editor is still mounted. The
 * collab room can never do this for us: an unauthorized room never syncs.
 *
 * The MAIN scenario is a FRESH SESSION (reload / bookmark / new tab) straight
 * onto a page whose access was revoked: the editor never mounts there (not-found
 * renders instead), so nothing in this module may depend on a successful mount —
 * neither the subscriber's installation (it lives in main.tsx) nor the
 * slugId -> pageId alias (it comes from #563's persisted page-meta boot cache).
 */

const PAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SLUG_ID = "slugid1";
const SCOPE_STORAGE_KEY = "pageMeta:v1:w1:u1";
// The scope key `scopeKeyAtom` yields for the `currentUser()` below
// (`<workspace>:<user>`), which now namespaces every ydoc database name.
const SCOPE = "w1:u1";

let localFirstEnabled = true;

vi.mock("@/lib/config", () => ({
  isLocalFirstEnabled: () => localFirstEnabled,
}));

function currentUser(): ICurrentUser {
  return {
    user: { id: "u1" },
    workspace: { id: "w1" },
  } as unknown as ICurrentUser;
}

/**
 * Seed the PERSISTED page-meta boot cache exactly as an earlier visit would have
 * left it: the page stored under BOTH aliases. This is the only record a fresh
 * session has of the `slugId -> pageId` mapping.
 */
function seedBootCache(pageId: string, slugId: string): void {
  const entry = {
    id: pageId,
    slugId,
    title: "Revoked page",
    icon: null,
    lastAccess: Date.now(),
  };
  localStorage.setItem(
    SCOPE_STORAGE_KEY,
    JSON.stringify({ [pageId]: entry, [slugId]: entry }),
  );
}

/** Fresh module instances, so the boot cache re-hydrates from localStorage. */
async function freshImport() {
  vi.resetModules();
  const userModule = await import("@/features/user/atoms/current-user-atom");
  getDefaultStore().set(userModule.currentUserAtom, currentUser());
  return import("./page-ydoc-eviction");
}

function fakePersistence() {
  return {
    clearData: vi.fn(async () => {}),
  } as unknown as IndexeddbPersistence & {
    clearData: ReturnType<typeof vi.fn>;
  };
}

let deleteDatabase: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localFirstEnabled = true;
  localStorage.clear();
  deleteDatabase = vi.fn(() => ({}) as IDBOpenDBRequest);
  vi.stubGlobal("indexedDB", { deleteDatabase });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Push a failed page query through a real QueryClient's cache. */
async function failPageQuery(
  queryClient: QueryClient,
  key: string,
  status: number,
) {
  await queryClient
    .fetchQuery({
      queryKey: ["pages", key],
      queryFn: async () => {
        throw Object.assign(new Error("nope"), { status });
      },
      retry: false,
    })
    .catch(() => undefined);
}

describe("evictPageYdoc", () => {
  it("clears the IDB data of a MOUNTED page (clearData destroys + deletes the db)", async () => {
    const mod = await freshImport();
    const persistence = fakePersistence();
    mod.registerPageYdoc({
      documentName: mod.pageYdocName(PAGE_ID, SCOPE),
      persistence,
      keys: [PAGE_ID, SLUG_ID],
    });

    await expect(mod.evictPageYdoc(SLUG_ID)).resolves.toBe(true);
    expect(persistence.clearData).toHaveBeenCalledTimes(1);
  });

  it("deletes the IDB database directly when the page is no longer mounted", async () => {
    const mod = await freshImport();
    const persistence = fakePersistence();
    mod.registerPageYdoc({
      documentName: mod.pageYdocName(PAGE_ID, SCOPE),
      persistence,
      keys: [PAGE_ID, SLUG_ID],
    });
    // The editor unmounted (page.tsx swapped to not-found) BEFORE the 403 landed.
    mod.unregisterPageYdoc(mod.pageYdocName(PAGE_ID, SCOPE));

    await expect(mod.evictPageYdoc(SLUG_ID)).resolves.toBe(true);
    expect(persistence.clearData).not.toHaveBeenCalled();
    expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`);
  });

  it("falls back to the raw db delete when clearData throws", async () => {
    const mod = await freshImport();
    const persistence = {
      clearData: vi.fn(async () => {
        throw new Error("idb gone");
      }),
    } as unknown as IndexeddbPersistence;
    mod.registerPageYdoc({
      documentName: mod.pageYdocName(PAGE_ID, SCOPE),
      persistence,
      keys: [PAGE_ID],
    });

    await mod.evictPageYdoc(PAGE_ID);
    expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`);
  });

  it("evicts a slugId this session never opened, via the persisted boot cache", async () => {
    // THE MAIN SCENARIO. Nothing was registered: the page was opened on an
    // EARLIER visit (leaving a ydoc on disk and a boot-cache entry), access was
    // then revoked, and the user opens the link again in a fresh tab. The editor
    // never mounts, so the session alias map is empty — the boot cache is what
    // maps the URL's slugId to the ydoc's pageId.
    seedBootCache(PAGE_ID, SLUG_ID);
    const mod = await freshImport();

    await expect(mod.evictPageYdoc(SLUG_ID)).resolves.toBe(true);
    expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`);
  });

  it("evicts a never-opened page by pageId; a slugId known to NOTHING is a no-op", async () => {
    const mod = await freshImport();
    // A bare uuid IS the ydoc name by construction, so no alias is needed.
    await expect(mod.evictPageYdoc(PAGE_ID)).resolves.toBe(true);
    expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`);

    deleteDatabase.mockClear();
    // A slugId in neither the session map nor the boot cache addresses a page
    // this device never opened — there is no local ydoc to destroy.
    await expect(mod.evictPageYdoc("never-seen-slug")).resolves.toBe(false);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });
});

describe("installPageYdocEviction (global page-query error subscriber)", () => {
  it("destroys the local ydoc on 403 and on 404", async () => {
    const mod = await freshImport();
    const queryClient = new QueryClient();
    const unsubscribe = mod.installPageYdocEviction(queryClient);

    const revoked = fakePersistence();
    mod.registerPageYdoc({
      documentName: mod.pageYdocName(PAGE_ID, SCOPE),
      persistence: revoked,
      keys: [PAGE_ID, SLUG_ID],
    });
    await failPageQuery(queryClient, SLUG_ID, 403);
    await vi.waitFor(() => expect(revoked.clearData).toHaveBeenCalledTimes(1));

    const deleted = fakePersistence();
    const otherPage = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mod.registerPageYdoc({
      documentName: mod.pageYdocName(otherPage, SCOPE),
      persistence: deleted,
      keys: [otherPage],
    });
    await failPageQuery(queryClient, otherPage, 404);
    await vi.waitFor(() => expect(deleted.clearData).toHaveBeenCalledTimes(1));

    unsubscribe();
  });

  it("destroys the ydoc of a REVOKED page that never mounted in this session", async () => {
    // End-to-end of the main scenario, through the real subscriber: a fresh
    // session opens the revoked page, the page query 403s, the editor never
    // mounts — and the revoked body must still leave the disk.
    seedBootCache(PAGE_ID, SLUG_ID);
    const mod = await freshImport();
    const queryClient = new QueryClient();
    const unsubscribe = mod.installPageYdocEviction(queryClient);

    await failPageQuery(queryClient, SLUG_ID, 403);

    await vi.waitFor(() =>
      expect(deleteDatabase).toHaveBeenCalledWith(`page.${SCOPE}.${PAGE_ID}`),
    );
    unsubscribe();
  });

  it("does nothing at all when the local-first flag is OFF", async () => {
    seedBootCache(PAGE_ID, SLUG_ID);
    localFirstEnabled = false;
    const mod = await freshImport();
    const queryClient = new QueryClient();
    const unsubscribe = mod.installPageYdocEviction(queryClient);

    await failPageQuery(queryClient, SLUG_ID, 403);

    await new Promise((r) => setTimeout(r, 0));
    expect(deleteDatabase).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("leaves the ydoc alone on other failures (500, offline) and on other queries", async () => {
    const mod = await freshImport();
    const queryClient = new QueryClient();
    const unsubscribe = mod.installPageYdocEviction(queryClient);

    const persistence = fakePersistence();
    mod.registerPageYdoc({
      documentName: mod.pageYdocName(PAGE_ID, SCOPE),
      persistence,
      keys: [PAGE_ID, SLUG_ID],
    });

    await failPageQuery(queryClient, SLUG_ID, 500);
    // A transport error (offline) carries no status at all — the local copy is
    // exactly what the user must keep seeing.
    await queryClient
      .fetchQuery({
        queryKey: ["pages", SLUG_ID, "other"],
        queryFn: async () => {
          throw new Error("network down");
        },
        retry: false,
      })
      .catch(() => undefined);

    await new Promise((r) => setTimeout(r, 0));
    expect(persistence.clearData).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();

    unsubscribe();
  });
});

describe("pageYdocName (namespacing by scope, #626)", () => {
  it("produces page.<scopeKey>.<pageId>", async () => {
    const mod = await freshImport();
    expect(mod.pageYdocName(PAGE_ID, "w1:u1")).toBe(`page.w1:u1.${PAGE_ID}`);
  });

  it("differs across scopes (non-vacuity: fails if the scope is ignored)", async () => {
    const mod = await freshImport();
    const a = mod.pageYdocName(PAGE_ID, "wA:uA");
    const b = mod.pageYdocName(PAGE_ID, "wB:uB");
    // The SAME page id in two scopes must NOT share a database — this is the
    // whole point of #626. If pageYdocName dropped its scope argument these
    // would be equal and the assertion would fail.
    expect(a).not.toBe(b);
  });

  it("is stable within a scope", async () => {
    const mod = await freshImport();
    expect(mod.pageYdocName(PAGE_ID, "w1:u1")).toBe(
      mod.pageYdocName(PAGE_ID, "w1:u1"),
    );
  });

  it("gives an anon scope a distinct, non-colliding name", async () => {
    const mod = await freshImport();
    // scopeKeyAtom yields "anon:anon" when signed out; real ids are uuids and
    // never the literal "anon", so the two namespaces can never collide.
    const anon = mod.pageYdocName(PAGE_ID, "anon:anon");
    const real = mod.pageYdocName(PAGE_ID, "w1:u1");
    expect(anon).toBe(`page.anon:anon.${PAGE_ID}`);
    expect(anon).not.toBe(real);
  });
});

/** An indexedDB stub whose `databases()` resolves to the given name list. */
function idbWithDatabases(names: string[]) {
  const del = vi.fn(() => ({}) as IDBOpenDBRequest);
  return {
    del,
    idb: {
      deleteDatabase: del,
      databases: vi.fn(async () => names.map((name) => ({ name }))),
    },
  };
}

describe("purgePageYdocDatabases (#626)", () => {
  it("deletes ONLY page.-prefixed databases, not others", async () => {
    const mod = await freshImport();
    const { del, idb } = idbWithDatabases([
      "page.w1:u1.pageA",
      "page.w2:u2.pageB",
      "keyval-store", // an unrelated app database — must survive
      "someOtherDb",
    ]);
    vi.stubGlobal("indexedDB", idb);

    mod.purgePageYdocDatabases();

    await vi.waitFor(() => {
      expect(del).toHaveBeenCalledWith("page.w1:u1.pageA");
      expect(del).toHaveBeenCalledWith("page.w2:u2.pageB");
    });
    expect(del).not.toHaveBeenCalledWith("keyval-store");
    expect(del).not.toHaveBeenCalledWith("someOtherDb");
  });

  it("does not throw and still deletes via the registry when databases() is unavailable (Firefox)", async () => {
    const mod = await freshImport();
    // Firefox: no `indexedDB.databases()`. The registry (localStorage) is the
    // only way to know which names to delete.
    mod.rememberYdocDbName("page.w1:u1.pageA");
    mod.rememberYdocDbName("not-a-page-db"); // ignored by rememberYdocDbName
    const del = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal("indexedDB", { deleteDatabase: del }); // no databases()

    expect(() => mod.purgePageYdocDatabases()).not.toThrow();
    expect(del).toHaveBeenCalledWith("page.w1:u1.pageA");
    expect(del).not.toHaveBeenCalledWith("not-a-page-db");
    // The registry is cleared after a purge.
    expect(localStorage.getItem("pageYdoc.dbNames.v1")).toBeNull();
  });
});

describe("migratePageYdocDatabasesOnce (#626 legacy cleanup)", () => {
  it("deletes legacy page.<pageId> but leaves page.<scope>.<pageId> intact, and runs once", async () => {
    const mod = await freshImport();
    const legacy = `page.${PAGE_ID}`; // un-namespaced (no scope colon)
    const namespaced = `page.w1:u1.${PAGE_ID}`; // current user's DB — must survive
    const { del, idb } = idbWithDatabases([legacy, namespaced, "keyval-store"]);
    vi.stubGlobal("indexedDB", idb);

    mod.migratePageYdocDatabasesOnce();

    await vi.waitFor(() =>
      expect(del).toHaveBeenCalledWith(legacy),
    );
    expect(del).not.toHaveBeenCalledWith(namespaced);
    expect(del).not.toHaveBeenCalledWith("keyval-store");
    // The one-time flag is now set.
    expect(localStorage.getItem("pageYdoc.legacyPurged.v1")).toBe("1");

    // Second call is a no-op: the flag short-circuits before any enumeration.
    del.mockClear();
    idb.databases.mockClear();
    mod.migratePageYdocDatabasesOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(idb.databases).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("marks itself done without deleting when databases() is unavailable (Firefox)", async () => {
    const mod = await freshImport();
    const del = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal("indexedDB", { deleteDatabase: del }); // no databases()

    expect(() => mod.migratePageYdocDatabasesOnce()).not.toThrow();
    expect(del).not.toHaveBeenCalled();
    expect(localStorage.getItem("pageYdoc.legacyPurged.v1")).toBe("1");
  });
});

describe("pageYdocRoomName vs pageYdocName (collab room != db name)", () => {
  // Mirrors the SERVER contract in apps/server/src/collaboration/
  // collaboration.util.ts: getPageId(documentName) = documentName.split(".")[1].
  // The collab ROOM name is what the client passes to HocuspocusProvider.name, so
  // it MUST resolve back to the pageId here. #626 wired the scoped DB name into the
  // room name, so the server resolved the scope instead of the pageId and rejected
  // every authenticated collab connection — this locks that regression out.
  const serverGetPageId = (documentName: string) => documentName.split(".")[1];

  it("room name resolves to the pageId under the server's getPageId contract", async () => {
    const mod = await freshImport();
    const room = mod.pageYdocRoomName(PAGE_ID);
    expect(room).toBe(`page.${PAGE_ID}`);
    expect(serverGetPageId(room)).toBe(PAGE_ID);
  });

  it("the SCOPED db name must NOT be used as the room name (it resolves to the scope)", async () => {
    const mod = await freshImport();
    const dbName = mod.pageYdocName(PAGE_ID, SCOPE);
    // The db name is deliberately 3-segment (page.<scope>.<pageId>); feeding it to
    // the collab room resolves the SCOPE, not the pageId — the #626 break.
    expect(serverGetPageId(dbName)).toBe(SCOPE);
    expect(serverGetPageId(dbName)).not.toBe(PAGE_ID);
    // The room name and the db name are distinct by construction.
    expect(mod.pageYdocRoomName(PAGE_ID)).not.toBe(dbName);
  });
});
