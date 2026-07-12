import {
  IDLE_MAX_WAIT_USER,
  IDLE_MAX_WAIT_AGENT,
} from '../../../collaboration/constants';

/**
 * #395 — tunables for the work-time estimate (§10). Defaults are calibrated off
 * #374's idle-pulse ceilings: after #374 a continuous editing session leaves a
 * history row at least every ~IDLE_MAX_WAIT (10m user / 5m agent), so a gap
 * WIDER than that ceiling contains un-pulsed idle time = (partial) inactivity.
 * `tGap` therefore sits a little above the user ceiling, `agentTGap` a little
 * above the agent ceiling — a gap within the threshold is pulse-backed and
 * counts as work.
 */
export interface WorkTimeConfig {
  /** user inactivity timeout: gap ≤ tGap between samples = continuous work. */
  tGap: number;
  /** timeout for a pair of consecutive agent samples (tighter than tGap). */
  agentTGap: number;
  /** pre-roll padding for a multi-sample session (work began before sample 1). */
  pIn: number;
  /** post-roll padding for a multi-sample session (work continued after last). */
  pOut: number;
  /** block for a lone single-sample session (pre-roll only, no invented future). */
  pSingle: number;
  /** drop `git`-source samples (they are not human/agent article work). */
  excludeGit: boolean;
  /** optional cap on one collapsed agent-burst segment's wall-clock (§9#3). */
  burstCapMs?: number;
  /** samples whose createdAt round to the same bucket dedup to one (§9#7). */
  dedupRoundMs: number;
}

export const DEFAULT_WORK_TIME_CONFIG: WorkTimeConfig = {
  // ~15m: IDLE_MAX_WAIT_USER (10m) + headroom. Empirically backcast on a real
  // 307-snapshot article (≈24h at 15m matched the owner's estimate; 30/45m
  // over-counted). See #395 §10.
  tGap: 15 * 60 * 1000,
  // ~7m: IDLE_MAX_WAIT_AGENT (5m) + headroom.
  agentTGap: 7 * 60 * 1000,
  pIn: 5 * 60 * 1000,
  pOut: 5 * 60 * 1000,
  pSingle: 2 * 60 * 1000,
  excludeGit: true,
  burstCapMs: undefined,
  dedupRoundMs: 1000,
};

// Compile-time cross-check that the defaults really are pulse-anchored — if a
// future edit moves the #374 ceilings, this reminds us to re-calibrate.
void IDLE_MAX_WAIT_USER;
void IDLE_MAX_WAIT_AGENT;

/**
 * Fill a partial config with defaults and validate it. `tGap ≥ pIn + pOut` is
 * NOT required for the §6.3 per-day invariant (union takes care of that), but is
 * RECOMMENDED and enforced: otherwise the P-padding of adjacent sessions of
 * DIFFERENT classes could overlap and be counted into both metrics (§5, §10).
 */
export function resolveWorkTimeConfig(
  partial?: Partial<WorkTimeConfig>,
): WorkTimeConfig {
  const config = { ...DEFAULT_WORK_TIME_CONFIG, ...(partial ?? {}) };

  for (const key of [
    'tGap',
    'agentTGap',
    'pIn',
    'pOut',
    'pSingle',
    'dedupRoundMs',
  ] as const) {
    const value = config[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`work-time config: ${key} must be a non-negative number`);
    }
  }
  if (config.burstCapMs != null && config.burstCapMs <= 0) {
    throw new Error('work-time config: burstCapMs must be > 0 when set');
  }
  if (config.tGap < config.pIn + config.pOut) {
    throw new Error(
      'work-time config: tGap must be ≥ pIn + pOut so work/agent_only metrics cannot overlap',
    );
  }
  return config;
}
