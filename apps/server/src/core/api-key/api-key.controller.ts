import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';
import { ApiKeyService } from './api-key.service';
import { ApiKeyRepo } from '@docmost/db/repos/api-key/api-key.repo';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { RevokeApiKeyDto } from './dto/revoke-api-key.dto';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import { AUTH_THROTTLER } from '../../integrations/throttle/throttler-names';

@UseGuards(JwtAuthGuard)
@Controller('api-keys')
export class ApiKeyController {
  private readonly logger = new Logger(ApiKeyController.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly environmentService: EnvironmentService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  // Kill-switch OFF: the issuance surface disappears entirely (404), not a 403 —
  // it must look like the feature does not exist.
  private assertEnabled(): void {
    if (!this.environmentService.isApiKeysEnabled()) {
      throw new NotFoundException();
    }
  }

  // A token cannot manage tokens (GitHub-PAT semantics): an api-key principal is
  // refused on the management surface, so a leaked key cannot mint a replacement
  // or revoke the keys that would lock it out (closes post-revocation laundering).
  private rejectApiKeyPrincipal(req: FastifyRequest): void {
    if ((req.raw as { authType?: string }).authType === 'api_key') {
      throw new ForbiddenException('API keys cannot manage API keys');
    }
  }

  private clientIp(req: FastifyRequest): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AUTH_THROTTLER]: { limit: 10, ttl: 60_000 } })
  @Post('create')
  async create(
    @Body() dto: CreateApiKeyDto,
    @AuthUser() user: User,
    @Req() req: FastifyRequest,
  ) {
    this.assertEnabled();
    this.rejectApiKeyPrincipal(req);

    // undefined -> service default (1 year); null -> unlimited; string -> Date.
    const expiresAt =
      dto.expiresAt === undefined
        ? undefined
        : dto.expiresAt === null
          ? null
          : new Date(dto.expiresAt);

    const { token, key } = await this.apiKeyService.create(
      user,
      dto.name,
      expiresAt,
    );

    this.auditService.log({
      event: AuditEvent.API_KEY_CREATED,
      resourceType: AuditResource.API_KEY,
      resourceId: key.id,
    });
    // The durable trail lives in container logs (AUDIT_SERVICE is a Noop in this
    // build). No token material — the JWT is only ever returned in the response.
    this.logger.log(
      `API key created: id=${key.id} name=${JSON.stringify(
        key.name,
      )} actor=${user.id} expiresAt=${
        key.expiresAt ? new Date(key.expiresAt).toISOString() : 'never'
      } ip=${this.clientIp(req)}`,
    );

    // Return the token ONCE (never retrievable again) and the computed expiry so
    // the caller/UI can surface "expires <date>" (the year-default time-bomb
    // early-warning).
    return {
      token,
      apiKey: {
        id: key.id,
        name: key.name,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      },
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('list')
  async list(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
  ) {
    this.assertEnabled();
    this.rejectApiKeyPrincipal(req);

    const ability = this.workspaceAbility.createForUser(user, workspace);
    // Admin (CASL Manage on API): every key in the workspace, attributed to its
    // creator (closes "a leaked key of a departed employee is invisible"). A
    // member sees only their own.
    const keys = ability.can(
      WorkspaceCaslAction.Manage,
      WorkspaceCaslSubject.API,
    )
      ? await this.apiKeyRepo.findAllInWorkspace(workspace.id)
      : await this.apiKeyRepo.findByCreator(user.id, workspace.id);

    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      expiresAt: k.expiresAt,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      creator: k.creator,
    }));
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revoke(
    @Body() dto: RevokeApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
  ) {
    this.assertEnabled();
    this.rejectApiKeyPrincipal(req);

    const key = await this.apiKeyRepo.findById(dto.id, workspace.id);
    // Uniform 404 for a missing/already-revoked key regardless of who asks — no
    // existence oracle for keys the caller may not own.
    if (!key) {
      throw new NotFoundException();
    }

    const ability = this.workspaceAbility.createForUser(user, workspace);
    const canManageAll = ability.can(
      WorkspaceCaslAction.Manage,
      WorkspaceCaslSubject.API,
    );
    // Admin may revoke any key in the workspace; a member only their own.
    if (!canManageAll && key.creatorId !== user.id) {
      throw new ForbiddenException();
    }

    await this.apiKeyService.revoke(key.id, workspace.id);

    this.auditService.log({
      event: AuditEvent.API_KEY_DELETED,
      resourceType: AuditResource.API_KEY,
      resourceId: key.id,
    });
    this.logger.log(
      `API key revoked: id=${key.id} name=${JSON.stringify(
        key.name,
      )} actor=${user.id} ip=${this.clientIp(req)}`,
    );

    return { success: true };
  }
}
