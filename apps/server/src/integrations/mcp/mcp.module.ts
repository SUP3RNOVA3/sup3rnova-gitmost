import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { DatabaseModule } from '@docmost/db/database.module';
import { AuthModule } from '../../core/auth/auth.module';
import { TokenModule } from '../../core/auth/token.module';
import { ApiKeyModule } from '../../core/api-key/api-key.module';

// Community MCP feature: the server itself serves the Model Context Protocol
// over HTTP at /mcp. DatabaseModule (global) provides WorkspaceRepo. AuthModule
// supplies AuthService (per-user HTTP-Basic login validation) and TokenModule
// supplies TokenService (Bearer JWT verification for the token path). ApiKeyModule
// supplies ApiKeyService (the shared api-key row-check for the API_KEY Bearer
// branch, so an agent authenticates with a key instead of the bcrypt Basic path).
@Module({
  imports: [DatabaseModule, AuthModule, TokenModule, ApiKeyModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
