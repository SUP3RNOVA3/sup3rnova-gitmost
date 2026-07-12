import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { v7 as uuid7 } from 'uuid';
import { ApiKeyRepo } from '@docmost/db/repos/api-key/api-key.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { TokenService } from '../auth/services/token.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { JwtApiKeyPayload } from '../auth/dto/jwt-payload';
import { ApiKey, User, Workspace } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../common/helpers';

// Default lifetime for a new key when the caller does not specify one: 1 year.
// The owner runs a homelab where agents live for years; forcing rotation is
// operational pain, so an explicit `null` (unlimited) is also allowed.
const DEFAULT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

// last_used_at is a best-effort forensics stamp, not an access record; we only
// refresh it when it is older than this to avoid a write on every request. The
// 1h resolution is a deliberate constant (forensics granularity, not accounting).
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Core API-key lifecycle service. Owns minting (create), the single validator
 * shared by BOTH the REST jwt.strategy path and the /mcp Bearer path (validate),
 * and revocation (revoke). The `api_keys` ROW is the sole source of truth for a
 * key's lifetime and revocation — never the JWT, which carries no `exp` claim.
 */
@Injectable()
export class ApiKeyService implements OnModuleInit {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly tokenService: TokenService,
    private readonly environmentService: EnvironmentService,
  ) {}

  onModuleInit() {
    // Boot log so the kill-switch state after each deploy is verifiable in logs.
    const enabled = this.environmentService.isApiKeysEnabled();
    const raw = this.environmentService.getApiKeysEnabledRaw();
    this.logger.log(
      `API keys: ${enabled ? 'ENABLED' : 'DISABLED'} (API_KEYS_ENABLED=${
        raw ?? 'unset'
      })`,
    );
  }

  /**
   * Mint a new key for `user`. mint-then-insert ordering (R1):
   *   1. generate the id first — it must be in the JWT payload before the row.
   *   2. mint the JWT (no `exp` claim). A mint failure aborts before any row is
   *      written (inert), so a half-created key cannot exist.
   *   3. insert the row last. A lost response leaves an orphaned row that is
   *      visible in `list` and self-heals (the user revokes it).
   * The token is returned ONCE and never stored — the JWT is self-contained, so
   * no token material lives in the table.
   *
   * `expiresAt`: `undefined` -> default 1 year; `null` -> unlimited (explicit);
   * a Date -> that instant (a past date is rejected at the DTO layer).
   */
  async create(
    user: User,
    name: string,
    expiresAt?: Date | null,
  ): Promise<{ token: string; key: ApiKey }> {
    const resolvedExpiresAt =
      expiresAt === undefined
        ? new Date(Date.now() + DEFAULT_LIFETIME_MS)
        : expiresAt;

    const apiKeyId = uuid7();

    const token = await this.tokenService.generateApiToken({
      apiKeyId,
      user,
      workspaceId: user.workspaceId,
    });

    const key = await this.apiKeyRepo.insert({
      id: apiKeyId,
      name,
      creatorId: user.id,
      workspaceId: user.workspaceId,
      expiresAt: resolvedExpiresAt,
    });

    return { token, key };
  }

  /**
   * The single validator for an api-key principal, shared by jwt.strategy and the
   * /mcp Bearer router. Returns `{ user, workspace }` (the same shape the access
   * path returns) so the AuthUser/AuthWorkspace decorators and MCP identity work
   * unchanged.
   *
   * Failure semantics (R4, anti-enumeration): a DEFINITE negative fact — feature
   * disabled, missing/revoked/expired row, workspace mismatch, disabled user —
   * throws a bare `UnauthorizedException` (a single generic 401 for every case;
   * an agent cannot distinguish expired from revoked, and its reaction is
   * identical). An UNEXPECTED (infra) error is NOT caught here: it propagates so
   * the surface returns 5xx, never a masked 401 (deny-on-decision / 5xx-on-infra).
   * There is NO validate cache: it is 2–3 PK lookups (~1ms), two orders of
   * magnitude cheaper than the bcrypt it replaces; a cache would only add a
   * Date-serialization trap and a revocation lag. Revocation is immediate.
   */
  async validate(
    payload: JwtApiKeyPayload,
  ): Promise<{ user: User; workspace: Workspace }> {
    // Kill-switch OFF: deny unconditionally (same generic 401). Note the
    // endpoints additionally 404 at the controller; here we deny the token.
    if (!this.environmentService.isApiKeysEnabled()) {
      throw new UnauthorizedException();
    }

    if (!payload?.apiKeyId || !payload?.sub || !payload?.workspaceId) {
      throw new UnauthorizedException();
    }

    const row = await this.apiKeyRepo.findById(
      payload.apiKeyId,
      payload.workspaceId,
    );
    // Absent row = revoked (soft-deleted, invisible to findById), orphaned
    // (creator/workspace cascade-deleted), or never existed. All terminal deny.
    if (!row) {
      throw new UnauthorizedException();
    }

    // Expiry is read from the ROW, never an `exp` JWT claim.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException();
    }

    const user = await this.userRepo.findById(
      payload.sub,
      payload.workspaceId,
      { includeIsAgent: true },
    );
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    // The key acts only as its creator (defence in depth against a token whose
    // signed `sub` ever drifted from the row's owner).
    if (row.creatorId !== user.id) {
      throw new UnauthorizedException();
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) {
      throw new UnauthorizedException();
    }

    // Best-effort, throttled, fire-and-forget forensics stamp AFTER all checks.
    this.touchLastUsed(row);

    return { user, workspace };
  }

  /**
   * Revoke (soft-delete) a key. Authorization/ownership is decided by the caller
   * (the controller, via CASL); this only performs the terminal write. Idempotent:
   * a second revoke is a no-op (the row is already invisible).
   */
  async revoke(id: string, workspaceId: string): Promise<void> {
    await this.apiKeyRepo.softDelete(id, workspaceId);
  }

  // Throttled best-effort last_used_at bump: skip if it was touched within the
  // window; otherwise fire-and-forget so a stamp write never fails or slows the
  // request (mirrors SessionActivityService.trackActivity).
  private touchLastUsed(row: ApiKey): void {
    const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (Date.now() - last < LAST_USED_THROTTLE_MS) return;
    void this.apiKeyRepo.touchLastUsed(row.id).catch((err) => {
      this.logger.warn(
        `Failed to update api_key last_used_at for ${row.id}: ${
          (err as Error)?.message ?? err
        }`,
      );
    });
  }
}
