import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { resolveRequestWorkspace } from '../helpers/resolve-request-workspace';

@Injectable()
export class DomainMiddleware implements NestMiddleware {
  constructor(
    private workspaceRepo: WorkspaceRepo,
    private environmentService: EnvironmentService,
  ) {}
  async use(
    req: FastifyRequest['raw'],
    res: FastifyReply['raw'],
    next: () => void,
  ) {
    // Shared self-hosted/cloud resolution (the SAME branch the /git host uses),
    // so the logic cannot drift between the two.
    const workspace = await resolveRequestWorkspace(
      this.environmentService,
      this.workspaceRepo,
      req.headers.host,
    );

    if (workspace) {
      (req as any).workspaceId = workspace.id;
      (req as any).workspace = workspace;
    } else {
      (req as any).workspaceId = null;
    }

    next();
  }
}
