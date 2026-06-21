import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '@docmost/db/database.module';
import { EnvironmentModule } from '../environment/environment.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { PageModule } from '../../core/page/page.module';
import { GitmostDataSourceService } from './services/gitmost-datasource.service';
import { GitSyncOrchestrator } from './services/git-sync.orchestrator';
import { VaultRegistryService } from './services/vault-registry.service';
import { PageChangeListener } from './listeners/page-change.listener';
import { GitSyncController } from './git-sync.controller';

/**
 * The git-sync control plane (plan §6). Wires the native datasource, the
 * orchestrator (poll + leader-lock), the per-space vault registry, the
 * event-driven listener, and the admin trigger controller.
 *
 * Imports:
 *   - DatabaseModule (global) — PageRepo / SpaceRepo / KyselyDB for the
 *     datasource + orchestrator queries;
 *   - EnvironmentModule (global) — EnvironmentService config;
 *   - CollaborationModule — exports CollaborationGateway for native body writes;
 *   - PageModule — exports PageService for structural mutations;
 *   - ScheduleModule (NOT forRoot) — so @Interval is discovered. forRoot() is
 *     already registered globally by TelemetryModule; importing the plain module
 *     here avoids a duplicate scheduler registration (plan §6 note).
 *
 * RedisService is provided by the global RedisModule (app.module) and CASL's
 * WorkspaceAbilityFactory by the global CaslModule — both resolve without an
 * explicit import here.
 */
@Module({
  imports: [
    DatabaseModule,
    EnvironmentModule,
    CollaborationModule,
    PageModule,
    ScheduleModule,
  ],
  controllers: [GitSyncController],
  providers: [
    GitmostDataSourceService,
    GitSyncOrchestrator,
    VaultRegistryService,
    PageChangeListener,
  ],
})
export class GitSyncModule {}
