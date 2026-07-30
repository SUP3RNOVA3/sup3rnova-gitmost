import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../integrations/crypto/crypto.module';
import { McpClientsService } from './mcp-clients.service';
import { McpServersService } from './mcp-servers.service';
import { McpServersController } from './mcp-servers.controller';
import { AccountMcpServersService } from './account-mcp-servers.service';
import { AccountMcpServersController } from './account-mcp-servers.controller';
import { McpOauthService } from './mcp-oauth.service';
import { McpOauthCallbackController } from './mcp-oauth-callback.controller';

/**
 * External MCP servers unit (§6.8 / E1-E3). Lets the agent use admin-configured
 * external MCP servers (e.g. Tavily web search); gitmost is the MCP CLIENT.
 *
 * CryptoModule supplies SecretBoxService for the encrypted auth headers.
 * AiMcpServerRepo (DatabaseModule, global), WorkspaceAbilityFactory (CaslModule,
 * global) and EnvironmentService (EnvironmentModule, global) are resolved
 * without explicit imports. McpClientsService is exported so the agent loop can
 * merge external tools into the toolset.
 *
 * The `Account*` pair (#686) exposes the personal-server CRUD API
 * (`account/mcp-servers`) — no admin gate, owner-scoped, kill-switch guarded.
 */
@Module({
  imports: [CryptoModule],
  controllers: [
    McpServersController,
    AccountMcpServersController,
    // #687: the OAuth callback lives in its own controller so the kill-switch
    // gates it too (a flow begun before the flip must not write tokens).
    McpOauthCallbackController,
  ],
  providers: [
    McpClientsService,
    McpServersService,
    AccountMcpServersService,
    // #687: OAuth 2.1 flow + runtime token service (single-flight refresh).
    McpOauthService,
  ],
  exports: [McpClientsService],
})
export class ExternalMcpModule {}
