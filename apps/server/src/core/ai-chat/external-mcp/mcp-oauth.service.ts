import { randomBytes } from 'node:crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { Dispatcher } from 'undici';
import {
  auth,
  type OAuthClientProvider,
  type OAuthTokens,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthAuthorizationServerInformation,
} from '@ai-sdk/mcp';
import { AiMcpServer, AiMcpOauthGrant } from '@docmost/db/types/entity.types';
import { AiMcpOauthGrantRepo } from '@docmost/db/repos/ai-chat/ai-mcp-oauth-grant.repo';
import { SecretBoxService } from '../../../integrations/crypto/secret-box';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { mcpStreamTimeoutMs } from '../../../integrations/ai/ai-streaming-fetch';
import { buildPinnedDispatcher, guardedFetch } from './guarded-fetch';
import {
  McpGrantExpiredError,
  McpGrantUnavailableError,
} from './mcp-oauth.errors';

/** state TTL (R7): the browser round-trip window for a callback. */
const STATE_TTL_SECONDS = 600;
/** refresh skew (R7): refresh proactively this long before access expiry. */
const REFRESH_SKEW_MS = 60_000;
/** Hard wall-clock bound on the token-endpoint request. */
const REFRESH_TIMEOUT_MS = 10_000;
/** Redis key for a one-time authorization-flow state payload. */
const STATE_KEY_PREFIX = 'mcp-oauth:state:';

/** The one-time state payload persisted in Redis during the start flow. */
interface OauthStatePayload {
  userId: string;
  serverId: string;
  codeVerifier: string;
}

/** The DCR/discovery result accumulated by a start-flow provider. */
interface StartAccumulator {
  clientId?: string;
  clientSecret?: string | null;
  authorizationServer?: string;
  tokenEndpoint?: string;
  authorizationEndpoint?: string | null;
  authorizeUrl?: string;
  state?: string;
  codeVerifier?: string;
}

type GrantMode = 'start' | 'callback' | 'runtime';

/**
 * `OAuthClientProvider` over `ai_mcp_oauth_grants` (#687). Three modes:
 *
 *  - `start`   — discovery + DCR + startAuthorization. Provider methods
 *                ACCUMULATE the DCR/AS/verifier/authorize-URL in memory; the
 *                service persists them AFTER `auth()` returns (nothing is read
 *                back within the same `auth()` call, so no mid-flow DB write is
 *                needed). `redirectToAuthorization` captures the URL.
 *  - `callback`— code exchange. Provider READS client info / AS info from the
 *                loaded grant and the code_verifier from the gashed Redis state;
 *                `saveTokens` persists the exchanged tokens (UPDATE-only).
 *  - `runtime` — per-request bearer. `tokens()` NEVER returns `refresh_token`
 *                (so the SDK never runs ITS own refresh); on access expiry it
 *                refreshes under the service's process-global single-flight and
 *                returns access-only. `redirectToAuthorization` is a NO-OP
 *                (a runtime REDIRECT must not change grant status).
 */
export class GrantAuthProvider implements OAuthClientProvider {
  /** Start-flow accumulators, read by the service after `auth()` returns. */
  readonly acc: StartAccumulator = {};

  constructor(
    private readonly svc: McpOauthService,
    private readonly mode: GrantMode,
    private readonly server: Pick<AiMcpServer, 'id' | 'workspaceId' | 'url'>,
    private readonly redirectUri: string,
    // callback-mode context: the loaded grant + the code_verifier from state.
    private readonly grant?: AiMcpOauthGrant,
    private readonly codeVerifierFromState?: string,
  ) {}

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUri],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Gitmost',
    };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.mode !== 'runtime') return undefined;
    // Ensure a fresh access token (proactive refresh under single-flight). On a
    // classified failure this THROWS our typed error, which the connect gate
    // maps to the precise outcome. NEVER return the refresh_token to the SDK.
    const accessToken = await this.svc.ensureAccessToken(this.server);
    if (!accessToken) return undefined;
    return { access_token: accessToken, token_type: 'Bearer' };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // UPDATE-only: if the grant was disconnected mid-flow, 0 rows -> no resurrect.
    await this.svc.saveExchangedTokens(this.server.id, tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.mode !== 'start') return; // runtime: NEVER change status
    this.acc.authorizeUrl = authorizationUrl.href;
    this.acc.authorizationEndpoint = `${authorizationUrl.origin}${authorizationUrl.pathname}`;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (this.mode !== 'start') return; // no-op outside the start flow
    this.acc.codeVerifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    // Only reached on the code-exchange (callback) path.
    return this.codeVerifierFromState ?? this.acc.codeVerifier ?? '';
  }

  invalidateCredentials(): void {
    // Does NOT erase tokens (spec): the next runtime tokens() re-reads the grant
    // from the DB anyway (we never cache tokens in the provider), so this is a
    // no-op by construction. Kept so the SDK's InvalidGrant retry has a hook.
  }

  clientInformation(): OAuthClientInformation | undefined {
    if (this.mode === 'start') return undefined; // force DCR
    if (!this.grant) return undefined;
    return {
      client_id: this.grant.clientId,
      client_secret: this.grant.clientSecretEnc
        ? this.svc.decrypt(this.grant.clientSecretEnc)
        : undefined,
    };
  }

  saveClientInformation(info: OAuthClientInformation): void {
    if (this.mode !== 'start') return;
    this.acc.clientId = info.client_id;
    this.acc.clientSecret = info.client_secret ?? null;
  }

  authorizationServerInformation():
    | OAuthAuthorizationServerInformation
    | undefined {
    if (this.mode === 'start') return undefined;
    if (!this.grant) return undefined;
    return {
      authorizationServerUrl: this.grant.authorizationServer,
      tokenEndpoint: this.grant.tokenEndpoint,
    };
  }

  saveAuthorizationServerInformation(
    info: OAuthAuthorizationServerInformation,
  ): void {
    if (this.mode !== 'start') return;
    this.acc.authorizationServer = info.authorizationServerUrl;
    this.acc.tokenEndpoint = info.tokenEndpoint;
  }

  state(): string {
    // The SDK only puts `state` in the authorize URL if the provider returns one.
    const s = randomBytes(24).toString('base64url');
    this.acc.state = s;
    return s;
  }

  saveState(state: string): void {
    if (this.mode !== 'start') return;
    this.acc.state = state;
  }
}

/**
 * OAuth 2.1 flow + runtime token service for personal MCP servers (#687).
 *
 * Owns: the Redis one-time state store, the grant persistence, and the
 * process-global single-flight refresh (keyed by `server_id`) so concurrent
 * tool-calls / turns of the SAME grant collapse to ONE token-endpoint request.
 * Its SSRF-pinned `guardedFetch` is used for discovery/DCR/exchange (start +
 * callback, where `auth()` runs OUTSIDE the transport) AND for our own refresh.
 */
@Injectable()
export class McpOauthService {
  private readonly logger = new Logger(McpOauthService.name);
  private readonly redis: Redis;
  private readonly dispatcher: Dispatcher = buildPinnedDispatcher(
    mcpStreamTimeoutMs(),
  );
  // The SSRF-pinned fetch used for discovery/DCR/exchange (start + callback) AND
  // our own refresh. NOT `readonly` only so a test can inject a stub in place of
  // the real network (the SSRF pinning is exercised by guarded-fetch's own spec).
  private fetchFn: typeof fetch = (input, init) =>
    guardedFetch(this.dispatcher, input, init);
  /** Process-global single-flight for refresh, keyed by server_id. */
  private readonly refreshInFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly redisService: RedisService,
    private readonly grantRepo: AiMcpOauthGrantRepo,
    private readonly secretBox: SecretBoxService,
    private readonly env: EnvironmentService,
  ) {
    this.redis = this.redisService.getOrThrow();
  }

  /** The gitmost OAuth callback URL registered via DCR and used at exchange. */
  private redirectUri(): string {
    return `${this.env.getAppUrl()}/api/mcp-oauth/callback`;
  }

  decrypt(blob: string): string {
    return this.secretBox.decryptSecret(blob);
  }

  /** Grant status for the connect gate; 'none' when there is no grant row. */
  async getGrantStatus(
    serverId: string,
  ): Promise<'none' | 'pending' | 'connected' | 'expired' | 'error'> {
    const grant = await this.grantRepo.findByServerId(serverId);
    if (!grant) return 'none';
    return grant.status as
      | 'pending'
      | 'connected'
      | 'expired'
      | 'error';
  }

  /** A runtime `OAuthClientProvider` for a connected OAuth server. */
  createRuntimeProvider(
    server: Pick<AiMcpServer, 'id' | 'workspaceId' | 'url'>,
  ): GrantAuthProvider {
    return new GrantAuthProvider(this, 'runtime', server, this.redirectUri());
  }

  // --- Start flow ------------------------------------------------------------

  /**
   * Begin authorization for a personal OAuth server: discovery + DCR via the
   * SDK's `auth()` (with our SSRF-pinned fetch), then persist the DCR/AS data +
   * the Redis one-time state, and return the authorize URL for the browser.
   *
   * Redis down => 503 with the real cause; the grant is not written (we write
   * the state FIRST, so a Redis failure leaves the DB untouched).
   */
  async startAuthorization(
    userId: string,
    server: Pick<AiMcpServer, 'id' | 'workspaceId' | 'url'>,
  ): Promise<{ authorizeUrl: string }> {
    const provider = new GrantAuthProvider(
      this,
      'start',
      server,
      this.redirectUri(),
    );

    // No authorization code -> discovery + DCR + startAuthorization -> REDIRECT.
    const result = await auth(provider, {
      serverUrl: server.url,
      fetchFn: this.fetchFn,
    });

    const acc = provider.acc;
    if (
      result !== 'REDIRECT' ||
      !acc.authorizeUrl ||
      !acc.clientId ||
      !acc.authorizationServer ||
      !acc.tokenEndpoint ||
      !acc.state ||
      !acc.codeVerifier
    ) {
      throw new Error(
        'OAuth authorization could not be started (discovery/DCR did not complete)',
      );
    }

    // Persist the one-time state FIRST (fresh random key => SET NX always wins).
    // A Redis failure here throws BEFORE any DB write -> a clean 503.
    const payload: OauthStatePayload = {
      userId,
      serverId: server.id,
      codeVerifier: acc.codeVerifier,
    };
    try {
      await this.redis.set(
        STATE_KEY_PREFIX + acc.state,
        JSON.stringify(payload),
        'EX',
        STATE_TTL_SECONDS,
        'NX',
      );
    } catch (err) {
      this.logError('OAuth start: Redis state write failed', err);
      throw new ServiceUnavailableException(
        `Could not start authorization (state store unavailable): ${describeErr(err)}`,
      );
    }

    // Then persist the grant as pending with the DCR/AS pins.
    await this.grantRepo.upsertStart({
      serverId: server.id,
      clientId: acc.clientId,
      clientSecretEnc:
        acc.clientSecret != null && acc.clientSecret.length > 0
          ? this.secretBox.encryptSecret(acc.clientSecret)
          : null,
      authorizationServer: acc.authorizationServer,
      authorizationEndpoint: acc.authorizationEndpoint ?? null,
      tokenEndpoint: acc.tokenEndpoint,
    });

    return { authorizeUrl: acc.authorizeUrl };
  }

  // --- Callback flow ---------------------------------------------------------

  /**
   * One-time gash the Redis state (atomic MULTI get+del). Returns the payload,
   * or null when the key is absent (replay / expired). Throws (propagates) on a
   * Redis connection error so the caller can distinguish "down" (redirect error,
   * no state transition) from "replayed" (400).
   */
  async consumeState(rawState: string): Promise<OauthStatePayload | null> {
    const key = STATE_KEY_PREFIX + rawState;
    const res = await this.redis.multi().get(key).del(key).exec();
    // ioredis MULTI throws on a connection error; a successful exec returns
    // [[err, value], [err, delCount]].
    const raw = res?.[0]?.[1] as string | null | undefined;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as OauthStatePayload;
      if (
        parsed &&
        typeof parsed.userId === 'string' &&
        typeof parsed.serverId === 'string' &&
        typeof parsed.codeVerifier === 'string'
      ) {
        return parsed;
      }
    } catch {
      // fall through
    }
    return null;
  }

  /**
   * Exchange the authorization code for tokens against the pinned AS and mark the
   * grant connected. The caller has ALREADY verified state ownership + row
   * ownership (anti-grant-fixation). Returns 'connected' on success or 'error'
   * (with the grant moved to `error` + detail) on exchange failure.
   */
  async completeCallback(
    server: Pick<AiMcpServer, 'id' | 'workspaceId' | 'url'>,
    code: string,
    callbackState: string,
    codeVerifier: string,
  ): Promise<'connected' | 'error'> {
    const grant = await this.grantRepo.findByServerId(server.id);
    if (!grant) {
      // Disconnected between start and callback: nothing to write.
      return 'error';
    }
    const provider = new GrantAuthProvider(
      this,
      'callback',
      server,
      this.redirectUri(),
      grant,
      codeVerifier,
    );
    try {
      const result = await auth(provider, {
        serverUrl: server.url,
        authorizationCode: code,
        callbackState,
        fetchFn: this.fetchFn,
      });
      if (result !== 'AUTHORIZED') {
        await this.grantRepo.markStatus(
          server.id,
          'error',
          'authorization did not complete',
        );
        return 'error';
      }
      // saveTokens (called inside auth) already persisted the tokens; now flip
      // to connected.
      await this.grantRepo.markStatus(server.id, 'connected', null);
      return 'connected';
    } catch (err) {
      this.logError(
        `OAuth callback exchange failed for server ${server.id}`,
        err,
      );
      await this.grantRepo.markStatus(
        server.id,
        'error',
        `authorization failed: ${describeErr(err)}`,
      );
      return 'error';
    }
  }

  /** Record an explicit consent error (e.g. access_denied) on the grant. */
  async markCallbackError(serverId: string, detail: string): Promise<void> {
    await this.grantRepo.markStatus(serverId, 'error', detail.slice(0, 500));
  }

  /** Disconnect: delete the grant row (status -> 'none'). */
  async disconnect(serverId: string): Promise<void> {
    await this.grantRepo.delete(serverId);
  }

  /** Reset the grant on a url/transport change (R1): grant -> none. */
  async resetGrant(serverId: string): Promise<void> {
    await this.grantRepo.delete(serverId);
  }

  // --- Runtime token path ----------------------------------------------------

  /**
   * The exchanged/rotated tokens persist (called by the provider's saveTokens
   * during code exchange). UPDATE-only: 0 rows => grant deleted mid-flow, do NOT
   * resurrect it.
   */
  async saveExchangedTokens(
    serverId: string,
    tokens: OAuthTokens,
  ): Promise<void> {
    await this.grantRepo.updateTokens(serverId, {
      accessTokenEnc: this.secretBox.encryptSecret(tokens.access_token),
      refreshTokenEnc: tokens.refresh_token
        ? this.secretBox.encryptSecret(tokens.refresh_token)
        : null,
      expiresAt: expiryFromExpiresIn(tokens.expires_in),
    });
  }

  /**
   * Return a fresh access token for a connected grant, refreshing proactively
   * (60s skew) under a process-global single-flight keyed by server_id. Two
   * concurrent callers (two tool-calls, or two turns of the same grant via
   * different transport instances) share ONE token-endpoint request.
   *
   * Throws {@link McpGrantExpiredError} on invalid_grant/invalid_client and
   * {@link McpGrantUnavailableError} on a transient failure — the connect gate
   * maps these to `auth-expired` / `auth-unavailable`.
   */
  async ensureAccessToken(
    server: Pick<AiMcpServer, 'id' | 'workspaceId'>,
  ): Promise<string> {
    const grant = await this.grantRepo.findByServerId(server.id);
    if (!grant || !grant.accessTokenEnc) {
      throw new McpGrantUnavailableError(server.id, server.workspaceId);
    }
    if (!isExpiring(grant.expiresAt)) {
      return this.secretBox.decryptSecret(grant.accessTokenEnc);
    }
    // Refresh needed. Collapse concurrent refreshers onto ONE in-flight promise.
    let inflight = this.refreshInFlight.get(server.id);
    if (!inflight) {
      inflight = this.doRefresh(server).finally(() =>
        this.refreshInFlight.delete(server.id),
      );
      this.refreshInFlight.set(server.id, inflight);
    }
    return inflight;
  }

  /** The single-flight refresh body (see ensureAccessToken). */
  private async doRefresh(
    server: Pick<AiMcpServer, 'id' | 'workspaceId'>,
  ): Promise<string> {
    const grant = await this.grantRepo.findByServerId(server.id);
    if (!grant || !grant.refreshTokenEnc) {
      throw new McpGrantUnavailableError(server.id, server.workspaceId);
    }
    let refreshToken: string;
    try {
      refreshToken = this.secretBox.decryptSecret(grant.refreshTokenEnc);
    } catch (err) {
      // APP_SECRET rotated etc. — transient from the user's view; do not force
      // a re-consent, skip this turn.
      this.warnGrant(
        server,
        'refresh token undecryptable (APP_SECRET rotated?)',
      );
      throw new McpGrantUnavailableError(server.id, server.workspaceId);
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: grant.clientId,
    });
    if (grant.clientSecretEnc) {
      body.set('client_secret', this.secretBox.decryptSecret(grant.clientSecretEnc));
    }

    let resp: Response;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('refresh timed out')),
      REFRESH_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      resp = await this.fetchFn(grant.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      // Network / timeout / SSRF-block: grant STAYS connected, skip this turn.
      this.warnGrant(server, `refresh network error: ${describeErr(err)}`);
      throw new McpGrantUnavailableError(server.id, server.workspaceId);
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 500) {
      this.warnGrant(server, `refresh got AS ${resp.status}`);
      throw new McpGrantUnavailableError(server.id, server.workspaceId);
    }

    let json: Record<string, unknown> | undefined;
    try {
      json = (await resp.json()) as Record<string, unknown>;
    } catch {
      this.warnGrant(server, 'refresh response was not JSON');
      throw new McpGrantUnavailableError(server.id, server.workspaceId);
    }

    if (!resp.ok) {
      const code = typeof json?.error === 'string' ? json.error : undefined;
      if (code === 'invalid_grant' || code === 'invalid_client') {
        // The refresh token is dead -> re-authorization required.
        await this.grantRepo.markStatus(
          server.id,
          'expired',
          `refresh rejected: ${code}`,
        );
        this.warnGrant(server, `refresh rejected (${code}) -> expired`);
        throw new McpGrantExpiredError(server.id, server.workspaceId);
      }
      // Any other 4xx: treat as transient (do NOT nuke the grant).
      this.warnGrant(
        server,
        `refresh failed (${resp.status} ${code ?? 'unknown'})`,
      );
      throw new McpGrantUnavailableError(server.id, server.workspaceId);
    }

    const accessToken =
      typeof json?.access_token === 'string' ? json.access_token : undefined;
    if (!accessToken) {
      this.warnGrant(server, 'refresh response missing access_token');
      throw new McpGrantUnavailableError(server.id, server.workspaceId);
    }
    // fastmcp rotates the refresh token (one-time use); keep the old one only if
    // the response omitted a new one. #699 LOW: an EMPTY string is a string but
    // NOT a usable token — persisting `''` would make the next turn's refresh
    // fail with invalid_grant and force a spurious re-consent. Treat empty like
    // absent and keep the live refresh token (mirrors the access_token guard).
    const rotated = json?.refresh_token;
    const newRefresh =
      typeof rotated === 'string' && rotated.length > 0 ? rotated : refreshToken;
    const expiresAt =
      typeof json?.expires_in === 'number'
        ? expiryFromExpiresIn(json.expires_in)
        : null;

    // Persist the rotation (UPDATE-only). If the grant was deleted mid-refresh
    // (Disconnect), 0 rows are affected and we do NOT resurrect it — but we
    // still return this access token for the in-flight request.
    await this.grantRepo.updateTokens(server.id, {
      accessTokenEnc: this.secretBox.encryptSecret(accessToken),
      refreshTokenEnc: this.secretBox.encryptSecret(newRefresh),
      expiresAt,
    });
    return accessToken;
  }

  private warnGrant(
    server: Pick<AiMcpServer, 'id' | 'workspaceId'>,
    message: string,
  ): void {
    // Greppable operator line with ids only — NEVER a token or code_verifier.
    this.logger.warn(
      `external MCP OAuth (server ${server.id}, workspace ${server.workspaceId}): ${message}`,
    );
  }

  private logError(context: string, err: unknown): void {
    const e = err as {
      name?: string;
      message?: string;
      stack?: string;
      cause?: unknown;
    };
    this.logger.error(
      `${context}: ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`,
      e?.stack,
    );
  }
}

/** Whether access expires within the skew window (or its expiry is unknown). */
function isExpiring(expiresAt: unknown): boolean {
  if (expiresAt == null) return true;
  const t = new Date(expiresAt as string | Date).getTime();
  if (Number.isNaN(t)) return true;
  return t - REFRESH_SKEW_MS <= Date.now();
}

/** Absolute expiry from an `expires_in` (seconds), or null when absent. */
function expiryFromExpiresIn(expiresIn: unknown): Date | null {
  return typeof expiresIn === 'number' && Number.isFinite(expiresIn)
    ? new Date(Date.now() + expiresIn * 1000)
    : null;
}

/** Short, non-sensitive error description (message head only). */
function describeErr(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const head = (message || 'unknown error').split('\n')[0];
  return head.length > 200 ? `${head.slice(0, 200)}…` : head;
}
