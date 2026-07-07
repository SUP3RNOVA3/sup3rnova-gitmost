# Reading the AI dialog logs (how agents call tools, and where they fail)

How to inspect the agent conversation history in the database — and, more
importantly, the **one non-obvious trap that will make you report the wrong
answer**: the persisted history *silently hides hard tool failures*. Written from
real pain (a "which tools fail most?" analysis that confidently answered
"patchNode: 0 errors" while the UI was visibly full of red `patchNode` failures).

Read the **Gotchas** section before you trust any error count.

## TL;DR

- Agent chats live in Postgres, DB `docmost`, tables `ai_chat_*`.
- Each tool invocation is stored as **two** array elements (a `tool-call` part and
  a `tool-result` part), so naive counting double-counts.
- **A tool that *throws* writes no result part at all.** Its error text is nowhere
  in the DB — not in `tool_calls`, `content`, or `metadata`. It is shown live in
  the UI only. So `isError` / `success=false` scans under-report by design.
- To find where agents fail you need **three** sources: (1) soft-failure markers in
  `tool_calls`, (2) the orphan-gap proxy for thrown errors, (3) server logs / the
  live UI for the actual error text.

## Where the data lives

Host `island.lc` (`10.31.40.120`), container `gitmost-postgresql`
(`pgvector/pgvector:pg18`), database `docmost`.

```bash
ssh island.lc
# one-off query:
docker exec gitmost-postgresql psql -U docmost -d docmost -P pager=off -c "SELECT ..."
# interactive:
docker exec -it gitmost-postgresql psql -U docmost -d docmost
```

The main app container is `gitmost` (`DATABASE_URL=postgresql://docmost:...@db:5432/docmost`).
All workspaces (vvzvlad / wb / asakusa / …) share this **single** database — they
are rows in `workspaces`, not separate deployments.

### Relevant tables

| Table | What it holds |
| --- | --- |
| `ai_chats` | one row per conversation (`title`, `role_id`, `page_id`, `creator_id`) |
| `ai_chat_messages` | every message; tool calls live in `tool_calls` jsonb |
| `ai_chat_runs` | one row per agent run (turn): `status`, `error`, `step_count` |
| `ai_agent_roles` | agent definitions (`instructions`, `model_config`) |
| `ai_mcp_servers` | configured MCP tool servers per workspace |

`ai_chat_messages` columns that matter: `role` (`user` | `assistant` — there is **no**
separate `tool` role), `content` (text), `tool_calls` (jsonb array), `metadata`
(jsonb, holds run `error` + rendered `parts`), `status`, `tsv` (full-text index).

## How tool calls are stored — READ THIS

Tool calls are **not** one-object-per-call. Each logical invocation is split into
two consecutive elements of the `tool_calls` array:

```text
index 0: { "toolName": "getPage",  "input":  { "pageId": "…" } }   ← tool-call   (has input, NO output)
index 1: { "toolName": "getPage",  "output": { … } }                ← tool-result (has output, NO input)
```

The **only** keys that ever appear on an element are `toolName`, `input`, `output`.
There is no `state`, no `errorText`, no `type`. Consequences:

1. **Real invocation count = elements that have `output`.** Counting every element
   double-counts (you get ~2× and a spurious "~50% of every tool has no output").
2. **Pairing:** a successful call = a `tool-call` part followed by its `tool-result`
   part. Both carry `toolName`, so you can group by tool on either.

## The two classes of failure (and which the DB can see)

### 1. Soft failures — tool RAN and returned an error-shaped result → PERSISTED ✅

These are visible in the `tool-result` `output`. The marker differs per tool:

| Tool(s) | Error marker in `output` |
| --- | --- |
| `editPageText` | `failed` is a **non-empty** array of `{find, reason}` (e.g. `text not found in the document`, `matches N times — provide a longer fragment or set replaceAll`). Also a soft `warning` when the `find` string contained markdown that only matched after stripping. |
| `semanticSearch` | `{ "unavailable": true, "reason": "semantic search unavailable" }` (feature/infra, not the agent's fault) |
| MCP passthrough (`Habr_*`, some `Search_*`) | `output` is an **array** (raw MCP content) whose text starts with `Error executing tool … validation error …` |
| generic | `output.isError = true` or `output.success = false` |

Note `editPageText` returns `failed: []` on success — filtering on the *presence*
of the key gives false positives; filter on **non-empty**.

### 2. Hard failures — tool THREW → NOT PERSISTED ❌ (the trap)

When a tool throws (the classic one is `patchNode` / `insertNode` / `tableUpdateCell`
→ `Failed to encode document to Yjs (fromJSON): Unknown node type: undefined`), the
runtime writes **no `tool-result` part**. The orphaned `tool-call` part stays, but
the error text is **nowhere in the DB**. It is streamed to the UI live and (until
rotation) to server logs — that is it.

So any query like `count(*) FILTER (WHERE output.success = false)` will happily
return **0** for `patchNode` even when the chat is visibly full of red failures.
That is survivorship bias, not reliability.

The only DB-side proxy for a thrown error is an **orphan**: a `tool-call` part with
no matching `tool-result`. Caveat: orphans also appear when a run is **aborted**
mid-flight (server restart), so a high-volume tool (`createComment`, `searchInPage`,
`Search_web_search`) shows orphans from aborts, not from real errors. Treat the
orphan gap as an *upper bound* on hard errors, and cross-check the tool: a gap on a
structural editor (`patchNode`, `insertNode`, `updatePageJson`, `transformPage`) is
almost certainly a thrown Yjs-encode error; a gap on `createComment` is mostly aborts.

### 3. Run-level failures → `ai_chat_runs`

`status` ∈ `succeeded | aborted | failed | running`; `error` holds the text. Seen in
the wild: `Run interrupted by a server restart.` (aborts) and
`Failed after N attempts. Last error: The service may be temporarily overloaded`
(LLM provider 529). These are infra/provider, not agent tool misuse.

## Ready-to-use queries

Run all of these via `docker exec gitmost-postgresql psql -U docmost -d docmost -P pager=off -c "…"`.

**Real invocation count per tool** (result parts only — the correct denominator):

```sql
SELECT elem->>'toolName' AS tool, count(*) AS calls
FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
WHERE jsonb_typeof(m.tool_calls) = 'array' AND elem ? 'output'
GROUP BY 1 ORDER BY 2 DESC;
```

**Soft errors per tool** (everything the DB can honestly see):

```sql
WITH res AS (
  SELECT elem->>'toolName' AS tool, elem->'output' AS o
  FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
  WHERE jsonb_typeof(m.tool_calls) = 'array' AND elem ? 'output'
)
SELECT tool, count(*) AS calls,
       sum(COALESCE(
         (o->>'isError') = 'true'
         OR (o->>'success') = 'false'
         OR (jsonb_typeof(o->'failed') = 'array' AND o->'failed' <> '[]'::jsonb)
         OR (o->>'unavailable') = 'true'
         OR o::text ~* 'error executing tool|validation error'
       , false)::int) AS soft_errors
FROM res GROUP BY tool HAVING sum(COALESCE(
         (o->>'isError') = 'true' OR (o->>'success') = 'false'
         OR (jsonb_typeof(o->'failed') = 'array' AND o->'failed' <> '[]'::jsonb)
         OR (o->>'unavailable') = 'true' OR o::text ~* 'error executing tool|validation error'
       , false)::int) > 0
ORDER BY soft_errors DESC;
```

**`editPageText` failure reasons** (the most common real agent mistake — bad `find`):

```sql
WITH res AS (
  SELECT elem->'output' AS o
  FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
  WHERE jsonb_typeof(m.tool_calls) = 'array'
    AND elem->>'toolName' = 'editPageText' AND elem ? 'output'
)
SELECT f->>'reason' AS reason, count(*)
FROM res, jsonb_array_elements(o->'failed') f
WHERE jsonb_typeof(o->'failed') = 'array'
GROUP BY 1 ORDER BY 2 DESC;
```

**Hard-error proxy — orphan gap per tool, WITH a spread column** (call parts minus
result parts, plus how many distinct chats the gap is spread across):

```sql
WITH parts AS (
  SELECT m.chat_id, elem->>'toolName' AS tool,
         (elem ? 'input' AND NOT (elem ? 'output')) AS is_call,
         (elem ? 'output')                          AS is_result
  FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
  WHERE jsonb_typeof(m.tool_calls) = 'array' AND m.role = 'assistant'
),
per_chat AS (
  SELECT tool, chat_id, sum(is_call::int) - sum(is_result::int) AS gap
  FROM parts GROUP BY tool, chat_id
)
SELECT tool,
       sum(gap) FILTER (WHERE gap > 0)   AS missing_results,
       count(*) FILTER (WHERE gap > 0)   AS chats_spread,   -- disambiguates!
       max(gap)                          AS worst_single_chat
FROM per_chat GROUP BY tool
HAVING sum(gap) FILTER (WHERE gap > 0) > 0
ORDER BY missing_results DESC;
```

**`missing_results` mixes thrown errors AND aborted/interrupted runs — you cannot
split them from `output` alone** (a positional "what follows the orphan" heuristic
breaks on parallel tool batches, which persist as `call,call,…,result,result`). Use
`chats_spread` to disambiguate:

- **spread across many chats** (e.g. `createComment` 96 over 29 chats) → a **systemic
  real error** (here: inline-comment anchor text not found on the page).
- **concentrated in one chat** (e.g. `searchInPage` 55, of which 51 in a single chat)
  → **one runaway/aborted session**, not a real per-call error — discount it.
- a gap on a **structural editor** (`patchNode`, `insertNode`, `tableUpdateCell`,
  `updatePageJson`, `transformPage`) is almost always a thrown Yjs-encode error.

**Run-level failures:**

```sql
SELECT status, count(*), min(error) AS sample_error
FROM ai_chat_runs GROUP BY status ORDER BY 2 DESC;
```

**Full-text search across messages.** The `tsv` GIN index is built as
`to_tsvector('english', unaccent(content))` — so it **stems English** but **not
Russian** (Russian lexemes are stored unstemmed, so only exact word forms match).
Most content here is Russian, so prefer `ILIKE` for substring search:

```sql
-- Russian / substring — reliable:
SELECT chat_id, left(content, 120)
FROM ai_chat_messages WHERE content ILIKE '%иранск%' LIMIT 20;

-- English phrase — can use the index:
SELECT chat_id, left(content, 120)
FROM ai_chat_messages
WHERE tsv @@ websearch_to_tsquery('english', 'some phrase') LIMIT 20;
```

## Don't blow up your context

A single `tool_calls` row can be **300–400 KB** (results embed full page content and
search payloads). Never `SELECT tool_calls` (or `jsonb_pretty(tool_calls)`) raw.
Always project just the keys you need and truncate:

```sql
SELECT elem->>'toolName',
       left(regexp_replace((elem->'output')::text, '\s+', ' ', 'g'), 200)
FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
WHERE elem ? 'output' LIMIT 5;
```

## Server logs & live UI (for the error text the DB drops)

```bash
docker logs -f --tail=100 gitmost            # main app
docker compose -p gitmost logs -f --tail=100 # whole stack
```

Logging is `json-file`, `max-size=10m max-file=5` → ~50 MB retained, then rotated,
and **wiped on container recreate**. So thrown-tool error text is only reliably
caught **in real time** (or in the live chat UI, which renders the failed part with
its message). There is no durable, queryable store of hard tool errors today — if you
need one, that is a feature to add (persist `output-error` parts, or emit a
`tool_calls_total{tool,status}` metric to VictoriaMetrics).

## Gotchas checklist

- [ ] Counting every `tool_calls` element → **2× overcount**. Count elements with `output`.
- [ ] `isError` / `success=false` ≈ 0 does **not** mean "no errors" — thrown errors aren't persisted.
- [ ] `editPageText.failed` is `[]` on success — test for **non-empty**, not presence.
- [ ] Orphan gap mixes thrown errors **and** aborted runs — split by tool before concluding.
- [ ] `aborted` runs = server restarts, `failed` runs = provider overload — not agent mistakes.
- [ ] Never dump a raw `tool_calls` cell — it can be hundreds of KB.
- [ ] Logs are ephemeral (≤50 MB, wiped on recreate) — grab hard-error text live.

## Snapshot (2026-07-07, illustrative — rerun the queries for current numbers)

- 226 chats, 732 messages, 46 runs; ~4 400 real tool invocations.
- Soft errors (persisted): `editPageText` 4/79 (bad/non-unique `find`) + 9 markdown-in-`find` warnings; `semanticSearch` 3/4 (`unavailable`); `Habr_update_draft_from_docmost` 1/2 (`doc` sent as object, not string).
- Missing-result proxy, read WITH the spread column:
  - **Systemic (spread) → real errors:** `createComment` 96 over **29 chats** (comment anchor text not found — the biggest real error hotspot); `editPageText` 31 over 12 chats (+ the 4 soft above); structural-editor Yjs throws `insertNode` 10 / `updatePageContent` 9 / `tableUpdateCell` 6 / `patchNode` 5 / `updatePageJson` 2 / `transformPage` 2.
  - **Concentrated → NOT real errors:** `searchInPage` 55 (51 in one chat); `Search_web_search` 15 & `Search_searxng_web_search` 6 (timeouts/aborts in long research sessions).
- Runs: 34 succeeded, 10 aborted (server restart), 1 failed (provider overload).
