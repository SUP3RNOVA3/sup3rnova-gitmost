import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { AiService } from './ai.service';
import { AiEmbeddingNotConfiguredException } from './ai-embedding-not-configured.exception';

/**
 * #599 (Search phase B, PR-2) — the EMBEDDING FINGERPRINT LIFECYCLE.
 *
 * PR-1 (#530/#567) gave every embedding row a deterministic `fingerprint` =
 * sha256(model id + revision + prefix scheme + dimensions) and made both readers
 * (the search vector arm and the RAG hybrid CTE) filter by "the" fingerprint —
 * which was simply DERIVED from the live provider config. That is fine while the
 * config never changes, and broken the moment it does:
 *
 *   config change -> derived fingerprint changes INSTANTLY -> the filter matches
 *   zero rows -> total loss of semantic recall until every page happens to be
 *   re-indexed by an edit event. Legacy rows (fingerprint NULL, written before
 *   PR-1) are in that hole permanently.
 *
 * This service introduces the missing indirection: TWO fingerprints.
 *
 *   ACTIVE  — the generation the readers SERVE. Persisted in the workspace
 *             settings (`settings.ai.embedding.activeFingerprint`). It only moves
 *             when a full reindex of the target generation has COMPLETED.
 *   TARGET  — the generation the indexer WRITES, i.e. the fingerprint the current
 *             provider config resolves to. During a swap window ACTIVE != TARGET:
 *             old rows keep serving search while new rows are built alongside.
 *
 * The flip from ACTIVE to TARGET is a single settings write (atomic — a reader
 * sees either the old or the new generation, never a half state), guarded by a
 * re-resolve of the config: if the admin changed the model AGAIN while the run was
 * in flight, the run's target is stale and MUST NOT become active (the newer run
 * owns the pointer). Old generations are reclaimed by an idempotent generational
 * GC capped at 2 live generations.
 *
 * Everything here is workspace-scoped and driver-agnostic (SEARCH_DRIVER=database).
 */

/** The two fingerprints of a workspace at a point in time. */
export interface EmbeddingGeneration {
  /** The generation search/RAG serve (persisted pointer, or the config fp when never flipped). */
  active: string;
  /** The generation the indexer writes = the fingerprint of the live provider config. */
  target: string;
  /** True while a target reindex is pending/in flight (active != target). */
  swapping: boolean;
  /**
   * #599 (D2) — TRUE when the active generation's rows were produced by a
   * DIFFERENT MODEL than the one the live config embeds queries with (including
   * "we cannot prove they were produced by the same model", see
   * generationForTarget). The vector arm MUST NOT be raised in that case: cosine
   * between a query from model M2 and rows from model M1 compares two independently
   * trained embedding spaces, which are related by an arbitrary rotation — the
   * ranking is noise, and worse than useless, because RRF then injects those
   * arbitrary pages into the top and DISPLACES valid lexical hits. Readers degrade
   * to lexical-only (`available: false`, `state: 'stale'`) until the reindex of the
   * new model completes and the pointer flips.
   *
   * KNOWN GAP (#599 R8b — follow-up): this guard can only see changes the
   * FINGERPRINT sees, and the fingerprint does not encode the provider ENDPOINT
   * (see computeEmbeddingFingerprint). Repointing the workspace at a different
   * service that serves a same-named model keeps the fingerprint identical ->
   * `swapping: false` -> `modelChanged: false`, and the cross-space cosine D2
   * exists to prevent is served anyway. D2 closes the "admin picks another model
   * from the dropdown" hole (the common one); the endpoint hole needs the
   * fingerprint itself to change and is filed as a follow-up.
   */
  modelChanged: boolean;
  /** Bare model name of the ACTIVE generation's rows; null when unknown. */
  activeModel: string | null;
  /** Bare model name of the live config (what a query is embedded with). */
  targetModel: string;
}

/** Coverage of the ACTIVE generation over the workspace's embeddable pages. */
export interface EmbeddingCoverage {
  /** Non-deleted pages holding >= 1 row of the ACTIVE fingerprint. */
  indexed: number;
  /** The denominator: pages that can actually produce >= 1 chunk (see computeCoverage). */
  total: number;
  /** 'full' when the active generation covers the denominator, else 'stale'. */
  state: 'full' | 'stale';
}

/**
 * TTL (ms) of the per-workspace coverage cache. The coverage numbers ride on EVERY
 * search response, and computing them costs 2-3 COUNT(DISTINCT) scans over
 * `page_embeddings` — far too expensive to run per keystroke on the interactive
 * search path. Coverage is a COSMETIC indicator (it never changes which rows are
 * served — that is the ACTIVE fingerprint's job, which is NEVER cached), so a few
 * seconds of staleness is harmless. 0 disables the cache.
 *
 * The cache is per PROCESS: a flip performed by the BullMQ worker is not seen by
 * the API process's cache until its entry expires, so "reindexing -> full" can lag
 * by up to one TTL in the UI. Deliberate: a cross-process invalidation channel is
 * not worth it for an indicator.
 */
function coverageTtlMs(): number {
  const raw = Number(process.env.SEARCH_COVERAGE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15_000;
}

/**
 * PURE coverage rule (unit-tested exhaustively). Deriving the denominator is the
 * whole subtlety of the coverage state, so it is isolated from all I/O.
 *
 * @param indexed     pages holding >= 1 row of the ACTIVE fingerprint (numerator)
 * @param embeddable  LIVE `countEmbeddablePages` — pages that MIGHT produce a chunk
 * @param completedTotal  pages that really produced >= 1 chunk in the completed run
 *                    that established the CURRENT active fingerprint, or null when
 *                    no run has ever completed for it
 * @param completedEmbeddable  how many pages that SAME run considered embeddable
 *                    (null on a record written before this key existed)
 *
 * The denominator cannot be the raw `embeddable` count: that predicate is an
 * OPTIMISTIC over-approximation — a page whose only content is a math block or an
 * image looks embeddable but yields NO chunk, so `indexed` could never reach
 * `embeddable` and the state would be pinned at `stale` FOREVER (the trap the issue
 * calls out).
 *
 * It cannot be the completed run's produced count either (#599 D3): that number is
 * FROZEN at the run, so pages ADDED afterwards are in neither the numerator nor the
 * denominator, and a workspace with 100 indexed pages and 1000 brand-new un-indexed
 * ones would happily report `full`.
 *
 * So the rule measures the CHUNK-LESS GAP once (`completedEmbeddable -
 * completedTotal` — how many pages of this workspace look embeddable but produce
 * nothing) and subtracts that gap from the LIVE embeddable count:
 *
 *     total = max(0, embeddable - gap)
 *
 * which gives all three required properties:
 *   (a) pages ADDED -> `embeddable` grows -> `total` grows past `indexed` -> stale,
 *       and it converges back to `full` as the event-driven indexer embeds them;
 *   (b) pages DELETED -> `embeddable` shrinks and so does `indexed` (both exclude
 *       trashed pages) -> converges to `full`, never a perpetual `stale`;
 *   (c) a workspace whose pages produce NO chunks at all (gap == embeddable) gets
 *       total 0 -> `full`, not the perpetual `stale` of #599 D5.
 *
 * Known imprecision (deliberate): a chunk-less page CREATED after the run inflates
 * `embeddable` without ever being able to raise `indexed`, so the state reads
 * `stale` until the next completed run re-measures the gap. That errs on the side of
 * "a reindex would help" — the safe direction; the opposite error (claiming `full`
 * while pages are missing from the index) is the one that matters.
 *
 * Bootstrap (`completedTotal == null`: legacy/fresh instance, or a config change
 * whose run has not completed) falls back to `embeddable`, so an un-indexed
 * workspace reports `stale` — which is exactly right: it needs a reindex.
 */
export function computeCoverage(params: {
  indexed: number;
  embeddable: number;
  completedTotal: number | null;
  completedEmbeddable: number | null;
}): EmbeddingCoverage {
  const { indexed, embeddable, completedTotal, completedEmbeddable } = params;

  // No completed run for the active generation -> the optimistic count is the only
  // denominator we have, and it correctly reports `stale`.
  if (completedTotal == null) {
    // Clamped for the same reason as the main path (#599 R4): the numerator is a
    // real count of indexed pages, so a denominator below it is never honest.
    const total = Math.max(embeddable, indexed);
    return { indexed, total, state: indexed >= total ? 'full' : 'stale' };
  }

  // Pages that look embeddable but produce no chunk, as MEASURED by the run that
  // built the active generation. A pre-D3 record has no `completedEmbeddable`: gap
  // 0 is the conservative choice (it can only make the state read `stale`, never a
  // false `full`), and the next completed run records both keys and self-heals.
  const gap =
    completedEmbeddable != null
      ? Math.max(0, completedEmbeddable - completedTotal)
      : 0;

  // #599 (R4) — the gap is FROZEN at the completed run, so it can over-subtract:
  // delete the chunk-less pages the run measured and `embeddable` shrinks while the
  // gap does not, which would print an absurd "indexed 7 / total 4" (the numerator
  // is live, the gap is not). Clamp the denominator to the numerator: `indexed` is
  // a real count of pages holding rows of the active generation, so the denominator
  // can never honestly be below it. The clamp only ever moves the state toward
  // `full`, which is correct in exactly this case (every indexed page is covered),
  // and it cannot manufacture a false `full` — it never lowers `indexed`.
  const total = Math.max(Math.max(0, embeddable - gap), indexed);

  // total === 0 = every embeddable page is chunk-less (or the workspace is empty):
  // there is nothing the index COULD hold, so it is trivially covered.
  const state: 'full' | 'stale' = indexed >= total ? 'full' : 'stale';
  return { indexed, total, state };
}

@Injectable()
export class EmbeddingGenerationService {
  private readonly logger = new Logger(EmbeddingGenerationService.name);

  // workspaceId -> { coverage, expiresAt }. Cosmetic; see coverageTtlMs().
  private readonly coverageCache = new Map<
    string,
    { value: EmbeddingCoverage; fingerprint: string; expiresAt: number }
  >();

  constructor(
    private readonly aiService: AiService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly pageRepo: PageRepo,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * Resolve the workspace's ACTIVE + TARGET fingerprints.
   *
   * TARGET is the live config's fingerprint (throws
   * AiEmbeddingNotConfiguredException when no provider resolves — callers degrade
   * to `semantic.state=off`). ACTIVE is the persisted pointer, falling back to
   * TARGET when it was never flipped: on a fresh instance the first generation
   * written IS the one to serve, so there is no swap window to protect.
   */
  async resolveGeneration(workspaceId: string): Promise<EmbeddingGeneration> {
    const provider = await this.aiService.resolveEmbeddingProvider(workspaceId);
    return this.generationForTarget(
      workspaceId,
      provider.fingerprint,
      provider.modelId,
    );
  }

  /**
   * Same as resolveGeneration, but with an ALREADY resolved target fingerprint +
   * model id (the indexer resolves the provider once per run and threads them in).
   *
   * #599 (D2) — this is where `modelChanged` is decided. A fingerprint covers
   * {model, revision, prefix scheme, dimensions}, so `active != target` alone says
   * NOTHING about whether the old rows are still comparable with a query embedded
   * by the CURRENT model:
   *
   *   - revision bump / prefix-scheme toggle, SAME model -> the same weights, hence
   *     the same embedding space (a prefix only shifts it slightly). The old rows
   *     stay usable and MUST keep being served, or a routine settings change would
   *     blank out semantic search for the whole reindex window.
   *   - DIFFERENT model -> a different space. Two independently trained encoders
   *     agree on nothing: `q(M2) . d(M1)` is dominated by anisotropy, so the ranking
   *     is arbitrary. If the dimensions also differ, the vector arm's
   *     `model_dimensions = queryDim` filter already matches 0 rows and search
   *     degrades cleanly to lexical — but at the SAME dimension (e5-base -> bge-base,
   *     both 768) nothing stops the cross-space cosine, and the garbage it ranks
   *     first then displaces valid lexical hits through RRF. So the model change is
   *     detected HERE and the vector arm is not raised at all.
   *
   * `activeModel == null` while swapping = a pointer flipped by a build that predates
   * the `activeModel` key, i.e. we cannot PROVE the old rows come from the current
   * model -> treated as changed (conservative: lexical-only until the next completed
   * run records the model). Outside a swap (active === target) the fingerprints are
   * equal, hence the model is equal by construction, and `modelChanged` is false
   * regardless of what is (not) recorded.
   */
  async generationForTarget(
    workspaceId: string,
    target: string,
    targetModel: string,
  ): Promise<EmbeddingGeneration> {
    const { activeFingerprint, activeModel } =
      await this.workspaceRepo.getEmbeddingGeneration(workspaceId);
    const active = activeFingerprint ?? target;
    const swapping = active !== target;
    const modelChanged = swapping && activeModel !== targetModel;
    return {
      active,
      target,
      swapping,
      modelChanged,
      activeModel: swapping ? activeModel : targetModel,
      targetModel,
    };
  }

  /**
   * #599 (D4) — run `fn` under a per-workspace POSTGRES ADVISORY LOCK, or skip it
   * (returning false) when another run already holds the lock.
   *
   * The BullMQ `jobId = ai-reindex-${workspaceId}` dedupe is NOT sufficient: a job
   * that stalls (a long page, a paused event loop) is re-dispatched to another
   * worker while the original is still running, and two overlapping runs corrupt
   * each other:
   *
   *   - run B's START GC keeps only {active, B.target} and therefore DELETES the
   *     partially built generation of run A;
   *   - if the config then rolls back to A's target, A reaches completeRun, sees
   *     `config == target`, and flips the pointer onto its own HOLED generation —
   *     whose post-flip GC then destroys the generation that was serving search.
   *
   * A session-level advisory lock held for the WHOLE run makes the two mutually
   * exclusive across workers and processes (it is a Postgres-side lock, not an
   * in-process mutex). The key is a 64-bit hash of the workspace id, computed in
   * SQL, so unrelated workspaces never collide. `pg_try_advisory_lock` does not
   * block: a second run returns immediately and simply skips — the work is not
   * lost, the winning run is doing exactly the same thing.
   *
   * The lock is session-scoped, so the whole run is pinned to ONE pooled connection
   * (`db.connection()`), and the unlock runs in a `finally` on that same connection.
   * A crashed worker releases it when its connection dies — there is no stale-lock
   * state to clean up.
   *
   * DEPLOYMENT REQUIREMENTS (both follow from "session-scoped lock, held for the
   * whole run"):
   *
   *   1. DATABASE_MAX_POOL >= 2. The run PINS one pooled connection for its entire
   *      duration (minutes on a large workspace), while its body still asks the pool
   *      for connections of its own (every per-page `executeTx` / repo call). With a
   *      pool of exactly 1 the run holds the only connection and then waits forever
   *      for a second one — a self-deadlock. Any realistic pool (the default is well
   *      above 2) is fine; 1 is the pathological setting, and it is worth stating
   *      because "one worker, one connection" looks like a sane thing to configure.
   *   2. SESSION pooling, not pgbouncer TRANSACTION pooling. In transaction mode
   *      every statement may land on a DIFFERENT backend, so `pg_advisory_unlock`
   *      would run on a session that never took the lock: the unlock is a no-op that
   *      logs a warning, and the real lock leaks until its backend is recycled — the
   *      workspace would then never reindex again. Session-scoped advisory locks
   *      REQUIRE a session-pinned connection (use pgbouncer session mode, or point
   *      the worker straight at Postgres).
   */
  async runExclusive(
    workspaceId: string,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    return this.db.connection().execute(async (conn) => {
      const lockKey = sql<string>`('x' || substr(md5(${workspaceId}), 1, 16))::bit(64)::bigint`;
      const res = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_lock(${lockKey}) AS locked
      `.execute(conn);

      if (res.rows[0]?.locked !== true) {
        this.logger.warn(
          `embedding.run.skipped workspace=${workspaceId} reason=already-running`,
        );
        return false;
      }

      try {
        await fn();
        return true;
      } finally {
        // #599 (R6) — the unlock must NOT be able to hijack the run's outcome. An
        // unguarded `await` in a `finally` that throws would (a) REPLACE the real
        // error of the run (a partial-run retry signal, a fatal provider error) with
        // an opaque unlock error, destroying the diagnosis and the retry semantics,
        // and (b) return the connection to the pool STILL HOLDING the lock, which
        // would block every future run of this workspace for as long as that pooled
        // connection lives. Swallow + log instead: a lock that survives is released
        // when the connection is eventually recycled/closed, and the run's own
        // result (success or error) propagates untouched.
        await sql`SELECT pg_advisory_unlock(${lockKey})`
          .execute(conn)
          .catch((err: unknown) => {
            this.logger.error(
              `embedding.run.unlock-failed workspace=${workspaceId}: ` +
                `${err instanceof Error ? err.message : String(err)} ` +
                `(the advisory lock may stay held until this pooled connection is recycled)`,
            );
          });
      }
    });
  }

  /**
   * Embed a search/RAG query and return it together with the fingerprint the
   * candidate rows MUST be filtered by — the ACTIVE generation, not the config's.
   *
   * This is the single funnel for every READER (SearchService's vector arm and the
   * agent's hybrid RAG CTE). `AiService.embedQuery` stays the raw primitive: it
   * embeds with the CURRENT provider and reports the config (= target) fingerprint;
   * this wrapper overrides the filter fingerprint with the active pointer.
   *
   * The asymmetry during a swap window is intentional and bounded: the query vector
   * comes from the NEW config while the rows served are the OLD generation's. That
   * is the ONLY way to keep semantic recall alive across the window (the old
   * config's weights are gone the moment it changed — a fingerprint is a hash, you
   * cannot rebuild a provider from it). It is sound ONLY while both sides live in
   * the same embedding space, which is exactly what `generation.modelChanged`
   * decides:
   *
   *   - SAME model, different revision/prefix -> same space; serve the old
   *     generation (`modelChanged: false`).
   *   - DIFFERENT model -> different space; the CALLER must not raise the vector arm
   *     at all (`modelChanged: true`) and must serve lexical-only. Returning the
   *     vector anyway would let a caller cosine two unrelated spaces (#599 D2).
   *
   * Two further guardrails remain: (1) the vector arm also filters
   * `model_dimensions = queryDim`, so any dimension change matches zero rows
   * (defence in depth behind the model check, and what protects pgvector from a
   * dimension-mismatch error); (2) all candidates come from ONE generation, so `<=>`
   * never mixes vectors from two generations in a single ranking.
   */
  async embedQueryForActiveGeneration(
    workspaceId: string,
    text: string,
  ): Promise<{
    vector: number[];
    fingerprint: string;
    generation: EmbeddingGeneration;
  }> {
    const {
      vector,
      fingerprint: target,
      modelId,
    } = await this.aiService.embedQuery(workspaceId, text);
    const generation = await this.generationForTarget(
      workspaceId,
      target,
      modelId,
    );
    return { vector, fingerprint: generation.active, generation };
  }

  /**
   * The GC at the START of a run: keep ONLY the generation being served (active)
   * and the one being built (target); reclaim everything else — older generations
   * left by earlier swaps, legacy NULL-fingerprint rows, and the partial output of
   * a run that was aborted before its config moved on. Idempotent (a set-difference
   * delete), so a retried run re-runs it for free.
   */
  async gcGenerations(workspaceId: string, keep: string[]): Promise<number> {
    const deleted = await this.pageEmbeddingRepo.deleteOtherGenerations(
      workspaceId,
      keep,
    );
    if (deleted > 0) {
      this.logger.log(
        `embedding.gc workspace=${workspaceId} kept=${keep.length} deleted_rows=${deleted}`,
      );
    }
    this.invalidateCoverage(workspaceId);
    return deleted;
  }

  /**
   * Finish a reindex run: ATOMICALLY flip the active pointer onto `target` and
   * record the run's coverage denominator, then reclaim the superseded generation.
   *
   * GUARD — the flip happens ONLY if the live config STILL resolves to `target`.
   * If the admin changed the model again while this run was in flight, the config
   * now points at a THIRD fingerprint and a second reindex is already queued for
   * it; flipping onto this run's target would publish a generation nobody is
   * maintaining and would immediately be superseded (the "second swap during the
   * first" hazard). We skip the flip and let the newer run own the pointer — this
   * run's rows are simply an extra generation, reclaimed by the next run's start
   * GC.
   *
   * Returns true when the pointer was flipped (or re-affirmed on the no-swap path,
   * where active already equals target — the coverage total still has to be
   * recorded, it is what turns the state from `stale` into `full`).
   */
  async completeRun(params: {
    workspaceId: string;
    target: string;
    /** Bare model name of the rows this run wrote (recorded with the pointer, #599 D2). */
    targetModel: string;
    coverageTotal: number;
    /** Pages this run CONSIDERED embeddable — the gap measurement of #599 D3. */
    coverageEmbeddable: number;
  }): Promise<boolean> {
    const {
      workspaceId,
      target,
      targetModel,
      coverageTotal,
      coverageEmbeddable,
    } = params;

    // Re-resolve the CONFIG fingerprint right before the write.
    let configFingerprint: string;
    try {
      const provider =
        await this.aiService.resolveEmbeddingProvider(workspaceId);
      configFingerprint = provider.fingerprint;
    } catch (err) {
      if (err instanceof AiEmbeddingNotConfiguredException) {
        // The provider was removed mid-run: there is no generation to publish.
        this.logger.warn(
          `embedding.swap.skipped workspace=${workspaceId} reason=no-provider`,
        );
        return false;
      }
      throw err;
    }

    if (configFingerprint !== target) {
      this.logger.warn(
        `embedding.swap.skipped workspace=${workspaceId} reason=config-changed ` +
          `target=${target} config=${configFingerprint}`,
      );
      return false;
    }

    // ONE settings write: pointer + model + denominator move together or not at all.
    await this.workspaceRepo.setEmbeddingGeneration(workspaceId, {
      activeFingerprint: target,
      activeModel: targetModel,
      coverageTotal,
      coverageEmbeddable,
    });
    this.invalidateCoverage(workspaceId);
    this.logger.log(
      `embedding.swap.flipped workspace=${workspaceId} active=${target} coverage_total=${coverageTotal}`,
    );

    // The superseded generation is no longer served by anyone -> reclaim it now
    // (this is what ends the transient ~2x pgvector storage of the swap window).
    // Only ever runs AFTER a successful flip, so an aborted/skipped run never
    // destroys the generation that is still being served.
    await this.gcGenerations(workspaceId, [target]);
    return true;
  }

  /**
   * Coverage of the ACTIVE generation (TTL-cached; see coverageTtlMs). Costs two
   * COUNTs (indexed pages of the active fingerprint + the live embeddable count),
   * so it is only ever called on a search request that actually has a provider.
   */
  async getCoverage(
    workspaceId: string,
    activeFingerprint: string,
  ): Promise<EmbeddingCoverage> {
    const ttl = coverageTtlMs();
    const cached = this.coverageCache.get(workspaceId);
    if (
      ttl > 0 &&
      cached &&
      cached.fingerprint === activeFingerprint &&
      cached.expiresAt > Date.now()
    ) {
      return cached.value;
    }

    // #599 D3 — the LIVE embeddable count is now needed on EVERY path, not only on
    // bootstrap: it is what makes the denominator grow when pages are ADDED (the
    // frozen completed-run total never does, so the state could never leave `full`
    // no matter how many un-indexed pages appeared). It is one COUNT over `pages`,
    // and the whole coverage result is TTL-cached, so it is not paid per keystroke.
    const [indexed, embeddable, stored] = await Promise.all([
      this.pageEmbeddingRepo.countPagesByFingerprint(
        workspaceId,
        activeFingerprint,
      ),
      this.pageRepo.countEmbeddablePages(workspaceId),
      this.workspaceRepo.getEmbeddingGeneration(workspaceId),
    ]);

    // The recorded denominator belongs to the generation the pointer names. If the
    // caller is asking about a DIFFERENT generation (it never should — readers pass
    // the active pointer), the total does not apply and we fall back to bootstrap.
    const forActive = stored.activeFingerprint === activeFingerprint;

    const coverage = computeCoverage({
      indexed,
      embeddable,
      completedTotal: forActive ? stored.coverageTotal : null,
      completedEmbeddable: forActive ? stored.coverageEmbeddable : null,
    });

    if (ttl > 0) {
      this.coverageCache.set(workspaceId, {
        value: coverage,
        fingerprint: activeFingerprint,
        expiresAt: Date.now() + ttl,
      });
    }
    return coverage;
  }

  /** Drop the cached coverage of a workspace (after a GC / flip). */
  invalidateCoverage(workspaceId: string): void {
    this.coverageCache.delete(workspaceId);
  }
}
