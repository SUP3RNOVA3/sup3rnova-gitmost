import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { applyPushActions, LAST_PUSHED_REF } from '../src/engine/push';
import { bodyHash } from '../src/engine/loop-guard';
import type { ApplyPushDeps, PushActions } from '../src/engine/push';
import {
  parseDocmostMarkdown,
  serializeDocmostMarkdownBody,
} from '../src/lib/index';

// FS→Docmost push, FIRST increment (SPEC §6). `applyPushActions` is the THIN IO
// half: create/update/delete via FAKES that record every call — no real network,
// git, or fs. Asserts: update uses importPageMarkdown (collab path, SPEC
// §2/§15.6); create writes the assigned pageId BACK into the file meta; delete
// soft-deletes; rename/move is returned as `deferred` with NO client call; the
// last-pushed ref is advanced.

/** A recording client fake; createPage returns a configurable assigned id. */
function makeClient(opts?: { createId?: string }) {
  const client = {
    importPageMarkdown: vi.fn(async (_pageId: string, _md: string) => ({
      success: true,
    })),
    createPage: vi.fn(
      async (
        title: string,
        _content: string,
        _spaceId: string,
        _parentPageId?: string,
      ) => ({
        // Mirrors the real `createPage` shape: `{ data: { id, ... }, success }`.
        data: { id: opts?.createId ?? 'assigned-id', title },
        success: true,
      }),
    ),
    deletePage: vi.fn(async (_pageId: string) => ({ success: true })),
    movePage: vi.fn(
      async (
        _pageId: string,
        _parentPageId: string | null,
        _position?: string,
      ) => ({ success: true }),
    ),
    renamePage: vi.fn(async (pageId: string, title: string) => ({
      success: true,
      pageId,
      title,
    })),
  };
  return client;
}

/**
 * A recording git fake: `updateRef` (advance last-pushed) and `fastForwardBranch`
 * (advance the `docmost` mirror, the loop-close). `ffResult` configures what the
 * ff returns (default a successful advance).
 */
function makeGit(opts?: {
  ffResult?: { ok: boolean; reason?: string };
  /** Pre-image tree at `refs/docmost/last-pushed` (path -> text). */
  prevTree?: Record<string, string>;
}) {
  const updateRefCalls: { ref: string; target: string }[] = [];
  const ffCalls: { branch: string; toCommit: string }[] = [];
  const prevTree = opts?.prevTree ?? {};
  const git = {
    updateRef: vi.fn(async (ref: string, target: string) => {
      updateRefCalls.push({ ref, target });
    }),
    fastForwardBranch: vi.fn(async (branch: string, toCommit: string) => {
      ffCalls.push({ branch, toCommit });
      return opts?.ffResult ?? { ok: true };
    }),
    // The move/rename classifier reads the PREVIOUS parent folder's `.md` at
    // refs/docmost/last-pushed via this; `null` when absent there (SPEC §5).
    showFileAtRef: vi.fn(async (_ref: string, path: string) =>
      path in prevTree ? prevTree[path] : null,
    ),
  };
  return { git, updateRefCalls, ffCalls };
}

/** A recording fs fake over a path->text store. */
function makeFs(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const writes: { path: string; text: string }[] = [];
  const reads: string[] = [];
  const fs = {
    readFile: vi.fn(async (path: string) => {
      reads.push(path);
      if (!(path in store)) throw new Error(`no such file: ${path}`);
      return store[path];
    }),
    writeFile: vi.fn(async (path: string, text: string) => {
      store[path] = text;
      writes.push({ path, text });
    }),
  };
  return { fs, store, writes, reads };
}

function deps(client: any, git: any, fs: ReturnType<typeof makeFs>): ApplyPushDeps {
  return {
    client,
    git,
    readFile: fs.fs.readFile,
    writeFile: fs.fs.writeFile,
  };
}

function actions(partial: Partial<PushActions>): PushActions {
  return {
    creates: [],
    updates: [],
    deletes: [],
    renamesMoves: [],
    skipped: [],
    ...partial,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyPushActions — update (collab path, SPEC §2/§15.6)', () => {
  it('reads the file body and calls importPageMarkdown with it', async () => {
    const fileBody =
      '<!-- docmost:meta\n{"version":1,"pageId":"p-1"}\n-->\n\nupdated body\n';
    const client = makeClient();
    const { git } = makeGit();
    const fs = makeFs({ 'Doc.md': fileBody });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ updates: [{ pageId: 'p-1', path: 'Doc.md' }] }),
    );

    expect(res.updated).toBe(1);
    // The collab/Yjs write path is used — NOT a raw jsonb overwrite.
    expect(client.importPageMarkdown).toHaveBeenCalledTimes(1);
    expect(client.importPageMarkdown).toHaveBeenCalledWith('p-1', fileBody, null);
    // No raw-overwrite path exists on the injected client surface at all.
    expect((client as any).updatePageJson).toBeUndefined();
    expect(client.createPage).not.toHaveBeenCalled();
    expect(client.deletePage).not.toHaveBeenCalled();
  });

  it('forwards the last-pushed base body (3-way merge ancestor) when present', async () => {
    const baseBody =
      '<!-- docmost:meta\n{"version":1,"pageId":"p-1"}\n-->\n\nbase body\n';
    const fileBody =
      '<!-- docmost:meta\n{"version":1,"pageId":"p-1"}\n-->\n\nupdated body\n';
    const client = makeClient();
    // The pre-image (refs/docmost/last-pushed) carries the base version.
    const { git } = makeGit({ prevTree: { 'Doc.md': baseBody } });
    const fs = makeFs({ 'Doc.md': fileBody });

    await applyPushActions(
      deps(client, git, fs),
      actions({ updates: [{ pageId: 'p-1', path: 'Doc.md' }] }),
    );

    // importPageMarkdown receives the base so the server can 3-way merge it.
    expect(client.importPageMarkdown).toHaveBeenCalledWith(
      'p-1',
      fileBody,
      baseBody,
    );
    expect(git.showFileAtRef).toHaveBeenCalledWith(LAST_PUSHED_REF, 'Doc.md');
  });
});

describe('applyPushActions — create (assigned pageId written back to meta)', () => {
  it('createPage is called and the new pageId is serialized back into the file', async () => {
    // A brand-new local file: meta has title/spaceId but NO pageId yet.
    const original = serializeDocmostMarkdownBody(
      { version: 1, title: 'My New Page', spaceId: 'sp-7', parentPageId: 'parent-9' },
      '# My New Page\n\nbody text',
    );
    const client = makeClient({ createId: 'page-new-42' });
    const { git } = makeGit();
    const fs = makeFs({ 'New.md': original });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'New.md' }] }),
    );

    expect(res.created).toBe(1);
    // createPage was called with title/body/spaceId/parentPageId from meta.
    expect(client.createPage).toHaveBeenCalledTimes(1);
    const [title, content, spaceId, parentPageId] =
      client.createPage.mock.calls[0];
    expect(title).toBe('My New Page');
    expect(spaceId).toBe('sp-7');
    expect(parentPageId).toBe('parent-9');
    expect(content).toContain('body text');

    // The file was rewritten with the assigned pageId in meta...
    expect(fs.writes.map((w) => w.path)).toEqual(['New.md']);
    const rewritten = fs.store['New.md'];
    const parsed = parseDocmostMarkdown(rewritten);
    expect(parsed.meta?.pageId).toBe('page-new-42');
    // ...preserving the rest of the meta and the body.
    expect(parsed.meta?.title).toBe('My New Page');
    expect(parsed.meta?.spaceId).toBe('sp-7');
    expect(parsed.body).toContain('body text');

    // The write-back is recorded so a follow-up commit can be made (NEXT inc).
    expect(res.writtenBack).toEqual([{ path: 'New.md', pageId: 'page-new-42' }]);
  });
});

describe('applyPushActions — delete (soft-delete to Trash, SPEC §8)', () => {
  it('calls deletePage(pageId)', async () => {
    const client = makeClient();
    const { git } = makeGit();
    const fs = makeFs();

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ deletes: [{ pageId: 'p-del' }] }),
    );

    expect(res.deleted).toBe(1);
    expect(client.deletePage).toHaveBeenCalledTimes(1);
    expect(client.deletePage).toHaveBeenCalledWith('p-del');
    // No body read needed for a delete.
    expect(fs.reads).toEqual([]);
  });
});

// FS→Docmost push #3 (SPEC §5/§6/§16): the move/rename APPLY. The classifier
// resolves the parent from the FILE PATH (the enclosing folder's `.md`), not
// stale `meta.parentPageId`, then `applyPushActions` calls move_page / rename_page
// (both for a reparent+retitle) or records a path-only NO-OP with NO client call.

/**
 * Helper: a self-contained file with the given pageId + title in its meta. Used
 * both to seed the working tree (fs) and the prev tree (git.showFileAtRef).
 */
function fileWith(meta: { pageId: string; title?: string }): string {
  return serializeDocmostMarkdownBody(
    { version: 1, pageId: meta.pageId, ...(meta.title ? { title: meta.title } : {}) },
    'body',
  );
}

describe('applyPushActions — move (parent changed, title same; SPEC §5/§16)', () => {
  it('calls movePage(pageId, newParent) and NOT renamePage', async () => {
    // The page moved from the space root (Doc.md) under a folder (Parent/Doc.md).
    // The new parent page's file is `Parent.md`; its meta carries the parent id.
    const client = makeClient();
    const { git } = makeGit({
      // Prev pre-image: the file used to sit at the root (parent ROOT).
      prevTree: { 'Doc.md': fileWith({ pageId: 'p-mv', title: 'Doc' }) },
    });
    const fs = makeFs({
      // Current tree: the moved file + its new parent folder's `.md`.
      'Parent/Doc.md': fileWith({ pageId: 'p-mv', title: 'Doc' }),
      'Parent.md': fileWith({ pageId: 'parent-id', title: 'Parent' }),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-mv', oldPath: 'Doc.md', newPath: 'Parent/Doc.md' },
        ],
      }),
    );

    expect(res.moved).toBe(1);
    expect(res.renamed).toBe(0);
    expect(client.movePage).toHaveBeenCalledTimes(1);
    // Reparented under `parent-id`; position left UNDEFINED (client default).
    expect(client.movePage).toHaveBeenCalledWith('p-mv', 'parent-id');
    expect(client.renamePage).not.toHaveBeenCalled();
    expect(res.noops).toEqual([]);
  });
});

describe('applyPushActions — move-to-root (newParent null; SPEC §16)', () => {
  it('calls movePage(pageId, null) when the file lands at the space root', async () => {
    const client = makeClient();
    const { git } = makeGit({
      // Prev: the file used to live under `Parent/`, so its old parent is the
      // page whose file is `Parent.md` (parent-id).
      prevTree: {
        'Parent/Doc.md': fileWith({ pageId: 'p-mv', title: 'Doc' }),
        'Parent.md': fileWith({ pageId: 'parent-id', title: 'Parent' }),
      },
    });
    // Current: the file is now at the root -> no enclosing folder -> parent ROOT.
    const fs = makeFs({ 'Doc.md': fileWith({ pageId: 'p-mv', title: 'Doc' }) });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-mv', oldPath: 'Parent/Doc.md', newPath: 'Doc.md' },
        ],
      }),
    );

    expect(res.moved).toBe(1);
    expect(client.movePage).toHaveBeenCalledWith('p-mv', null);
    expect(client.renamePage).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — rename (same parent, title changed; SPEC §5/§6)', () => {
  it('calls renamePage(pageId, title) and NOT movePage', async () => {
    // Same enclosing folder on both sides (parent unchanged), only the title
    // changed in meta -> a pure rename.
    const client = makeClient();
    const { git } = makeGit({
      prevTree: {
        'Folder/Old.md': fileWith({ pageId: 'p-rn', title: 'Old Title' }),
        'Folder.md': fileWith({ pageId: 'folder-id', title: 'Folder' }),
      },
    });
    const fs = makeFs({
      'Folder/New.md': fileWith({ pageId: 'p-rn', title: 'New Title' }),
      'Folder.md': fileWith({ pageId: 'folder-id', title: 'Folder' }),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-rn', oldPath: 'Folder/Old.md', newPath: 'Folder/New.md' },
        ],
      }),
    );

    expect(res.renamed).toBe(1);
    expect(res.moved).toBe(0);
    expect(client.renamePage).toHaveBeenCalledTimes(1);
    expect(client.renamePage).toHaveBeenCalledWith('p-rn', 'New Title');
    expect(client.movePage).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — both (reparent + retitle; move THEN rename)', () => {
  it('calls movePage first, then renamePage', async () => {
    const callOrder: string[] = [];
    const client = makeClient();
    client.movePage.mockImplementation(async () => {
      callOrder.push('move');
      return { success: true };
    });
    client.renamePage.mockImplementation(async (pageId: string, title: string) => {
      callOrder.push('rename');
      return { success: true, pageId, title };
    });
    const { git } = makeGit({
      // Prev: at root (parent ROOT) with the old title.
      prevTree: { 'Old.md': fileWith({ pageId: 'p-x', title: 'Old' }) },
    });
    const fs = makeFs({
      // Current: under a new folder AND retitled.
      'NewParent/New.md': fileWith({ pageId: 'p-x', title: 'New' }),
      'NewParent.md': fileWith({ pageId: 'np-id', title: 'NewParent' }),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-x', oldPath: 'Old.md', newPath: 'NewParent/New.md' },
        ],
      }),
    );

    expect(res.moved).toBe(1);
    expect(res.renamed).toBe(1);
    expect(client.movePage).toHaveBeenCalledWith('p-x', 'np-id');
    expect(client.renamePage).toHaveBeenCalledWith('p-x', 'New');
    // Order matters: reparent FIRST, then retitle.
    expect(callOrder).toEqual(['move', 'rename']);
  });
});

describe('applyPushActions — noop (path-only rename; NO Docmost call; SPEC §5)', () => {
  it('calls NEITHER movePage NOR renamePage and records the noop', async () => {
    // Same enclosing folder AND same title on both sides: a purely LOCAL file
    // rename. The page is its pageId; the path is cosmetic -> Docmost untouched.
    const client = makeClient();
    const { git } = makeGit({
      prevTree: {
        'Folder/A.md': fileWith({ pageId: 'p-noop', title: 'Same' }),
        'Folder.md': fileWith({ pageId: 'folder-id', title: 'Folder' }),
      },
    });
    const fs = makeFs({
      'Folder/B.md': fileWith({ pageId: 'p-noop', title: 'Same' }),
      'Folder.md': fileWith({ pageId: 'folder-id', title: 'Folder' }),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-noop', oldPath: 'Folder/A.md', newPath: 'Folder/B.md' },
        ],
      }),
    );

    expect(res.moved).toBe(0);
    expect(res.renamed).toBe(0);
    // ZERO Docmost calls for a cosmetic rename.
    expect(client.movePage).not.toHaveBeenCalled();
    expect(client.renamePage).not.toHaveBeenCalled();
    expect(res.noops).toEqual([
      {
        pageId: 'p-noop',
        oldPath: 'Folder/A.md',
        newPath: 'Folder/B.md',
        reason: 'path-only-rename',
      },
    ]);
  });
});

describe('applyPushActions — move whose client call throws (SPEC §12 isolation)', () => {
  it('isolates the failure into `failures` and does NOT advance the refs', async () => {
    const client = makeClient();
    client.movePage.mockImplementation(async () => {
      throw new Error('move boom');
    });
    const { git, updateRefCalls, ffCalls } = makeGit({
      prevTree: { 'Doc.md': fileWith({ pageId: 'p-mv', title: 'Doc' }) },
    });
    const fs = makeFs({
      'Parent/Doc.md': fileWith({ pageId: 'p-mv', title: 'Doc' }),
      'Parent.md': fileWith({ pageId: 'parent-id', title: 'Parent' }),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-mv', oldPath: 'Doc.md', newPath: 'Parent/Doc.md' },
        ],
      }),
      'sha-move-fail',
    );

    expect(res.moved).toBe(0);
    expect(res.failures).toEqual([
      {
        kind: 'move',
        pageId: 'p-mv',
        path: 'Parent/Doc.md',
        error: 'move boom',
      },
    ]);
    // A failure means the refs are NOT advanced — a re-run retries cleanly (§12).
    expect(res.lastPushedAdvanced).toBe(false);
    expect(updateRefCalls).toEqual([]);
    expect(ffCalls).toEqual([]);
    expect(git.updateRef).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — loop-close: ref advance + docmost ff (SPEC §6 step 3 / §10)', () => {
  it('advances last-pushed AND fast-forwards the docmost mirror on a clean push', async () => {
    const client = makeClient();
    const { git, updateRefCalls, ffCalls } = makeGit();
    const fs = makeFs();

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ deletes: [{ pageId: 'p' }] }),
      'commit-sha-abc',
    );

    expect(res.lastPushedAdvanced).toBe(true);
    expect(updateRefCalls).toEqual([
      { ref: LAST_PUSHED_REF, target: 'commit-sha-abc' },
    ]);
    // The loop-close: the docmost mirror is fast-forwarded to the pushed commit.
    expect(ffCalls).toEqual([{ branch: 'docmost', toCommit: 'commit-sha-abc' }]);
    expect(res.docmostFastForward).toEqual({ ok: true });
  });

  it('surfaces a REFUSED non-fast-forward (mirror NOT clobbered)', async () => {
    const client = makeClient();
    // The ff is refused because docmost is not an ancestor of the pushed commit.
    const { git, updateRefCalls, ffCalls } = makeGit({
      ffResult: { ok: false, reason: 'not-fast-forward' },
    });
    const fs = makeFs();

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ deletes: [{ pageId: 'p' }] }),
      'sha-div',
    );

    // last-pushed still advances (it is our own marker), but the ff result is
    // surfaced so the caller can log the refusal.
    expect(res.lastPushedAdvanced).toBe(true);
    expect(updateRefCalls).toEqual([{ ref: LAST_PUSHED_REF, target: 'sha-div' }]);
    expect(ffCalls).toEqual([{ branch: 'docmost', toCommit: 'sha-div' }]);
    expect(res.docmostFastForward).toEqual({ ok: false, reason: 'not-fast-forward' });
  });

  it('does NOT advance either ref when no pushed commit is given', async () => {
    const client = makeClient();
    const { git, updateRefCalls } = makeGit();
    const fs = makeFs();

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ updates: [] }),
    );

    expect(res.lastPushedAdvanced).toBe(false);
    expect(updateRefCalls).toEqual([]);
    expect(res.docmostFastForward).toBeNull();
    expect(git.updateRef).not.toHaveBeenCalled();
    expect(git.fastForwardBranch).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — per-page error isolation + refs gated on success (SPEC §12)', () => {
  it('continues the batch when an update throws; records the failure; refs NOT advanced', async () => {
    // A client whose 2nd importPageMarkdown call throws — the 1st and 3rd must
    // still be applied, the 2nd recorded as a failure, and NO ref advanced.
    let call = 0;
    const client = {
      importPageMarkdown: vi.fn(async (_pageId: string, _md: string) => {
        call++;
        if (call === 2) throw new Error('boom on page 2');
        return { success: true };
      }),
      createPage: vi.fn(),
      deletePage: vi.fn(),
    };
    const { git, updateRefCalls, ffCalls } = makeGit();
    const fs = makeFs({
      'A.md': 'a body',
      'B.md': 'b body',
      'C.md': 'c body',
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        updates: [
          { pageId: 'p-a', path: 'A.md' },
          { pageId: 'p-b', path: 'B.md' },
          { pageId: 'p-c', path: 'C.md' },
        ],
      }),
      'sha-partial',
    );

    // The 1st and 3rd were applied; the 2nd threw.
    expect(res.updated).toBe(2);
    expect(client.importPageMarkdown).toHaveBeenCalledTimes(3);
    expect(client.importPageMarkdown).toHaveBeenNthCalledWith(1, 'p-a', 'a body', null);
    expect(client.importPageMarkdown).toHaveBeenNthCalledWith(3, 'p-c', 'c body', null);

    // The failure is recorded with kind/pageId/path/error.
    expect(res.failures).toEqual([
      { kind: 'update', pageId: 'p-b', path: 'B.md', error: 'boom on page 2' },
    ]);

    // Only the successful pages carry a loop-guard push record.
    expect(res.pushed.map((p) => p.pageId)).toEqual(['p-a', 'p-c']);

    // A PARTIAL push advances NEITHER ref, so a re-run retries cleanly (§12).
    expect(res.lastPushedAdvanced).toBe(false);
    expect(updateRefCalls).toEqual([]);
    expect(ffCalls).toEqual([]);
    expect(res.docmostFastForward).toBeNull();
    expect(git.updateRef).not.toHaveBeenCalled();
    expect(git.fastForwardBranch).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — loop-guard push record (SPEC §10)', () => {
  it('records pageId + updatedAt + bodyHash per applied update', async () => {
    const fileBody =
      '<!-- docmost:meta\n{"version":1,"pageId":"p-1"}\n-->\n\nupdated body\n';
    const client = {
      importPageMarkdown: vi.fn(async (_pageId: string, _md: string) => ({
        // The write returns an updatedAt the loop-guard records.
        data: { updatedAt: '2026-06-20T10:00:00.000Z' },
        success: true,
      })),
      createPage: vi.fn(),
      deletePage: vi.fn(),
    };
    const { git } = makeGit();
    const fs = makeFs({ 'Doc.md': fileBody });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ updates: [{ pageId: 'p-1', path: 'Doc.md' }] }),
    );

    expect(res.pushed).toHaveLength(1);
    expect(res.pushed[0].pageId).toBe('p-1');
    expect(res.pushed[0].updatedAt).toBe('2026-06-20T10:00:00.000Z');
    // The bodyHash is a stable sha256 hex of the pushed markdown.
    expect(res.pushed[0].bodyHash).toBe(bodyHash(fileBody));
    expect(res.pushed[0].bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits updatedAt when the client result does not expose one', async () => {
    const newFile = serializeDocmostMarkdownBody(
      { version: 1, title: 'N', spaceId: 'sp' },
      'fresh body',
    );
    const client = makeClient({ createId: 'created-9' });
    const { git } = makeGit();
    const fs = makeFs({ 'N.md': newFile });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'N.md' }] }),
    );

    expect(res.pushed).toHaveLength(1);
    expect(res.pushed[0].pageId).toBe('created-9');
    expect(res.pushed[0].updatedAt).toBeUndefined();
    // bodyHash of the ORIGINAL pushed file text (what createPage received).
    expect(res.pushed[0].bodyHash).toBe(bodyHash(newFile));
  });
});

describe('applyPushActions — mixed batch + skipped passthrough', () => {
  it('applies update + create + delete and carries skipped rows through', async () => {
    const updFile =
      '<!-- docmost:meta\n{"version":1,"pageId":"u-1"}\n-->\n\nupd\n';
    const newFile = serializeDocmostMarkdownBody(
      { version: 1, title: 'N', spaceId: 'sp' },
      'fresh body',
    );
    const client = makeClient({ createId: 'created-1' });
    const { git, updateRefCalls } = makeGit();
    const fs = makeFs({ 'U.md': updFile, 'N.md': newFile });

    const skipped = [
      { path: 'Stray.md', status: 'D' as const, reason: 'no recoverable pageId' },
    ];
    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        updates: [{ pageId: 'u-1', path: 'U.md' }],
        creates: [{ path: 'N.md' }],
        deletes: [{ pageId: 'd-1' }],
        skipped,
      }),
      'sha-9',
    );

    expect(res).toMatchObject({
      created: 1,
      updated: 1,
      deleted: 1,
      lastPushedAdvanced: true,
    });
    expect(res.writtenBack).toEqual([{ path: 'N.md', pageId: 'created-1' }]);
    expect(res.skipped).toEqual(skipped);
    expect(updateRefCalls).toEqual([{ ref: LAST_PUSHED_REF, target: 'sha-9' }]);
    expect(client.importPageMarkdown).toHaveBeenCalledWith('u-1', updFile, null);
    expect(client.deletePage).toHaveBeenCalledWith('d-1');
  });
});
