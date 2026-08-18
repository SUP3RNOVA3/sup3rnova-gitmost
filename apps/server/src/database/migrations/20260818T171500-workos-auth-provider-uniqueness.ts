import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create unique index auth_providers_workspace_name_active_unique
    on auth_providers (workspace_id, name)
    where deleted_at is null
  `.execute(db);

  await sql`
    create unique index auth_accounts_provider_user_active_unique
    on auth_accounts (auth_provider_id, provider_user_id)
    where deleted_at is null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('auth_accounts_provider_user_active_unique')
    .execute();
  await db.schema
    .dropIndex('auth_providers_workspace_name_active_unique')
    .execute();
}
