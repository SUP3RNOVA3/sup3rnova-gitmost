import {
  Controller,
  Get,
  Logger,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpOauthService } from './mcp-oauth.service';

/**
 * The OAuth 2.1 callback for personal MCP servers (#687): a top-level GET the
 * authorization server redirects the browser to at
 * `${APP_URL}/api/mcp-oauth/callback?code&state`.
 *
 * It is a SEPARATE controller from the account CRUD (per spec) so the kill-switch
 * gates it too — a flow begun before the switch was flipped must NOT write tokens
 * once the feature is off. Under `JwtAuthGuard`: the `authToken` cookie is
 * `sameSite:lax`, so it rides a top-level GET navigation.
 *
 * SECURITY (anti-grant-fixation): the one-time state is gashed atomically, then
 * BOTH `state.userId === authUser.id` AND row ownership are enforced BEFORE any
 * code exchange. Without these, another account's authorize URL opened in this
 * session would write that account's tokens into a grant here.
 */
@UseGuards(JwtAuthGuard)
@Controller('mcp-oauth')
export class McpOauthCallbackController {
  private readonly logger = new Logger(McpOauthCallbackController.name);

  constructor(
    private readonly oauth: McpOauthService,
    private readonly repo: AiMcpServerRepo,
    private readonly env: EnvironmentService,
  ) {}

  private settingsUrl(param: 'connected' | 'error'): string {
    return `${this.env.getAppUrl()}/settings/account/mcp-servers?oauth=${param}`;
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ): Promise<void> {
    // Kill-switch: do NOT process a callback when the feature is off (no token
    // write). Bounce to the settings page with an error marker.
    if (!this.env.isMcpPersonalServersEnabled()) {
      res.redirect(this.settingsUrl('error'), 302);
      return;
    }

    if (typeof state !== 'string' || state.length === 0) {
      res.status(400).send({ message: 'Missing OAuth state.' });
      return;
    }

    // One-time gash the state (MULTI get+del). A Redis CONNECTION error (down)
    // must NOT transition any grant — bounce with an error and log the cause. A
    // simply-absent key (replay/expired) is a 400.
    let payload: Awaited<ReturnType<McpOauthService['consumeState']>>;
    try {
      payload = await this.oauth.consumeState(state);
    } catch (err) {
      this.logError('OAuth callback: state store unavailable', err);
      res.redirect(this.settingsUrl('error'), 302);
      return;
    }
    if (!payload) {
      res.status(400).send({ message: 'Invalid or expired OAuth state.' });
      return;
    }

    // Anti-grant-fixation: the state MUST belong to this authenticated user AND
    // the server row MUST be owned by them — else 403 with NO exchange.
    if (payload.userId !== user.id) {
      res.status(403).send({ message: 'OAuth state does not belong to you.' });
      return;
    }
    const server = await this.repo.findByIdForUser(
      payload.serverId,
      workspace.id,
      user.id,
    );
    if (!server || server.authType !== 'oauth2') {
      res.status(403).send({ message: 'OAuth server not found.' });
      return;
    }

    // Explicit consent error (e.g. the user pressed Cancel -> access_denied):
    // record it on the grant and bounce with an error marker (no exchange).
    if (typeof error === 'string' && error.length > 0) {
      await this.oauth.markCallbackError(server.id, error);
      res.redirect(this.settingsUrl('error'), 302);
      return;
    }

    if (typeof code !== 'string' || code.length === 0) {
      res.status(400).send({ message: 'Missing OAuth authorization code.' });
      return;
    }

    const outcome = await this.oauth.completeCallback(
      { id: server.id, workspaceId: server.workspaceId, url: server.url },
      code,
      state,
      payload.codeVerifier,
    );
    res.redirect(this.settingsUrl(outcome), 302);
  }

  private logError(context: string, err: unknown): void {
    const e = err as { name?: string; message?: string; stack?: string };
    this.logger.error(
      `${context}: ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`,
      e?.stack,
    );
  }
}
