// Unit tests for the per-space vault path resolver + lazy VaultGit cache
// `mkdir` and `VaultGit` are mocked so construction is cheap and
// no real filesystem / git work happens. We assert the path normalization
// (trailing slash) and the one-VaultGit-per-space caching contract.
import { mkdir } from 'node:fs/promises';
import { VaultGit } from '@docmost/git-sync';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
}));

// Cheap VaultGit stub: records the path it was constructed with; no shell-out.
jest.mock('@docmost/git-sync', () => ({
  VaultGit: jest.fn().mockImplementation((path: string) => ({ path })),
}));

import { VaultRegistryService } from './vault-registry.service';

type AnyMock = jest.Mock;

const mkdirMock = mkdir as unknown as AnyMock;
const VaultGitMock = VaultGit as unknown as AnyMock;

function build(dataDir: string): { service: VaultRegistryService } {
  const env = {
    getGitSyncDataDir: jest.fn(() => dataDir),
  };
  const service = new VaultRegistryService(env as any);
  return { service };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('VaultRegistryService', () => {
  describe('vaultPath', () => {
    it('normalizes a trailing slash in the data dir (no double slash)', () => {
      const { service } = build('/vaults/');
      expect(service.vaultPath('space-1')).toBe('/vaults/space-1');
    });

    it('works without a trailing slash too', () => {
      const { service } = build('/vaults');
      expect(service.vaultPath('space-1')).toBe('/vaults/space-1');
    });
  });

  describe('getVault lazy cache', () => {
    it('returns the SAME instance on a second call (one VaultGit per space)', async () => {
      const { service } = build('/vaults');

      const first = await service.getVault('space-1');
      const second = await service.getVault('space-1');

      // Same cached instance, constructed exactly once.
      expect(second).toBe(first);
      expect(VaultGitMock).toHaveBeenCalledTimes(1);
      expect(VaultGitMock).toHaveBeenCalledWith('/vaults/space-1');
      // mkdir is only run on the first (cache-miss) construction.
      expect(mkdirMock).toHaveBeenCalledTimes(1);
      expect(mkdirMock).toHaveBeenCalledWith('/vaults/space-1', {
        recursive: true,
      });
    });
  });
});
