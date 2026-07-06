import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import {
  AiChat,
  AiChatMessage,
  AiChatRun,
  User,
  Workspace,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import { AI_CHAT_THROTTLER } from '../../integrations/throttle/throttler-names';
import { FileInterceptor } from '../../common/interceptors/file.interceptor';
import {
  AiChatRunHooks,
  AiChatService,
  AiChatStreamBody,
} from './ai-chat.service';
import { AiChatRunService } from './ai-chat-run.service';
import { AiTranscriptionService } from './ai-transcription.service';
import {
  BoundChatDto,
  ChatIdDto,
  ExportChatDto,
  GeneratePageTitleDto,
  GetChatMessagesDto,
  GetRunDto,
  RenameChatDto,
  StopRunDto,
} from './dto/ai-chat.dto';
import { describeProviderError } from '../../integrations/ai/ai-error.util';
import { buildChatMarkdown } from './chat-markdown.util';
import {
  AiChatStreamRegistryService,
  SUBSCRIBER_MAX_BUFFERED_BYTES,
} from './ai-chat-stream-registry.service';
import { startSseHeartbeat } from './sse-resilience';
import { EnvironmentService } from '../../integrations/environment/environment.service';

/**
 * Per-user AI chat API (§6.1). Routes are POST to match this codebase's
 * convention (it uses POST for reads too). Everything is workspace-scoped and
 * limited to chats the requesting user created.
 */
@UseGuards(JwtAuthGuard)
@Controller('ai-chat')
export class AiChatController {
  private readonly logger = new Logger(AiChatController.name);

  constructor(
    private readonly aiChatService: AiChatService,
    private readonly aiChatRunService: AiChatRunService,
    private readonly aiChatRepo: AiChatRepo,
    private readonly aiChatMessageRepo: AiChatMessageRepo,
    private readonly aiTranscription: AiTranscriptionService,
    private readonly pageRepo: PageRepo,
    // #184 phase 1.5. OPTIONAL so existing positional constructions (controller
    // specs) compile unchanged; Nest always injects the real providers in
    // production. Only touched on the resumable-stream (flag-on) path.
    private readonly streamRegistry?: AiChatStreamRegistryService,
    private readonly environment?: EnvironmentService,
  ) {}

  /** List the requesting user's chats in this workspace (paginated). */
  @HttpCode(HttpStatus.OK)
  @Post('chats')
  async listChats(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatRepo.findByCreator(user.id, workspace.id, pagination);
  }

  /**
   * Resolve the chat bound to a document for the requesting user: the most-recent
   * non-deleted chat created on that page (ai_chats.page_id). Returns
   * { chatId: null } when the page has no owned chat (-> a fresh chat).
   *
   * `dto.pageId` carries EITHER a page slugId (10-char nanoid, sent by the client
   * off a slug URL) OR a page uuid, so it must be resolved to a real page uuid
   * before it touches the uuid ai_chats.page_id column — passing a slugId straight
   * through triggered a Postgres 22P02 "invalid input syntax for type uuid" 500
   * (#312). PageRepo.findById accepts both forms. The workspace guard rejects an
   * unknown or cross-workspace page (-> { chatId: null }) so a foreign id cannot
   * probe another workspace's chats. Only the caller's OWN chats are then matched.
   */
  @HttpCode(HttpStatus.OK)
  @Post('bound-chat')
  async boundChat(
    @Body() dto: BoundChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ chatId: string | null }> {
    const page = await this.pageRepo.findById(dto.pageId); // accepts slugId OR uuid
    if (!page || page.workspaceId !== workspace.id) {
      return { chatId: null }; // unknown or foreign-workspace page — no binding, no leak
    }
    const chat = await this.aiChatRepo.findLatestByPage(
      user.id,
      workspace.id,
      page.id, // the real uuid, never the incoming slugId
    );
    return { chatId: chat?.id ?? null };
  }

  /** Fetch the messages of a chat (oldest first, paginated). */
  @HttpCode(HttpStatus.OK)
  @Post('messages')
  async getMessages(
    @Body() dto: GetChatMessagesDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    return this.aiChatMessageRepo.findByChat(
      dto.chatId,
      workspace.id,
      pagination,
    );
  }

  /**
   * Export a chat to Markdown (#183). The DB is the single source of truth: the
   * whole transcript is loaded (oldest -> newest) and rendered server-side. Now
   * that the assistant row is persisted upfront and per step, an interrupted
   * turn is included up to its last finished step. Workspace-scoped and owner-
   * gated via assertOwnedChat (same as the other read endpoints). Returns
   * `{ markdown }`. `lang` localizes the few fixed labels (default English).
   */
  @HttpCode(HttpStatus.OK)
  @Post('export')
  async export(
    @Body() dto: ExportChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ markdown: string }> {
    const chat = await this.assertOwnedChat(dto.chatId, user, workspace);
    const rows = await this.aiChatMessageRepo.findAllByChat(
      dto.chatId,
      workspace.id,
    );
    const markdown = buildChatMarkdown({
      title: chat.title ?? null,
      chatId: dto.chatId,
      rows,
      // normalizeLang(undefined) already yields 'en', so no `?? 'en'` is needed.
      lang: dto.lang,
    });
    return { markdown };
  }

  /**
   * Reconnect to the latest run of a chat (#184 phase 1). Returns the run's
   * persisted lifecycle state ({ status, error, stepCount, timings, ... }) plus
   * the assistant message it projects (the partial/final output) — the DB is the
   * source of truth, so this works for an in-flight run (the browser dropped, the
   * run kept going) and a finished one alike. Owner-gated via assertOwnedChat.
   * `{ run: null }` when the chat has never had a run.
   */
  @HttpCode(HttpStatus.OK)
  @Post('run')
  async getRun(
    @Body() dto: GetRunDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ run: AiChatRun | null; message: AiChatMessage | null }> {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    const run = await this.aiChatRunService.getLatestForChat(
      dto.chatId,
      workspace.id,
    );
    if (!run) return { run: null, message: null };
    const message = run.assistantMessageId
      ? await this.aiChatMessageRepo.findById(
          run.assistantMessageId,
          workspace.id,
        )
      : undefined;
    return { run, message: message ?? null };
  }

  /**
   * Explicitly STOP an agent run (#184 phase 1) — the user pressed Stop. This is
   * the ONLY thing that ends a detached run; a browser disconnect deliberately
   * does not. Target by `runId` (from the streamed start metadata) or by `chatId`
   * (stop whatever run is active on it). Owner-gated. Returns
   * `{ stopped }` — false when there was nothing active to stop.
   */
  @HttpCode(HttpStatus.OK)
  @Post('stop')
  async stopRun(
    @Body() dto: StopRunDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ stopped: boolean }> {
    let runId = dto.runId;
    if (!runId && !dto.chatId) {
      throw new BadRequestException('runId or chatId is required');
    }
    if (runId) {
      // Resolve the run to its chat and owner-gate via that chat.
      const run = await this.aiChatRunService.getRun(runId, workspace.id);
      if (!run) return { stopped: false };
      await this.assertOwnedChat(run.chatId, user, workspace);
    } else {
      await this.assertOwnedChat(dto.chatId!, user, workspace);
      const active = await this.aiChatRunService.getActiveForChat(
        dto.chatId!,
        workspace.id,
      );
      if (!active) return { stopped: false };
      runId = active.id;
    }
    const stopped = await this.aiChatRunService.requestStop(
      runId,
      workspace.id,
    );
    return { stopped };
  }

  /**
   * Attach to a chat's live run stream (#184 phase 1.5). A late/reloaded tab
   * replays the frames buffered so far and then follows the live tail as a normal
   * streamer. Owner-gated via assertOwnedChat (same gate as getRun). When there is
   * nothing to resume — no entry, a finished run without expect=live, an
   * overflowed buffer, or an anchor that pins a DIFFERENT run — the endpoint
   * answers 204, the ONLY "nothing to resume" signal the AI SDK's reconnect
   * accepts (it maps 204 to a silent no-op). With AI_CHAT_RESUMABLE_STREAM off the
   * registry is never populated, so attach always 204s.
   *
   * `expect=live` opts into replaying a finished-but-retained run (safe only when
   * the client stripped the streaming tail); `anchor` is the client's assistant
   * row id, which must match this run's (invariant 6) or a foreign run's
   * transcript would be replayed into the store.
   */
  @SkipTransform()
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AI_CHAT_THROTTLER]: { limit: 60, ttl: 60000 } })
  @Get('runs/:chatId/stream')
  async attachRunStream(
    @Param('chatId', new ParseUUIDPipe()) chatId: string,
    @Query('expect') expect: string | undefined,
    @Query('anchor') anchor: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    await this.assertOwnedChat(chatId, user, workspace); // same gate as getRun
    let stopHeartbeat: () => void = () => undefined;
    const attachment = await this.streamRegistry?.attach(
      chatId,
      expect === 'live',
      anchor,
      {
        onFrame: (frame) => {
          // Backpressure guard: 2x the replay cap, so the initial replay burst
          // alone can never trip it; only a genuinely stalled socket can.
          try {
            if (res.raw.writableLength > SUBSCRIBER_MAX_BUFFERED_BYTES) {
              res.raw.destroy(); // 'close' fires -> unsubscribe below
              return;
            }
            if (!res.raw.writableEnded) res.raw.write(frame);
          } catch {
            res.raw.destroy();
          }
        },
        onEnd: () => {
          stopHeartbeat();
          if (!res.raw.writableEnded) res.raw.end();
        },
      },
    );
    if (!attachment) {
      res.status(204).send(); // the ONLY "nothing to resume" signal the SDK accepts
      return;
    }
    res.hijack();
    // Cleanup BEFORE any write (invariant 5): a torn-down socket must not orphan
    // a paused subscriber whose pending queue would buffer the whole run.
    req.raw.once('close', () => {
      attachment.unsubscribe();
      stopHeartbeat();
    });
    // A close emitted DURING the awaits above was missed by the listener — check.
    // (Healthy pending GETs have req.raw.destroyed === false, so no false
    // positives; returning without end() is fine — the socket is gone.)
    if (req.raw.destroyed) {
      attachment.unsubscribe();
      return;
    }
    res.raw.on('error', () => undefined);
    try {
      res.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-vercel-ai-ui-message-stream': 'v1',
        'x-accel-buffering': 'no',
        // deliberately NO Connection/Keep-Alive (hop-by-hop; Safari/HTTP2)
      });
      res.raw.flushHeaders?.();
      for (const frame of attachment.replay) res.raw.write(frame);
      if (attachment.finished) {
        res.raw.end();
        return;
      }
      stopHeartbeat = startSseHeartbeat(res.raw, 15_000);
      attachment.start(); // drain pending accumulated during replay, go live
    } catch {
      attachment.unsubscribe();
      stopHeartbeat();
      res.raw.destroy();
    }
  }

  /** Rename a chat. */
  @HttpCode(HttpStatus.OK)
  @Post('rename')
  async rename(
    @Body() dto: RenameChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    await this.aiChatRepo.update(
      dto.chatId,
      { title: dto.title },
      workspace.id,
    );
    return { success: true };
  }

  /** Soft-delete a chat. */
  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(
    @Body() dto: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertOwnedChat(dto.chatId, user, workspace);
    await this.aiChatRepo.softDelete(dto.chatId, workspace.id);
    return { success: true };
  }

  /**
   * Stream an agent turn. The useChat payload is read straight off `req.body`
   * (binding a strict DTO would let the global ValidationPipe whitelist strip
   * useChat fields).
   *
   * Ordering matters: feature gating (A7) and model resolution happen BEFORE
   * `res.hijack()`, so a disabled feature (403) or an unconfigured provider
   * (503) returns clean JSON. Only once we are committed to streaming do we
   * hijack and hand off to the service.
   */
  @SkipTransform()
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AI_CHAT_THROTTLER]: { limit: 25, ttl: 60000 } })
  @Post('stream')
  async stream(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    // A7 gate: the workspace must have AI chat explicitly enabled.
    const settings = (workspace.settings ?? {}) as {
      ai?: { chat?: boolean; autonomousRuns?: boolean };
    };
    if (settings.ai?.chat !== true) {
      throw new ForbiddenException('AI chat is disabled');
    }

    // #184 phase 1 flag: when ON, the turn becomes a detached, durable RUN — its
    // lifecycle is tracked in ai_chat_runs, a browser disconnect no longer aborts
    // it, and only an explicit /ai-chat/stop ends it. When OFF (the default) the
    // turn is socket-bound exactly as before, so existing deployments are
    // unaffected.
    const autonomousRuns = settings.ai?.autonomousRuns === true;

    const sessionId = (req.raw as { sessionId?: string }).sessionId;
    if (!sessionId) {
      // The chat requires an interactive session to mint loopback tokens
      // (§15[C1]); Bearer/API-key requests without a session are rejected.
      throw new ForbiddenException('AI chat requires an interactive session');
    }

    const body = (req.body ?? {}) as AiChatStreamBody;

    // Resolve the agent role for this turn BEFORE hijack: existing chats read it
    // from ai_chats.role_id (authoritative), a new chat from body.roleId. The
    // role drives both the persona and the optional model override below.
    const role = await this.aiChatService.resolveRoleForRequest(
      workspace,
      body,
    );

    // Resolve the model (applying the role's optional override) BEFORE hijack so
    // an unconfigured provider — including a role pointing at an unconfigured
    // driver — returns a clean JSON 503 (AiNotConfiguredException is a 503
    // HttpException) instead of breaking mid-stream.
    const model = await this.aiChatService.getChatModel(workspace.id, role);

    // #184: one active run per chat. For an EXISTING chat reject a concurrent
    // start with a clean 409 BEFORE hijack (the common double-submit / second-tab
    // case), so the user gets JSON, not a mid-stream error. A brand-new chat
    // (no chatId) cannot have a prior run, and the DB partial unique index is the
    // backstop against any race that slips past this check.
    if (autonomousRuns && body.chatId) {
      const active = await this.aiChatRunService.getActiveForChat(
        body.chatId,
        workspace.id,
      );
      if (active) {
        throw new ConflictException({
          message: 'An agent run is already in progress for this chat',
          code: 'A_RUN_ALREADY_ACTIVE',
        });
      }
    }

    // Run-lifecycle hooks (#184), only when the flag is on. They wrap the turn in
    // a durable run whose abort is governed by the run (explicit stop), persist
    // its progress, and settle its terminal status — see AiChatRunService.
    const runHooks: AiChatRunHooks | undefined = autonomousRuns
      ? {
          begin: async (chatId) => {
            const handle = await this.aiChatRunService.beginRun({
              chatId,
              workspaceId: workspace.id,
              userId: user.id,
              trigger: 'user',
            });
            // #184 phase 1.5: register the run-stream entry at BEGIN (before any
            // frame) so a tab that attaches in the begin->seed window finds an
            // entry to wait on. Gated on AI_CHAT_RESUMABLE_STREAM: with the flag
            // off nothing is registered and attach always 204s.
            if (
              handle?.runId &&
              this.environment?.isAiChatResumableStreamEnabled?.()
            ) {
              this.streamRegistry?.open(chatId, handle.runId);
            }
            return handle;
          },
          onAssistantSeeded: (runId, messageId) =>
            this.aiChatRunService.linkAssistantMessage(
              runId,
              workspace.id,
              messageId,
            ),
          onStep: (runId, stepCount) =>
            void this.aiChatRunService.recordStep(
              runId,
              workspace.id,
              stepCount,
            ),
          onSettled: (runId, status, error) =>
            this.aiChatRunService.finalizeRun(
              runId,
              workspace.id,
              status,
              error,
            ),
        }
      : undefined;

    // Abort the agent loop when the client disconnects. `close` also fires on
    // normal completion, so only abort when the response has not finished
    // writing (a genuine disconnect). `once` fires at most once and self-removes;
    // we also drop it on response `finish` so it never lingers after the stream
    // completes normally (the AI SDK pipes the response fire-and-forget, so we
    // cannot simply remove it once `stream()` returns).
    // DIAGNOSTIC (Safari stream-drop investigation) — temporary: wall-clock at
    // which a Safari disconnect is observed, measured from request receipt.
    const reqStartedAt = Date.now();
    const controller = new AbortController();
    const onClose = (): void => {
      // A genuine disconnect leaves the response unfinished (unlike a normal
      // completion, which also fires `close`). Such a drop — e.g. a reverse
      // proxy cutting the SSE mid-answer — is otherwise invisible server-side,
      // so log it here.
      if (!res.raw.writableEnded) {
        if (autonomousRuns) {
          // #184: the turn is a DETACHED run. A disconnect must NOT abort it —
          // the run keeps executing and persisting server-side; the client
          // reconnects via /ai-chat/run (or re-stops via /ai-chat/stop). Log only.
          this.logger.log(
            `AI chat stream: client disconnected; run continues server-side ` +
              `(elapsed=${Date.now() - reqStartedAt}ms since request received)`,
          );
        } else {
          this.logger.warn(
            `AI chat stream: client disconnected before completion; aborting turn ` +
              `(elapsed=${Date.now() - reqStartedAt}ms since request received)`,
          );
          controller.abort();
        }
      }
    };
    req.raw.once('close', onClose);
    res.raw.once('finish', () => req.raw.off('close', onClose));

    // #184: in detached mode the turn is NOT aborted on disconnect, so the SDK's
    // pipe keeps writing to a socket the client may have dropped — for the rest of
    // the (continuing) run. A write to the dead socket can emit an 'error' on the
    // raw response; without a listener that surfaces as an unhandled error event.
    // Swallow it (the run continues server-side regardless). Legacy mode aborts on
    // disconnect, so it does not need this and keeps its exact prior behavior.
    if (autonomousRuns) {
      res.raw.on('error', (err) => {
        this.logger.debug(
          `AI chat detached stream: post-disconnect socket error swallowed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    // Commit to streaming: hijack so Fastify stops managing the response and
    // the AI SDK can write the UI-message stream directly to the Node socket.
    res.hijack();

    try {
      await this.aiChatService.stream({
        user,
        workspace,
        sessionId,
        body,
        res,
        signal: controller.signal,
        model,
        role,
        // #184: present only when the flag is on; wraps the turn in a durable run.
        runHooks,
      });
    } catch (err) {
      // Any failure AFTER hijack can no longer go through Nest's exception
      // filter, so emit the error on the raw socket if nothing has been written
      // yet. The lost-the-race 409 (RunAlreadyActiveError -> ConflictException)
      // is raised by stream() BEFORE it writes a byte, so headers are still
      // unsent here: honor the HttpException's real status + body (a clean 409),
      // not a blanket 500. Everything else stays a 500.
      const isHttp = err instanceof HttpException;
      if (!isHttp) {
        this.logger.error('AI chat stream failed', err as Error);
      }
      if (!res.raw.headersSent) {
        const status = isHttp ? err.getStatus() : 500;
        const payload = isHttp
          ? err.getResponse()
          : { error: 'Internal server error' };
        res.raw.statusCode = status;
        res.raw.setHeader('Content-Type', 'application/json');
        res.raw.end(
          JSON.stringify(
            typeof payload === 'string' ? { message: payload } : payload,
          ),
        );
      } else if (!res.raw.writableEnded) {
        res.raw.end();
      }
    }
  }

  /**
   * Transcribe an uploaded audio clip to text using the workspace STT model.
   * Gated by settings.ai.dictation (403 when disabled). Returns { text }.
   */
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AI_CHAT_THROTTLER]: { limit: 20, ttl: 60000 } })
  @Post('transcribe')
  @UseInterceptors(FileInterceptor)
  async transcribe(
    @Req() req: any,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ text: string }> {
    // Gate: dictation must be explicitly enabled for the workspace.
    const settings = (workspace.settings ?? {}) as {
      ai?: { dictation?: boolean };
    };
    if (settings.ai?.dictation !== true) {
      throw new ForbiddenException('Dictation is disabled');
    }

    let file = null;
    try {
      // Whisper hard-caps uploads at 25MB; allow a single file.
      file = await req.file({
        limits: { fileSize: 25 * 1024 * 1024, files: 1 },
      });
    } catch (err: any) {
      if (err?.statusCode === 413) {
        throw new BadRequestException('Audio file too large (max 25MB)');
      }
      throw err;
    }
    if (!file) throw new BadRequestException('No audio uploaded');

    // Resolve + whitelist the upload's container type (MediaRecorder mimetypes
    // carry parameters, e.g. "audio/webm;codecs=opus"). A non-whitelisted type
    // is rejected; an allowed one yields the STT container-format hint.
    const resolved = resolveAudioFormat(file.mimetype);
    if (!resolved.ok) {
      throw new BadRequestException('Unsupported audio format');
    }
    const { format } = resolved;

    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch (err: any) {
      // With @fastify/multipart throwFileSizeLimit:true, the 25MB cap is enforced
      // when the stream is consumed (here), not at req.file().
      if (err?.statusCode === 413) {
        throw new BadRequestException('Audio file too large (max 25MB)');
      }
      throw err;
    }
    let text: string;
    try {
      text = await this.aiTranscription.transcribe(workspace.id, buf, format);
    } catch (err) {
      // Preserve meaningful HTTP errors (e.g. AiSttNotConfiguredException -> 503).
      if (err instanceof HttpException) throw err;
      // Log the full error and surface the real provider/transport reason instead
      // of an opaque 500 (e.g. "the STT endpoint returned 404 ...").
      this.logger.error('AI transcription failed', err as Error);
      throw new ServiceUnavailableException(describeProviderError(err));
    }
    return { text };
  }

  /**
   * Generate a page title from supplied note content (#199). One-shot,
   * non-streaming. Gated by the AI chat flag (settings.ai.chat, the same toggle
   * that enables the chat agent); returns { title }.
   * The endpoint NEVER writes the page — the client applies the title via the
   * existing /pages/update route (which enforces edit permission), so access
   * checks are not duplicated here. Throttled per user via AI_CHAT_THROTTLER.
   */
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [AI_CHAT_THROTTLER]: { limit: 20, ttl: 60000 } })
  @Post('generate-page-title')
  async generatePageTitle(
    @Body() dto: GeneratePageTitleDto,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{ title: string }> {
    const settings = (workspace.settings ?? {}) as {
      ai?: { chat?: boolean };
    };
    if (settings.ai?.chat !== true) {
      throw new ForbiddenException('AI title generation is disabled');
    }
    try {
      const title = await this.aiChatService.generatePageTitle(
        workspace.id,
        dto.content,
      );
      return { title };
    } catch (err) {
      // Preserve meaningful HTTP errors (e.g. AiNotConfiguredException -> 503).
      if (err instanceof HttpException) throw err;
      // Surface the real provider/transport reason instead of an opaque 500.
      this.logger.error('AI title generation failed', err as Error);
      throw new ServiceUnavailableException(describeProviderError(err));
    }
  }

  /**
   * Ensure the chat exists, belongs to this workspace, AND was created by the
   * requesting user (per-user isolation). Throws ForbiddenException otherwise.
   */
  private async assertOwnedChat(
    chatId: string,
    user: User,
    workspace: Workspace,
  ): Promise<AiChat> {
    const chat = await this.aiChatRepo.findById(chatId, workspace.id);
    if (!chat || chat.creatorId !== user.id) {
      throw new ForbiddenException();
    }
    return chat;
  }
}

/**
 * Whitelist audio container types produced by browser MediaRecorder (Chrome/FF:
 * webm/opus, Safari: mp4) plus common STT-accepted formats. The value maps each
 * allowed base mime to the container-format hint passed to JSON-style STT
 * providers (e.g. OpenRouter); multipart endpoints ignore the hint.
 */
const AUDIO_FORMAT_MAP: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
};

/**
 * Resolve and whitelist an uploaded clip's mimetype. MediaRecorder mimetypes
 * carry parameters (e.g. "audio/webm;codecs=opus"), so the base type is split
 * out (lowercased, trimmed) before the whitelist check. Returns ok=false for a
 * non-whitelisted container; otherwise the base mime and its STT format hint.
 * Pure — the caller throws BadRequestException on !ok.
 */
export function resolveAudioFormat(
  mimetype: string,
): { ok: true; baseMime: string; format: string } | { ok: false } {
  const baseMime = mimetype.split(';')[0].trim().toLowerCase();
  const format = AUDIO_FORMAT_MAP[baseMime];
  if (format === undefined) {
    return { ok: false };
  }
  return { ok: true, baseMime, format };
}
