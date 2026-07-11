import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Identify a chat by id (workspace-scoped on the server). */
export class ChatIdDto {
  @IsString()
  chatId: string;
}

/** Rename a chat. */
export class RenameChatDto {
  @IsString()
  chatId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;
}

/** One-shot page-title generation from note content (#199). */
export class GeneratePageTitleDto {
  // Note body as markdown/plain text. Capped to bound the prompt cost and
  // reject abusive payloads; the service truncates again before the model call.
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  content: string;
}

/** Optional chat id for listing messages of a specific chat. */
export class GetChatMessagesDto {
  @IsString()
  chatId: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}

/**
 * Delta poll (#491): pull the chat's rows changed since `cursor` (a DB-clock
 * timestamp from the previous poll) plus the current run fact — the degraded-poll
 * fallback's payload, replacing the full infinite-query refetch. Omit `cursor` on
 * the first poll (returns just a fresh cursor to start the chain).
 */
export class GetChatDeltaDto {
  @IsString()
  chatId: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}

/** Resolve the chat bound to a document (the page's most-recent owned chat). */
export class BoundChatDto {
  @IsString()
  pageId: string;
}

/**
 * Reconnect to the latest run of a chat (#184): fetch its persisted lifecycle
 * state (and the assistant message it projects) for an in-flight or finished run.
 */
export class GetRunDto {
  @IsString()
  chatId: string;
}

/**
 * Explicitly STOP an agent run (#184): the user pressed Stop — distinct from a
 * browser disconnect, which never stops a run. Either the run id (preferred, from
 * the streamed start metadata) or the chat id (stop whatever run is active on it).
 */
export class StopRunDto {
  @IsOptional()
  @IsString()
  runId?: string;

  @IsOptional()
  @IsString()
  chatId?: string;
}

/** Export a chat to Markdown (#183). `lang` localizes the few fixed
 *  role/tool-action labels; defaults to English server-side. */
export class ExportChatDto {
  @IsString()
  chatId: string;

  // A full client locale tag (e.g. 'en-US', 'ru-RU') — normalized server-side to
  // a supported export language (see normalizeLang). Accept any string so a
  // region-qualified locale is not rejected (the 400 that broke the real client).
  @IsOptional()
  @IsString()
  lang?: string;
}
