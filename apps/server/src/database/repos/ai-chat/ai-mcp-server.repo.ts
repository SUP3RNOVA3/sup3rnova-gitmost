import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx, jsonbBind, parseJsonbValue } from '../../utils';
import { AiMcpServer } from '@docmost/db/types/entity.types';

const logger = new Logger('AiMcpServerRepo');

/**
 * Repository for per-workspace external MCP servers the agent may use (§5.4).
 *
 * SECURITY (§8.10): rows hold the encrypted auth-header blob (`headersEnc`).
 * That column must NEVER be returned to a non-admin path nor logged; the admin
 * controller projects an explicit allowlist of columns and the connect path
 * decrypts only server-side. All lookups are workspace-scoped.
 */
@Injectable()
export class AiMcpServerRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<AiMcpServer | undefined> {
    const row = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return row ? normalizeRow(row) : row;
  }

  async listByWorkspace(workspaceId: string): Promise<AiMcpServer[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  /** Enabled servers only — used by the agent loop to build the toolset. */
  async listEnabled(workspaceId: string): Promise<AiMcpServer[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', true)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  async insert(
    values: {
      workspaceId: string;
      name: string;
      transport: string;
      url: string;
      headersEnc?: string | null;
      toolAllowlist?: string[] | null;
      // Admin-authored prompt guidance; blank/whitespace normalizes to null.
      instructions?: string | null;
      enabled?: boolean;
    },
    trx?: KyselyTransaction,
  ): Promise<AiMcpServer> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiMcpServers')
      .values({
        workspaceId: values.workspaceId,
        name: values.name,
        transport: values.transport,
        url: values.url,
        headersEnc: values.headersEnc ?? null,
        // jsonb column: the postgres driver would otherwise encode a JS array as
        // a Postgres array literal. Bind the JSON text and cast it to jsonb.
        // preserveEmpty (#476): `[]` is a real value here (deny-all), distinct
        // from null ("no restriction") — it must round-trip as `[]`, not null.
        toolAllowlist: jsonbBind(values.toolAllowlist, { preserveEmpty: true }),
        // Plain text column: blank/whitespace-only guidance is stored as null.
        instructions: blankToNull(values.instructions),
        enabled: values.enabled ?? true,
      })
      .returningAll()
      .executeTakeFirst();
  }

  async update(
    id: string,
    workspaceId: string,
    patch: {
      name?: string;
      transport?: string;
      url?: string;
      // undefined => leave unchanged; null => clear; string => set.
      headersEnc?: string | null;
      // undefined => leave unchanged; null => clear; string[] => set.
      toolAllowlist?: string[] | null;
      // undefined => leave unchanged; null/blank => clear; string => set.
      instructions?: string | null;
      enabled?: boolean;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.transport !== undefined) set.transport = patch.transport;
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.headersEnc !== undefined) set.headersEnc = patch.headersEnc;
    if (patch.toolAllowlist !== undefined) {
      // preserveEmpty (#476): see insert — `[]` (deny-all) must not become null.
      set.toolAllowlist = jsonbBind(patch.toolAllowlist, {
        preserveEmpty: true,
      });
    }
    if (patch.instructions !== undefined) {
      // Blank/whitespace-only guidance clears the column (stored as null).
      set.instructions = blankToNull(patch.instructions);
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    await db
      .updateTable('aiMcpServers')
      .set(set)
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async delete(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('aiMcpServers')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }
}

/**
 * Normalize an optional free-text field to a stored value: a missing/blank/
 * whitespace-only string becomes null (so an "empty" guide is never persisted),
 * any other string is trimmed. Returns null for null/undefined input.
 */
export function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the `toolAllowlist` value read from the DB into the `string[] | null`
 * the entity type promises. The jsonb column historically round-trips as a JSON
 * STRING (rows written by the old double-encoding bind before the `::text::jsonb`
 * fix), so the driver hands back a string like `'["a","b"]'` rather than an
 * array. Be tolerant: normalize a JSON string to its value, then accept it only
 * if it is an array of strings; null / a non-array / unparseable value / an
 * array with a non-string element all become null. NOTE: null here only means
 * "could not parse" — the null-vs-deny-all policy decision lives in
 * normalizeRow (#476: present-but-corrupt fails CLOSED to `[]`).
 */
export function parseToolAllowlist(value: unknown): string[] | null {
  // Shape guard only; the legacy double-encoding self-heal lives in
  // parseJsonbValue (database/utils.ts).
  return parseJsonbValue(
    value,
    (v): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string'),
  );
}

/**
 * Normalize a DB row so `toolAllowlist` is always `string[] | null`.
 *
 * FAIL-CLOSED (#476): a stored value that is PRESENT but cannot be parsed into
 * a string[] (corrupt JSON, a non-array, non-string elements) degrades to `[]`
 * = deny-all, so a corrupted allowlist can never silently widen to "the agent
 * gets ALL of the server's tools" (the old fail-open null). An error line is
 * logged (server id only, never the contents) so the admin can repair the row.
 * A column that is truly NULL/absent stays `null` = "no restriction".
 */
function normalizeRow(row: AiMcpServer): AiMcpServer {
  const parsed = parseToolAllowlist(row.toolAllowlist);
  if (parsed === null && row.toolAllowlist != null) {
    logger.error(
      `Corrupt tool_allowlist for MCP server ${row.id}; failing closed (NO tools allowed) — re-save the server's allowlist to repair it`,
    );
    return { ...row, toolAllowlist: [] };
  }
  return { ...row, toolAllowlist: parsed };
}
