import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/engine/settings';

// A minimal valid environment with every required variable set. Tests clone and
// mutate this object so process.env is never touched (hermetic).
const baseEnv = {
  DOCMOST_API_URL: 'https://docmost.example.com',
  DOCMOST_EMAIL: 'you@example.com',
  DOCMOST_PASSWORD: 'secret',
  DOCMOST_SPACE_ID: 'space-123',
} as NodeJS.ProcessEnv;

describe('parseSettings', () => {
  it('maps a full valid env to the camelCase Settings object', () => {
    const settings = parseSettings({
      ...baseEnv,
      VAULT_PATH: 'data/custom-vault',
      GIT_REMOTE: 'git@github.com:you/vault.git',
      POLL_INTERVAL_MS: '5000',
      DEBOUNCE_MS: '1000',
      LOG_LEVEL: 'debug',
    });

    expect(settings).toEqual({
      docmostApiUrl: 'https://docmost.example.com',
      docmostEmail: 'you@example.com',
      docmostPassword: 'secret',
      docmostSpaceId: 'space-123',
      vaultPath: 'data/custom-vault',
      gitRemote: 'git@github.com:you/vault.git',
      pollIntervalMs: 5000,
      debounceMs: 1000,
      logLevel: 'debug',
    });
  });

  it('applies defaults when optional vars are omitted', () => {
    const settings = parseSettings({ ...baseEnv });

    expect(settings.vaultPath).toBe('data/vault');
    expect(settings.pollIntervalMs).toBe(15000);
    expect(settings.debounceMs).toBe(2000);
    expect(settings.logLevel).toBe('info');
    expect(settings.gitRemote).toBeUndefined();
  });

  it('coerces numeric strings to numbers', () => {
    const settings = parseSettings({ ...baseEnv, POLL_INTERVAL_MS: '3000' });

    expect(settings.pollIntervalMs).toBe(3000);
    expect(typeof settings.pollIntervalMs).toBe('number');
  });

  it('throws when a required var is missing', () => {
    const { DOCMOST_API_URL: _omit, ...rest } = baseEnv;
    void _omit;
    expect(() => parseSettings(rest as NodeJS.ProcessEnv)).toThrow();
  });

  it('throws on an invalid LOG_LEVEL', () => {
    expect(() =>
      parseSettings({ ...baseEnv, LOG_LEVEL: 'verbose' }),
    ).toThrow();
  });

  it('throws on a non-numeric POLL_INTERVAL_MS', () => {
    expect(() =>
      parseSettings({ ...baseEnv, POLL_INTERVAL_MS: 'soon' }),
    ).toThrow();
  });

  it('treats an empty GIT_REMOTE as undefined', () => {
    const settings = parseSettings({ ...baseEnv, GIT_REMOTE: '' });
    expect(settings.gitRemote).toBeUndefined();
  });
});
