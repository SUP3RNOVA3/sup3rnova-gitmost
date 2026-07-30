import { type Kysely, sql } from 'kysely';

/**
 * OAuth 2.1 for personal MCP servers (#687).
 *
 * Additive to #686:
 *   - `ai_mcp_servers.auth_type text NOT NULL DEFAULT 'static'` — every existing
 *     row stays a static server; a new value 'oauth2' opts a personal server into
 *     the OAuth flow. The column has a default and no backfill, so this is a
 *     metadata-only add (no hot-table rewrite/lock).
 *   - `ai_mcp_oauth_grants` — one row per OAuth server (1:1, PK = server_id,
 *     FK ai_mcp_servers.id ON DELETE CASCADE). Holds DCR client credentials, the
 *     discovered AS pins and the encrypted OAuth tokens.
 *
 * The `authorization_server` column is MANDATORY: the @ai-sdk/mcp code exchange
 * fails hard without stored AS metadata.
 *
 * The *_enc columns are AES-256-GCM blobs (SecretBoxService), write-only.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('ai_mcp_servers')
    .addColumn('auth_type', 'text', (col) =>
      col.notNull().defaultTo('static'),
    )
    .execute();

  await db.schema
    .createTable('ai_mcp_oauth_grants')
    .addColumn('server_id', 'uuid', (col) =>
      col
        .primaryKey()
        .references('ai_mcp_servers.id')
        .onDelete('cascade'),
    )
    .addColumn('client_id', 'text', (col) => col.notNull())
    .addColumn('client_secret_enc', 'text')
    .addColumn('authorization_server', 'text', (col) => col.notNull())
    .addColumn('authorization_endpoint', 'text')
    .addColumn('token_endpoint', 'text', (col) => col.notNull())
    .addColumn('access_token_enc', 'text')
    .addColumn('refresh_token_enc', 'text')
    .addColumn('expires_at', 'timestamptz')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('error_detail', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // ORDER MATTERS: purge the grants and the OAuth server rows BEFORE dropping
  // `auth_type`. If the column were dropped first, every OAuth server would
  // become indistinguishable from a static server (auth_type gone) but carry NO
  // static auth headers — a broken, header-less static server. Deleting the
  // OAuth rows first cascades their grants and keeps the rollback clean.
  await db
    .deleteFrom('ai_mcp_servers')
    .where('auth_type', '=', 'oauth2')
    .execute();

  await db.schema.dropTable('ai_mcp_oauth_grants').ifExists().execute();

  await db.schema
    .alterTable('ai_mcp_servers')
    .dropColumn('auth_type')
    .execute();
}
