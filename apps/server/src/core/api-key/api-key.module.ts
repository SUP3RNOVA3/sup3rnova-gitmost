import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';
import { TokenModule } from '../auth/token.module';

// Core (non-EE) API-key feature: issuance REST endpoints + the shared validator
// consumed by jwt.strategy (REST) and McpService (the /mcp Bearer router).
// DatabaseModule (global) provides ApiKeyRepo/UserRepo/WorkspaceRepo; CaslModule
// (global) provides WorkspaceAbilityFactory; TokenModule provides TokenService
// (the no-exp api-key signer). ApiKeyService is exported so AuthModule (for
// jwt.strategy) and McpModule (for the /mcp router) can inject it directly,
// replacing the absent EE `ee/api-key` dynamic require.
@Module({
  imports: [TokenModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
