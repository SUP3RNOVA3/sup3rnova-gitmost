import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import { AiMcpOauthGrant } from '@docmost/db/types/entity.types';

/**
 * Repository for OAuth 2.1 grants of personal MCP servers (#687), one row per
 * `auth_type='oauth2'` server (1:1, keyed by `server_id`).
 *
 * SECURITY (§8.10): the *_enc columns hold encrypted tokens / client secret.
 * They are decrypted ONLY in the server-side OAuth flow and NEVER returned to a
 * controller/UI nor logged. Callers must project `status` outward, never a token.
 *
 * TERMINAL WRITES (AGENTS #2/#5): every status transition is a single UPDATE (or
 * a delete). `updateTokens`/`markStatus` are UPDATE-only and return the affected-
 * row count so the caller can honour the "0 rows ⇒ the grant was disconnected
 * mid-flow, do NOT resurrect it" rule.
 */
@Injectable()
export class AiMcpOauthGrantRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByServerId(
    serverId: string,
    trx?: KyselyTransaction,
  ): Promise<AiMcpOauthGrant | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('aiMcpOauthGrants')
      .selectAll()
      .where('serverId', '=', serverId)
      .executeTakeFirst();
  }

  /**
   * Upsert the DCR/discovery result for a fresh authorization attempt: write the
   * client credentials + AS pins, set status='pending' and CLEAR any previous
   * tokens/error. A repeated Authorize (double-click / re-auth) simply overwrites
   * — the last successful callback wins (the flow context is self-contained).
   */
  async upsertStart(
    values: {
      serverId: string;
      clientId: string;
      clientSecretEnc: string | null;
      authorizationServer: string;
      authorizationEndpoint: string | null;
      tokenEndpoint: string;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .insertInto('aiMcpOauthGrants')
      .values({
        serverId: values.serverId,
        clientId: values.clientId,
        clientSecretEnc: values.clientSecretEnc,
        authorizationServer: values.authorizationServer,
        authorizationEndpoint: values.authorizationEndpoint,
        tokenEndpoint: values.tokenEndpoint,
        accessTokenEnc: null,
        refreshTokenEnc: null,
        expiresAt: null,
        status: 'pending',
        errorDetail: null,
        updatedAt: new Date(),
      })
      .onConflict((oc) =>
        oc.column('serverId').doUpdateSet({
          clientId: values.clientId,
          clientSecretEnc: values.clientSecretEnc,
          authorizationServer: values.authorizationServer,
          authorizationEndpoint: values.authorizationEndpoint,
          tokenEndpoint: values.tokenEndpoint,
          accessTokenEnc: null,
          refreshTokenEnc: null,
          expiresAt: null,
          status: 'pending',
          errorDetail: null,
          updatedAt: new Date(),
        }),
      )
      .execute();
  }

  /**
   * Persist a token rotation. UPDATE-only: if the grant was deleted (Disconnect /
   * server CASCADE) mid-flow, 0 rows are affected and we do NOT resurrect it.
   * Returns the number of rows updated.
   */
  async updateTokens(
    serverId: string,
    values: {
      accessTokenEnc: string;
      refreshTokenEnc: string | null;
      expiresAt: Date | null;
    },
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const res = await db
      .updateTable('aiMcpOauthGrants')
      .set({
        accessTokenEnc: values.accessTokenEnc,
        refreshTokenEnc: values.refreshTokenEnc,
        expiresAt: values.expiresAt,
        updatedAt: new Date(),
      })
      .where('serverId', '=', serverId)
      .executeTakeFirst();
    return Number(res?.numUpdatedRows ?? 0n);
  }

  /**
   * Transition the grant status (e.g. -> 'expired' on invalid_grant, -> 'error'
   * on a callback failure). UPDATE-only; returns the affected-row count so a
   * disconnected grant is never resurrected. Does NOT erase tokens.
   */
  async markStatus(
    serverId: string,
    status: 'pending' | 'connected' | 'expired' | 'error',
    errorDetail: string | null,
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const res = await db
      .updateTable('aiMcpOauthGrants')
      .set({ status, errorDetail, updatedAt: new Date() })
      .where('serverId', '=', serverId)
      .executeTakeFirst();
    return Number(res?.numUpdatedRows ?? 0n);
  }

  async delete(serverId: string, trx?: KyselyTransaction): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('aiMcpOauthGrants')
      .where('serverId', '=', serverId)
      .execute();
  }
}
