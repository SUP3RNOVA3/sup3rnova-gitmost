import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { WorkOS } from '@workos-inc/node';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { SessionService } from '../../session/session.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { isUserDisabled } from '../../../common/helpers';
import { User } from '@docmost/db/types/entity.types';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';

const STATE_TTL_SECONDS = 600;
const PROVIDER_NAME = 'WorkOS AuthKit';

type PendingAuthorization = {
  codeVerifier: string;
  returnPath: string;
  workspaceId: string;
};

export function safeReturnPath(value?: string): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n]/.test(value)
  ) {
    return '/';
  }
  return value;
}

@Injectable()
export class WorkosAuthService {
  private readonly redis: Redis;

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly redisService: RedisService,
    private readonly userRepo: UserRepo,
    private readonly sessionService: SessionService,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {
    this.redis = this.redisService.getOrThrow();
  }

  isEnabled(): boolean {
    return this.environmentService.isWorkosEnabled();
  }

  async getAuthorizationUrl(
    workspaceId: string,
    redirectUri: string,
    returnPath?: string,
  ): Promise<string> {
    const workos = this.getClient();
    const clientId = this.requiredConfig(
      this.environmentService.getWorkosClientId(),
    );
    const organizationId = this.requiredConfig(
      this.environmentService.getWorkosOrganizationId(),
    );
    const { url, state, codeVerifier } =
      await workos.userManagement.getAuthorizationUrlWithPKCE({
        clientId,
        organizationId,
        provider: 'authkit',
        redirectUri,
      });

    const pending: PendingAuthorization = {
      codeVerifier,
      returnPath: safeReturnPath(returnPath),
      workspaceId,
    };
    await this.redis.set(
      this.stateKey(state),
      JSON.stringify(pending),
      'EX',
      STATE_TTL_SECONDS,
    );
    return url;
  }

  async authenticateCallback(input: {
    code?: string;
    state?: string;
    workspaceId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ authToken: string; returnPath: string }> {
    if (!input.code || !input.state) {
      throw new BadRequestException('Invalid WorkOS callback.');
    }

    const encoded = await this.redis.getdel(this.stateKey(input.state));
    if (!encoded) {
      throw new BadRequestException('Expired or already-used login state.');
    }

    const pending = JSON.parse(encoded) as PendingAuthorization;
    if (pending.workspaceId !== input.workspaceId) {
      throw new ForbiddenException('Workspace mismatch.');
    }

    const clientId = this.requiredConfig(
      this.environmentService.getWorkosClientId(),
    );
    const expectedOrganizationId = this.requiredConfig(
      this.environmentService.getWorkosOrganizationId(),
    );
    const authentication =
      await this.getClient().userManagement.authenticateWithCode({
        clientId,
        code: input.code,
        codeVerifier: pending.codeVerifier,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });

    if (authentication.organizationId !== expectedOrganizationId) {
      throw new ForbiddenException('SUP3RNOVA membership is required.');
    }

    const user = await this.resolveProvisionedUser({
      providerUserId: authentication.user.id,
      email: authentication.user.email,
      workspaceId: input.workspaceId,
    });
    if (!user || isUserDisabled(user)) {
      throw new ForbiddenException('This Gitmost account is not active.');
    }

    await this.ensureDefaultGroupMembership(user.id, input.workspaceId);
    await this.userRepo.updateLastLogin(user.id, input.workspaceId);
    this.auditService.setActorId(user.id);
    this.auditService.log({
      event: AuditEvent.USER_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source: 'workos' },
    });
    return {
      authToken: await this.sessionService.createSessionAndToken(user),
      returnPath: pending.returnPath,
    };
  }

  private async resolveProvisionedUser(input: {
    providerUserId: string;
    email: string;
    workspaceId: string;
  }): Promise<User | undefined> {
    const providerId = await this.ensureProvider(input.workspaceId);
    const linkedAccount = await this.db
      .selectFrom('authAccounts')
      .select('userId')
      .where('authProviderId', '=', providerId)
      .where('providerUserId', '=', input.providerUserId)
      .where('workspaceId', '=', input.workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (linkedAccount) {
      return this.userRepo.findById(linkedAccount.userId, input.workspaceId);
    }

    const user = await this.userRepo.findByEmail(
      input.email,
      input.workspaceId,
    );
    if (!user || isUserDisabled(user)) return undefined;

    await this.db
      .insertInto('authAccounts')
      .values({
        userId: user.id,
        providerUserId: input.providerUserId,
        authProviderId: providerId,
        workspaceId: input.workspaceId,
      })
      .onConflict((oc) =>
        oc.columns(['userId', 'authProviderId']).doUpdateSet({
          providerUserId: input.providerUserId,
          deletedAt: null,
          updatedAt: new Date(),
        }),
      )
      .execute();
    return user;
  }

  private async ensureProvider(workspaceId: string): Promise<string> {
    const existing = await this.db
      .selectFrom('authProviders')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('name', '=', PROVIDER_NAME)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (existing) return existing.id;

    const created = await this.db
      .insertInto('authProviders')
      .values({
        name: PROVIDER_NAME,
        type: 'oidc',
        oidcIssuer: `https://${this.environmentService.getWorkosApiHostname()}`,
        oidcClientId: this.requiredConfig(
          this.environmentService.getWorkosClientId(),
        ),
        allowSignup: false,
        isEnabled: true,
        workspaceId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return created.id;
  }

  private async ensureDefaultGroupMembership(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const defaultGroup = await this.db
      .selectFrom('groups')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('isDefault', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirstOrThrow();

    await this.db
      .insertInto('groupUsers')
      .values({ userId, groupId: defaultGroup.id })
      .onConflict((oc) => oc.columns(['groupId', 'userId']).doNothing())
      .execute();
  }

  private getClient(): WorkOS {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('WorkOS login is not enabled.');
    }
    return new WorkOS(
      this.requiredConfig(this.environmentService.getWorkosApiKey()),
      {
        clientId: this.requiredConfig(
          this.environmentService.getWorkosClientId(),
        ),
        apiHostname: this.environmentService.getWorkosApiHostname(),
        maxRetries: 0,
      },
    );
  }

  private requiredConfig(value?: string): string {
    if (!value) {
      throw new ServiceUnavailableException(
        'WorkOS login is not fully configured.',
      );
    }
    return value;
  }

  private stateKey(state: string): string {
    return `gitmost:workos-state:${state}`;
  }
}
