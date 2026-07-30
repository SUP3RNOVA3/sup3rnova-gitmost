import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { AccountMcpServersService } from './account-mcp-servers.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { McpServerIdDto } from './dto/mcp-server-id.dto';

/**
 * Personal external MCP server management (#686, phase 2). Unlike the admin
 * controller (`workspace/ai-mcp-servers`), there is NO CASL admin gate: any
 * authenticated member manages their OWN servers, scoped by `user.id`. Routes
 * are POST to match this codebase's convention (POST for reads too), mirroring
 * the admin controller shape.
 *
 * KILL-SWITCH (#686): when `MCP_PERSONAL_SERVERS_ENABLED=false` every endpoint
 * answers 403 — a sanctioned feature-off switch, not a rollout fork. Personal
 * rows already in the DB simply stop being manageable (and, in phase 3, drop
 * out of the agent union).
 *
 * SECURITY (§8.10): no route ever returns the encrypted auth headers; every
 * view carries only `hasHeaders`.
 */
@UseGuards(JwtAuthGuard)
@Controller('account/mcp-servers')
export class AccountMcpServersController {
  constructor(
    private readonly service: AccountMcpServersService,
    private readonly env: EnvironmentService,
  ) {}

  /** 403 when the personal-servers feature is switched off. */
  private assertEnabled(): void {
    if (!this.env.isMcpPersonalServersEnabled()) {
      throw new ForbiddenException(
        'Personal external MCP servers are disabled on this instance.',
      );
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertEnabled();
    return this.service.list(workspace.id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateMcpServerDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertEnabled();
    return this.service.createPersonal(workspace.id, user.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() idDto: McpServerIdDto,
    @Body() dto: UpdateMcpServerDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertEnabled();
    return this.service.update(workspace.id, user.id, idDto.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(
    @Body() idDto: McpServerIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertEnabled();
    return this.service.remove(workspace.id, user.id, idDto.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  async test(
    @Body() idDto: McpServerIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertEnabled();
    return this.service.test(workspace.id, user.id, idDto.id);
  }

  /**
   * #687: begin OAuth authorization for the user's own oauth2 server. Returns
   * the browser authorize URL. `:id` is UUID-validated up front (a non-UUID
   * would 500 in the query otherwise). Kill-switch gated.
   */
  @HttpCode(HttpStatus.OK)
  @Post(':id/oauth/start')
  async oauthStart(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertEnabled();
    return this.service.startOauth(workspace.id, user.id, id);
  }

  /** #687: disconnect (delete the grant) for the user's own oauth2 server. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/oauth/disconnect')
  async oauthDisconnect(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertEnabled();
    return this.service.disconnectOauth(workspace.id, user.id, id);
  }
}
