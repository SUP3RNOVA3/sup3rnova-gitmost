import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { JwtApiKeyPayload, JwtPayload, JwtType } from '../dto/jwt-payload';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { SessionActivityService } from '../../session/session-activity.service';
import { FastifyRequest } from 'fastify';
import { extractBearerTokenFromHeader, isUserDisabled } from '../../../common/helpers';
import { ModuleRef } from '@nestjs/core';
import { resolveProvenance } from '../../../common/decorators/auth-provenance.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private logger = new Logger('JwtStrategy');

  constructor(
    private userRepo: UserRepo,
    private workspaceRepo: WorkspaceRepo,
    private userSessionRepo: UserSessionRepo,
    private sessionActivityService: SessionActivityService,
    private readonly environmentService: EnvironmentService,
    private moduleRef: ModuleRef,
  ) {
    super({
      jwtFromRequest: (req: FastifyRequest) => {
        return req.cookies?.authToken || extractBearerTokenFromHeader(req);
      },
      ignoreExpiration: false,
      secretOrKey: environmentService.getAppSecret(),
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: JwtPayload | JwtApiKeyPayload) {
    if (!payload.workspaceId) {
      throw new UnauthorizedException();
    }

    if (req.raw.workspaceId && req.raw.workspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }

    if (payload.type === JwtType.API_KEY) {
      return this.validateApiKey(req, payload as JwtApiKeyPayload);
    }

    if (payload.type !== JwtType.ACCESS) {
      throw new UnauthorizedException();
    }

    // #348 — reuse the workspace DomainMiddleware already loaded for this request
    // instead of re-querying it. `validate()` above has confirmed
    // `req.raw.workspaceId === payload.workspaceId` (or that it is unset), and the
    // middleware sets `req.raw.workspace` alongside `req.raw.workspaceId` from the
    // SAME workspace row, so when the ids match this is that row. NOTE it is the
    // middleware's `selectAll` object (a superset of the fallback `findById` base
    // fields — it also carries licenseKey/auditRetentionDays); that is harmless
    // here because every consumer reads this workspace via the AuthWorkspace
    // decorator, which already preferred `req.raw.workspace` (the selectAll object)
    // over `req.user.workspace` before this change. Fall back to the query if the
    // middleware did not populate it (a path that bypasses DomainMiddleware).
    const workspace =
      req.raw.workspace && req.raw.workspaceId === payload.workspaceId
        ? req.raw.workspace
        : await this.workspaceRepo.findById(payload.workspaceId);

    if (!workspace) {
      throw new UnauthorizedException();
    }
    const user = await this.userRepo.findById(payload.sub, payload.workspaceId, {
      includeIsAgent: true,
    });

    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    if ((payload as JwtPayload).sessionId) {
      const sessionId = (payload as JwtPayload).sessionId;
      const session = await this.userSessionRepo.findActiveById(sessionId);
      if (!session || session.userId !== payload.sub || session.workspaceId !== payload.workspaceId) {
        throw new UnauthorizedException();
      }
      req.raw.sessionId = sessionId;
      this.sessionActivityService.trackActivity(sessionId, payload.sub, payload.workspaceId);
    }

    // Propagate the agent-edit provenance onto the request so REST
    // services/controllers can set the 'agent' marker off it. Derived from the
    // SIGNED server-side identity via the shared resolver (also used by the
    // collab seam, so the two never drift), never from a client body field — so
    // an is_agent service account stamps every REST write made with an access
    // token, and a normal user cannot fake an 'agent' badge.
    const provenance = resolveProvenance(user, payload as JwtPayload);
    req.raw.actor = provenance.actor;
    req.raw.aiChatId = provenance.aiChatId;

    return { user, workspace };
  }

  private async validateApiKey(req: any, payload: JwtApiKeyPayload) {
    const apiKeyService = this.resolveApiKeyService();
    if (!apiKeyService) {
      throw new UnauthorizedException('Enterprise API Key module missing');
    }

    const result = await apiKeyService.validateApiKey(payload);

    // Stamp the agent-edit provenance for the API-KEY path too (#486). Unlike the
    // access-token path above, it CANNOT be resolved before this point: the
    // API-key payload carries no signed actor/aiChatId claim, and the user (with
    // its isAgent flag) is unknown until the key is validated. Claim semantics for
    // API keys: an is_agent API key (an agent service account) stamps 'agent' on
    // every REST write; an ordinary API key resolves to 'user'. An API key has no
    // internal ai_chats row, so aiChatId is always null. Derived from the
    // SERVER-SIDE user (never a client field), so an 'agent' badge is unspoofable
    // — mirroring the access-token path. Passing `null` for the claim means the
    // actor is decided solely by user.isAgent.
    const provenance = resolveProvenance((result as any)?.user, null);
    req.raw.actor = provenance.actor;
    req.raw.aiChatId = provenance.aiChatId;

    return result;
  }

  /**
   * Resolve the enterprise ApiKeyService, or `null` when the EE module is not
   * bundled in this build (community build). Extracted as an overridable seam so
   * the API-key provenance stamping can be unit-tested without the EE package
   * present (docmost is OSS + a separate EE bundle; `require` of the EE path
   * throws here). Any load/resolve error is treated as "module missing".
   */
  protected resolveApiKeyService(): {
    validateApiKey: (payload: JwtApiKeyPayload) => Promise<unknown>;
  } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ApiKeyModule = require('./../../../ee/api-key/api-key.service');
      return this.moduleRef.get(ApiKeyModule.ApiKeyService, { strict: false });
    } catch (err) {
      this.logger.debug(
        'API Key module requested but enterprise module not bundled in this build',
      );
      return null;
    }
  }
}
