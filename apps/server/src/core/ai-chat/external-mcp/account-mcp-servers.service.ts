import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { AiMcpServer } from '@docmost/db/types/entity.types';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { SecretBoxService } from '../../../integrations/crypto/secret-box';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpClientsService } from './mcp-clients.service';
import { McpOauthService } from './mcp-oauth.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import {
  McpServerView,
  assertMcpUrlAllowed,
  encryptMcpHeaders,
  toMcpServerView,
} from './mcp-server-view.util';

/**
 * Personal external MCP servers (#686, phase 2 / PR A). A member manages their
 * OWN servers via `account/mcp-servers`; there is NO admin gate. This service is
 * the mirror of the admin `McpServersService` but every read/write goes through
 * the repo's owner-scoped `*ForUser` methods — a user can ONLY ever touch a row
 * they own (the repo is the isolation barrier, see ai-mcp-server.repo.ts).
 *
 * SECURITY (§8.10): the same write-only-headers contract as the admin path —
 * headers are encrypted on save and NEVER returned; the view carries only
 * `hasHeaders`. SSRF validation (`assertMcpUrlAllowed`) runs on every save.
 *
 * CACHE (#686 phase 3 / PR B): the agent loop now CONSUMES personal servers via
 * the per-user toolset cache (`McpClientsService.toolsFor(workspaceId, userId)`).
 * Every personal mutation therefore evicts THIS user's cache entry only, via
 * `invalidateUser(workspaceId, userId)` — the single-key eviction, never the
 * admin fan-out (a personal change affects no other user's toolset).
 */
@Injectable()
export class AccountMcpServersService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly repo: AiMcpServerRepo,
    private readonly secretBox: SecretBoxService,
    private readonly clients: McpClientsService,
    private readonly env: EnvironmentService,
    private readonly oauth: McpOauthService,
  ) {}

  async list(workspaceId: string, userId: string): Promise<McpServerView[]> {
    const rows = await this.repo.listByUser(workspaceId, userId);
    // #687: enrich oauth2 rows with their live grant status so the UI can show
    // Authorize/Reauthorize/Disconnect. Static rows carry a null grantStatus.
    return Promise.all(
      rows.map(async (r) => {
        const grantStatus =
          r.authType === 'oauth2'
            ? await this.oauth.getGrantStatus(r.id)
            : null;
        return toMcpServerView(r, grantStatus);
      }),
    );
  }

  /**
   * Create a personal server, enforcing the per-user cap under a row lock so
   * concurrent creates cannot both slip past the limit (#686). The whole
   * count-then-insert runs in ONE transaction:
   *   1. `lockUserRow` takes FOR NO KEY UPDATE on the user's `users` row —
   *      serializing this user's concurrent creates through a single gate;
   *   2. `countByUser` reads the current count under that lock;
   *   3. at/over the cap => reject; otherwise insert the row.
   * A burst of parallel creates therefore ends with AT MOST `max` rows.
   */
  async createPersonal(
    workspaceId: string,
    userId: string,
    dto: CreateMcpServerDto,
  ): Promise<McpServerView> {
    const authType = dto.authType ?? 'static';
    // #687: an OAuth server authenticates via the OAuth grant (Authorize flow),
    // NOT static headers — the two are mutually exclusive.
    const hasHeaders =
      dto.headers != null && Object.keys(dto.headers).length > 0;
    if (authType === 'oauth2' && hasHeaders) {
      throw new BadRequestException(
        'An OAuth (oauth2) MCP server cannot also carry static auth headers.',
      );
    }

    await assertMcpUrlAllowed(dto.url);

    // Encrypt the auth headers if any non-empty set was provided (static only).
    const headersEnc =
      authType === 'oauth2'
        ? undefined
        : encryptMcpHeaders(this.secretBox, dto.headers);

    const max = this.env.getMcpPersonalServersMax();

    const row = await executeTx(this.db, async (trx) => {
      // Serialize this user's concurrent creates so the cap is race-free.
      await this.repo.lockUserRow(userId, trx);

      const count = await this.repo.countByUser(userId, trx);
      if (count >= max) {
        throw new BadRequestException(
          `Personal MCP server limit reached (${max}). Delete an existing server before adding another.`,
        );
      }

      return this.repo.insert(
        {
          workspaceId,
          userId,
          name: dto.name,
          authType,
          transport: dto.transport,
          url: dto.url,
          headersEnc,
          toolAllowlist: dto.toolAllowlist ?? null,
          // Blank/whitespace guidance is normalized to null by the repo.
          instructions: dto.instructions ?? null,
          enabled: dto.enabled ?? true,
        },
        trx,
      );
    });

    // Evict this user's cached toolset so the new server is picked up next turn.
    this.clients.invalidateUser(workspaceId, userId);
    return toMcpServerView(row);
  }

  async update(
    workspaceId: string,
    userId: string,
    id: string,
    dto: UpdateMcpServerDto,
  ): Promise<McpServerView> {
    const existing = await this.repo.findByIdForUser(id, workspaceId, userId);
    if (!existing) {
      // 404: the server does not exist OR is not owned by this user — a member
      // can only ever act on their own rows.
      throw new NotFoundException('MCP server not found');
    }

    // #687: an OAuth server authenticates via its grant, NOT static headers.
    // create rejects oauth2+headers; update must too, or a user could stash a
    // useless encrypted header blob on an oauth2 row (and flip hasHeaders:true).
    if (
      existing.authType === 'oauth2' &&
      dto.headers != null &&
      Object.keys(dto.headers).length > 0
    ) {
      throw new BadRequestException(
        'An OAuth (oauth2) MCP server cannot carry static auth headers.',
      );
    }

    // Re-validate the URL whenever it changes (user-supplied -> SSRF risk). MUST
    // run BEFORE any mutation below (a validation failure must not touch the
    // grant or the row).
    const urlChanged = dto.url !== undefined && dto.url !== existing.url;
    const transportChanged =
      dto.transport !== undefined && dto.transport !== existing.transport;
    if (urlChanged) {
      await assertMcpUrlAllowed(dto.url);
    }

    // Header write-only semantics (§8.10):
    //  - absent      -> leave unchanged (headersEnc stays undefined in patch);
    //  - {} empty     -> clear (null);
    //  - non-empty   -> encrypt + replace.
    let headersEnc: string | null | undefined;
    if (dto.headers === undefined) {
      headersEnc = undefined; // unchanged
    } else if (Object.keys(dto.headers).length === 0) {
      headersEnc = null; // clear
    } else {
      headersEnc = encryptMcpHeaders(this.secretBox, dto.headers) ?? null;
    }

    // #687 (R1): a url/transport change on an OAuth server RESETS the grant to
    // `none` — a bearer minted for the old resource must not travel to a new
    // address, and refresh must stop hitting the old AS. Deleting the grant
    // (== status 'none') runs BEFORE the row write: otherwise a concurrent agent
    // tour could interleave on an await and read the row with the NEW url while
    // the grant is still `connected`, and connect to the new address with the
    // old-resource Bearer — exactly what R1 forbids. Resetting first means any
    // interleaving reads `none` (connect gate skips) until the row is rewritten.
    if (existing.authType === 'oauth2' && (urlChanged || transportChanged)) {
      await this.oauth.resetGrant(id);
      this.clients.invalidateUser(workspaceId, userId);
    }

    await this.repo.updateForUser(id, workspaceId, userId, {
      name: dto.name,
      transport: dto.transport,
      url: dto.url,
      headersEnc,
      // undefined => unchanged; null => no restriction; `[]` is persisted
      // verbatim and means deny-all (#476).
      toolAllowlist: dto.toolAllowlist,
      // undefined => unchanged; blank => cleared (null) by the repo.
      instructions: dto.instructions,
      enabled: dto.enabled,
    });

    // Evict this user's cached toolset so the edit takes effect next turn.
    this.clients.invalidateUser(workspaceId, userId);
    const updated = await this.repo.findByIdForUser(id, workspaceId, userId);
    const grantStatus =
      updated?.authType === 'oauth2'
        ? await this.oauth.getGrantStatus(id)
        : null;
    return toMcpServerView(updated as AiMcpServer, grantStatus);
  }

  async remove(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ success: true }> {
    const existing = await this.repo.findByIdForUser(id, workspaceId, userId);
    if (!existing) {
      // 404: not found for this user (another user's row is invisible here).
      throw new NotFoundException('MCP server not found');
    }
    await this.repo.deleteForUser(id, workspaceId, userId);
    // Evict this user's cached toolset so the removed server is gone next turn.
    this.clients.invalidateUser(workspaceId, userId);
    return { success: true };
  }

  /**
   * Connect to the user's own server and list its tools ("Test connection").
   * Reuses the admin test transport (never leaks headers or upstream bodies).
   * Scoped to the owner: a non-owner's id is simply "not found".
   */
  async test(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
    const row = await this.repo.findByIdForUser(id, workspaceId, userId);
    if (!row) {
      return { ok: false, error: 'MCP server not found' };
    }
    return this.clients.testServer({
      transport: row.transport,
      url: row.url,
      headersEnc: row.headersEnc,
    });
  }

  /**
   * Begin OAuth authorization for the user's own oauth2 server (#687): discovery
   * + DCR, persist a pending grant + the one-time state, and return the browser
   * authorize URL. Ownership-scoped (a non-owner id is "not found"); the server
   * MUST be oauth2.
   */
  async startOauth(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ authorizeUrl: string }> {
    const row = await this.repo.findByIdForUser(id, workspaceId, userId);
    if (!row) {
      throw new NotFoundException('MCP server not found');
    }
    if (row.authType !== 'oauth2') {
      throw new BadRequestException('This MCP server does not use OAuth.');
    }
    const { authorizeUrl } = await this.oauth.startAuthorization(userId, {
      id: row.id,
      workspaceId: row.workspaceId,
      url: row.url,
    });
    // The grant just moved to `pending`; refresh this user's toolset cache.
    this.clients.invalidateUser(workspaceId, userId);
    return { authorizeUrl };
  }

  /**
   * Disconnect the user's own oauth2 server (#687): delete the grant (status ->
   * `none`). The server row itself is preserved.
   */
  async disconnectOauth(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ success: true }> {
    const row = await this.repo.findByIdForUser(id, workspaceId, userId);
    if (!row) {
      throw new NotFoundException('MCP server not found');
    }
    if (row.authType !== 'oauth2') {
      throw new BadRequestException('This MCP server does not use OAuth.');
    }
    await this.oauth.disconnect(row.id);
    this.clients.invalidateUser(workspaceId, userId);
    return { success: true };
  }
}
