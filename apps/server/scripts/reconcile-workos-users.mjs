import { WorkOS } from '@workos-inc/node';
import postgres from 'postgres';

const apply = process.argv.includes('--apply');
const excludedEmails = new Set(
  (process.env.WORKOS_SYNC_EXCLUDED_EMAILS ?? 'astra@sup3rnova.com')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function listAll(fetchPage) {
  const rows = [];
  let after;
  do {
    const response = await fetchPage(after);
    rows.push(...response.data);
    after = response.listMetadata?.after;
  } while (after);
  return rows;
}

const workos = new WorkOS(required('WORKOS_API_KEY'), {
  clientId: required('WORKOS_CLIENT_ID'),
  apiHostname: process.env.WORKOS_API_HOSTNAME ?? 'api.workos.com',
  maxRetries: 0,
});
const organizationId = required('WORKOS_ORGANIZATION_ID');
const sql = postgres(required('DATABASE_URL'), { max: 1 });

try {
  const [users, memberships, workspaces] = await Promise.all([
    listAll((after) => workos.userManagement.listUsers({ limit: 100, after })),
    listAll((after) =>
      workos.userManagement.listOrganizationMemberships({
        organizationId,
        limit: 100,
        after,
      }),
    ),
    sql`select id from workspaces where deleted_at is null order by created_at`,
  ]);
  if (workspaces.length !== 1) {
    throw new Error(
      `Expected one Gitmost workspace, found ${workspaces.length}`,
    );
  }

  const usersById = new Map(users.map((user) => [user.id, user]));
  const roster = memberships
    .filter((membership) => membership.status === 'active')
    .map((membership) => usersById.get(membership.userId))
    .filter(Boolean)
    .filter((user) => user.email?.toLowerCase().endsWith('@sup3rnova.com'))
    .filter((user) => !excludedEmails.has(user.email.toLowerCase()));

  const duplicateEmails = roster.filter(
    (user, index) =>
      roster.findIndex(
        (candidate) =>
          candidate.email.toLowerCase() === user.email.toLowerCase(),
      ) !== index,
  );
  if (duplicateEmails.length) throw new Error('Duplicate WorkOS emails found');

  const workspaceId = workspaces[0].id;
  const existing = await sql`
    select lower(email) as email
    from users
    where workspace_id = ${workspaceId} and deleted_at is null
  `;
  const existingEmails = new Set(existing.map((row) => row.email));
  const plan = {
    workosMembers: roster.length,
    existingUsers: roster.filter((user) =>
      existingEmails.has(user.email.toLowerCase()),
    ).length,
    createUsers: roster.filter(
      (user) => !existingEmails.has(user.email.toLowerCase()),
    ).length,
    excludedServiceIdentities: excludedEmails.size,
    notifications: 0,
  };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', ...plan }));
  if (!apply) process.exit(0);

  await sql.begin(async (tx) => {
    const [provider] = await tx`
      insert into auth_providers (
        name, type, oidc_issuer, oidc_client_id, allow_signup,
        is_enabled, workspace_id
      ) values (
        'WorkOS AuthKit', 'oidc', ${`https://${process.env.WORKOS_API_HOSTNAME ?? 'api.workos.com'}`},
        ${required('WORKOS_CLIENT_ID')}, false, true, ${workspaceId}
      )
      on conflict (workspace_id, name) where deleted_at is null
      do update set
        oidc_client_id = excluded.oidc_client_id,
        oidc_issuer = excluded.oidc_issuer,
        is_enabled = true,
        updated_at = now()
      returning id
    `;

    for (const workosUser of roster) {
      const displayName =
        [workosUser.firstName, workosUser.lastName].filter(Boolean).join(' ') ||
        workosUser.email.split('@')[0];
      const [gitmostUser] = await tx`
        insert into users (
          name, email, email_verified_at, password, role, workspace_id,
          locale, last_login_at
        ) values (
          ${displayName}, ${workosUser.email.toLowerCase()}, now(), null,
          'member', ${workspaceId}, 'en-US', null
        )
        on conflict (email, workspace_id)
        do update set
          name = excluded.name,
          email_verified_at = coalesce(users.email_verified_at, now()),
          deactivated_at = null,
          updated_at = now()
        returning id
      `;
      await tx`
        insert into auth_accounts (
          user_id, provider_user_id, auth_provider_id, workspace_id
        ) values (
          ${gitmostUser.id}, ${workosUser.id}, ${provider.id}, ${workspaceId}
        )
        on conflict (user_id, auth_provider_id)
        do update set
          provider_user_id = excluded.provider_user_id,
          deleted_at = null,
          updated_at = now()
      `;
    }
  });

  const [verification] = await sql`
    select
      count(*) filter (where u.deleted_at is null) as users,
      count(*) filter (
        where aa.deleted_at is null and ap.name = 'WorkOS AuthKit'
      ) as linked_accounts,
      (select count(*) from workspace_invitations) as invitations
    from users u
    left join auth_accounts aa on aa.user_id = u.id
    left join auth_providers ap on ap.id = aa.auth_provider_id
    where u.workspace_id = ${workspaceId}
  `;
  console.log(
    JSON.stringify({
      applied: true,
      users: Number(verification.users),
      linkedAccounts: Number(verification.linked_accounts),
      invitations: Number(verification.invitations),
      notifications: 0,
    }),
  );
} finally {
  await sql.end();
}
