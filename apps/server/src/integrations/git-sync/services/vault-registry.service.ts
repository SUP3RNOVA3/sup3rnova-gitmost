import { Injectable, Logger } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { VaultGit } from '@docmost/git-sync';
import { EnvironmentService } from '../../environment/environment.service';

/**
 * Resolves the on-disk vault location per space and owns the (lazily created,
 * cached) `VaultGit` instance for each one (plan §3/§5).
 *
 * Topology (plan §5): one git repo per enabled space, rooted at
 * `<GIT_SYNC_DATA_DIR>/<spaceId>`. A `VaultGit` is constructed at most once per
 * space and reused across cycles — it is a thin, stateless shell-out wrapper, so
 * caching it just avoids re-resolving the path and re-running `mkdir`.
 */
@Injectable()
export class VaultRegistryService {
  private readonly logger = new Logger(VaultRegistryService.name);
  private readonly vaults = new Map<string, VaultGit>();

  constructor(private readonly environmentService: EnvironmentService) {}

  /** Absolute vault path for a space: `<GIT_SYNC_DATA_DIR>/<spaceId>`. */
  vaultPath(spaceId: string): string {
    const root = this.environmentService.getGitSyncDataDir().replace(/\/+$/, '');
    return `${root}/${spaceId}`;
  }

  /**
   * Get (or lazily construct + cache) the `VaultGit` for a space, ensuring its
   * directory exists. `VaultGit.ensureRepo()` is NOT called here — the engine's
   * pull/push paths call it (and the branch/ref setup) as their first step; this
   * only guarantees the parent dir exists so a fresh space does not ENOENT.
   */
  async getVault(spaceId: string): Promise<VaultGit> {
    const cached = this.vaults.get(spaceId);
    if (cached) return cached;

    const path = this.vaultPath(spaceId);
    await mkdir(path, { recursive: true });
    const vault = new VaultGit(path);
    this.vaults.set(spaceId, vault);
    return vault;
  }
}
