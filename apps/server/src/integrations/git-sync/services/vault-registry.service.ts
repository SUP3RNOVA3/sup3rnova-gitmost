import { Injectable, Logger } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VaultGit, vaultGitEnv } from '@docmost/git-sync';
import { EnvironmentService } from '../../environment/environment.service';

const execFileAsync = promisify(execFile);

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

  /**
   * Make a space's vault repo servable over smart-HTTP (the /git host). Ensures
   * the repo exists (engine `ensureRepo`: `git init -b main` + initial commit +
   * branches; idempotent), then sets the LOCAL git config a `git http-backend`
   * push needs:
   *
   *   - receive.denyCurrentBranch=updateInstead — a push to the checked-out
   *     `main` updates the working tree too (the engine's human-facing branch).
   *     Requires a clean tree, which is guaranteed between cycles / under the
   *     orchestrator lock that wraps an external push.
   *   - receive.denyNonFastForwards=true — block force-push so a client cannot
   *     rewrite the engine's history on `main`.
   *   - http.receivepack=true / http.uploadpack=true — explicitly allow the
   *     receive/upload services over HTTP.
   *
   * All four are set idempotently (plain `git config` overwrites the local
   * value). Returns the absolute vault path. Idempotent and safe to call before
   * every request.
   */
  async ensureServable(spaceId: string): Promise<string> {
    const vault = await this.getVault(spaceId);
    const path = this.vaultPath(spaceId);

    // ensureRepo also verifies git is available on its first git call; it does
    // `git init -b main` + an initial commit + the engine branches. Idempotent.
    await vault.ensureRepo();

    const configs: Array<[string, string]> = [
      ['receive.denyCurrentBranch', 'updateInstead'],
      ['receive.denyNonFastForwards', 'true'],
      ['http.receivepack', 'true'],
      ['http.uploadpack', 'true'],
    ];
    for (const [key, value] of configs) {
      await execFileAsync('git', ['config', key, value], {
        cwd: path,
        // Use the engine's cwd-isolated env (strips GIT_DIR / GIT_WORK_TREE) so
        // the config is written to THIS vault's local config, nothing else.
        env: vaultGitEnv(),
      });
    }

    return path;
  }
}
