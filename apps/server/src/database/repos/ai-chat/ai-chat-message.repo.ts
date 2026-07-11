import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  AiChatMessage,
  InsertableAiChatMessage,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';

// Crash-recovery sweep recency threshold (#183 review): a 'streaming' row is
// only swept to 'aborted' once it has been UNTOUCHED for this long. A live turn
// bumps `updatedAt` on every step (well under this window), so its row never
// matches; only a turn whose process truly died (no step update for >threshold)
// is swept. Chosen safely ABOVE the longest realistic turn so a fresh replica's
// boot-sweep can never abort a turn another replica is actively streaming
// (multi-instance deploy).
const SWEEP_STREAMING_STALE_MS = 10 * 60 * 1000; // 10 minutes

// Hard upper bound on the rows materialized by `findAllByChat`, which now feeds
// BOTH the Markdown export and the per-turn model history.
// A generous cap so a pathologically huge chat cannot load an unbounded result
// into memory; far above any realistic transcript length.
const FIND_ALL_BY_CHAT_LIMIT = 5000;

@Injectable()
export class AiChatMessageRepo {
  private readonly logger = new Logger(AiChatMessageRepo.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  // The `tsv` column is a trigger-maintained tsvector used only for
  // full-text search. It must never be selected so it cannot leak into
  // HTTP responses or the chat history fed to the language model.
  private baseFields: Array<keyof AiChatMessage> = [
    'id',
    'chatId',
    'workspaceId',
    'userId',
    'role',
    'content',
    'toolCalls',
    'metadata',
    'status',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ];

  async findByChat(
    chatId: string,
    workspaceId: string,
    pagination?: PaginationOptions,
  ) {
    const query = this.db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    // Default page size when no pagination options are supplied.
    const perPage = pagination?.limit ?? 50;

    return executeWithCursorPagination(query, {
      perPage,
      cursor: pagination?.cursor,
      beforeCursor: pagination?.beforeCursor,
      fields: [
        { expression: 'createdAt', direction: 'asc' },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });
  }

  // Load ALL (non-deleted) messages of a chat in ascending chronological order
  // (oldest -> newest), unpaginated. Two callers, both treating the DB as the
  // single source of truth and needing the whole transcript in one pass
  // (findByChat is cursor-paginated and would only return the first page):
  //   - the server-side Markdown export (#183);
  //   - the per-turn model history, rebuilt fresh on every turn so the model
  //     sees the full authoritative transcript.
  //
  // Hard-capped at FIND_ALL_BY_CHAT_LIMIT rows (a generous bound, far above any
  // realistic transcript) — a shared memory-safety backstop for BOTH paths so a
  // pathologically huge chat cannot materialize an unbounded result set in
  // memory. On overflow the NEWEST rows are kept and a warning is logged.
  async findAllByChat(
    chatId: string,
    workspaceId: string,
    // Injectable for tests so truncation can be exercised on a modest volume.
    limit: number = FIND_ALL_BY_CHAT_LIMIT,
  ): Promise<AiChatMessage[]> {
    // Fetch newest-first (+1 to DETECT truncation), so on overflow we keep the
    // NEWEST `limit` messages — the recent conversation matters most — rather
    // than silently dropping the tail (#183 review). Then reverse back to
    // chronological order (oldest -> newest) for rendering / model replay.
    const rows = await this.db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('chatId', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();

    if (rows.length > limit) {
      rows.length = limit; // keep the newest `limit` (rows are newest-first here)
      this.logger.warn(
        `Chat ${chatId} truncated to the newest ${limit} messages ` +
          `(older messages omitted).`,
      );
    }
    return rows.reverse();
  }

  /** Fetch a single message by id + workspace (e.g. a run's projection row for
   *  the #184 reconnect read). Returns undefined when nothing matches. */
  async findById(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('aiChatMessages')
      .select(this.baseFields)
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async insert(
    insertable: InsertableAiChatMessage,
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiChatMessages')
      .values(insertable)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * Update a single message in place by id + workspace (#183 step-granular
   * durability). The assistant row is created UPFRONT (status 'streaming') and
   * patched as each step completes, then finalized once on the terminal status.
   * `updatedAt` is always bumped. Returns the updated row (baseFields) or
   * undefined when no row matched (e.g. a foreign workspace / deleted row).
   */
  async update(
    id: string,
    workspaceId: string,
    patch: Partial<{
      content: string | null;
      toolCalls: unknown;
      metadata: unknown;
      status: string | null;
    }>,
    opts?: { onlyIfStreaming?: boolean; trx?: KyselyTransaction },
  ): Promise<AiChatMessage | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    let query = db
      .updateTable('aiChatMessages')
      .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId);
    // Concurrency guard (#183 review): a per-step 'streaming' update must NEVER
    // overwrite a row the terminal callback already finalized. onStepFinish
    // fires the streaming update fire-and-forget, so its UPDATE can land AFTER
    // finalize on a DIFFERENT pool connection (commit order is not guaranteed).
    // Scoping the streaming update to rows STILL in 'streaming' makes a late
    // update a no-op once the row is completed/error/aborted — regardless of
    // commit order. The terminal finalize runs WITHOUT this guard so it always
    // wins.
    if (opts?.onlyIfStreaming) {
      query = query.where('status', '=', 'streaming');
    }
    return query.returning(this.baseFields).executeTakeFirst();
  }

  /**
   * #487 OWNER terminal write — the streamText terminal callback's finalize. Like
   * `update` but CONDITIONAL on `status='streaming' OR metadata.finalizeFailed`:
   * the owner writes its real content EITHER when the row is still streaming (the
   * normal case) OR when a reconcile stamp already flipped it to a terminal status
   * but marked `finalizeFailed:true` — the owner's real content OVERWRITES that
   * placeholder stamp (owner-write priority, #487). A row that is properly terminal
   * (no finalizeFailed) is left untouched (undefined) — idempotent. The `patch`
   * carries the real metadata WITHOUT finalizeFailed, so a successful write CLEARS
   * the flag. Returns the updated row, or undefined when nothing matched.
   */
  async finalizeOwner(
    id: string,
    workspaceId: string,
    patch: Partial<{
      content: string | null;
      toolCalls: unknown;
      metadata: unknown;
      status: string | null;
    }>,
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('aiChatMessages')
      .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'streaming'),
          eb(sql<string>`(metadata->>'finalizeFailed')`, '=', 'true'),
        ]),
      )
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * #487 RECONCILE status-only stamp — settle a stuck 'streaming' row to a
   * terminal status WITHOUT the owner's real content (which lived only in the
   * dead process's memory — a documented loss). CONDITIONAL on `status='streaming'`
   * (never touches an already-terminal row) AND it MERGES `finalizeFailed:true`
   * into metadata (preserving the partial `parts` already persisted) so a LATER
   * owner-write (finalizeOwner) can still OVERWRITE this placeholder with real
   * content, and so `isInterruptResume` can EXCLUDE this row (a reconcile stamp is
   * not a genuine user interruption). Returns the updated row, or undefined.
   */
  async stampTerminalIfStreaming(
    id: string,
    workspaceId: string,
    status: 'aborted' | 'error' | 'completed',
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('aiChatMessages')
      .set({
        status,
        metadata: sql`coalesce(metadata, '{}'::jsonb) || jsonb_build_object('finalizeFailed', true)`,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('status', '=', 'streaming')
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * #487 reconcile clause (b): streaming assistant rows whose linked RUN has
   * already reached a terminal status — an asymmetry ("run settled / message
   * streaming forever") the periodic reconcile heals by stamping the message.
   * Returns the message id + its run's terminal status, bounded.
   */
  async findStreamingWithTerminalRun(
    limit = 200,
    // #487: scope to ONE chat for the opportunistic per-turn reconcile (removes
    // reconcile latency from the user-visible path); omit for the periodic sweep.
    chat?: { chatId: string; workspaceId: string },
  ): Promise<
    Array<{ messageId: string; workspaceId: string; runStatus: string }>
  > {
    let query = this.db
      .selectFrom('aiChatMessages as m')
      .innerJoin('aiChatRuns as r', 'r.assistantMessageId', 'm.id')
      .select([
        'm.id as messageId',
        'm.workspaceId as workspaceId',
        'r.status as runStatus',
      ])
      .where('m.status', '=', 'streaming')
      .where('r.status', 'in', ['succeeded', 'failed', 'aborted']);
    if (chat) {
      query = query
        .where('m.chatId', '=', chat.chatId)
        .where('m.workspaceId', '=', chat.workspaceId);
    }
    return query.limit(limit).execute();
  }

  /**
   * #487 reconcile clause (d) — historical-row safety: streaming rows older than
   * `staleMs` whose chat has NO active run row (double-gated). Settle them to
   * 'aborted' + finalizeFailed (so a late owner-write could still overwrite).
   * Returns the count. Used ONLY by the periodic reconcile, never at boot.
   */
  async sweepStreamingWithoutActiveRun(
    staleMs: number,
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const staleBefore = new Date(Date.now() - staleMs);
    const rows = await db
      .updateTable('aiChatMessages as m')
      .set({
        status: 'aborted',
        metadata: sql`coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object('finalizeFailed', true)`,
        updatedAt: new Date(),
      })
      .where('m.status', '=', 'streaming')
      .where('m.updatedAt', '<', staleBefore)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('aiChatRuns as r')
              .select('r.id')
              .whereRef('r.chatId', '=', 'm.chatId')
              .where('r.status', 'in', ['pending', 'running']),
          ),
        ),
      )
      .returning('m.id')
      .execute();
    return rows.length;
  }

  /**
   * Crash-recovery sweep (#183): flip every assistant row still left in the
   * 'streaming' state (a turn that died mid-write before reaching a terminal
   * status) to 'aborted'. Run once on server start. Returns the number of rows
   * swept so the caller can log it. Workspace-wide on purpose — a crash can have
   * dangling streaming rows across any workspace.
   *
   * Bounded by recency (#183 review): only rows UNTOUCHED for
   * SWEEP_STREAMING_STALE_MS are swept. A live turn bumps `updatedAt` on every
   * step, so an actively-streaming row never matches; this prevents a fresh
   * replica's boot-sweep from aborting a turn another replica is still streaming
   * in a multi-instance deploy.
   *
   * #487: the sweep now ALSO marks `finalizeFailed:true` so a late owner-write can
   * overwrite this placeholder with real content (owner-write priority).
   */
  async sweepStreaming(trx?: KyselyTransaction): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const staleBefore = new Date(Date.now() - SWEEP_STREAMING_STALE_MS);
    const rows = await db
      .updateTable('aiChatMessages')
      .set({
        status: 'aborted',
        metadata: sql`coalesce(metadata, '{}'::jsonb) || jsonb_build_object('finalizeFailed', true)`,
        updatedAt: new Date(),
      })
      .where('status', '=', 'streaming')
      .where('updatedAt', '<', staleBefore)
      .returning('id')
      .execute();
    return rows.length;
  }
}
