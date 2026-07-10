import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class SearchDTO {
  @IsNotEmpty()
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  spaceId: string;

  @IsOptional()
  @IsString()
  shareId?: string;

  @IsOptional()
  @IsString()
  creatorId?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  offset?: number;

  // --- Opt-in agent-lookup mode (#443). ------------------------------------
  // These fields are ADDITIVE and default-off: a web client that sends none of
  // them gets byte-identical FTS behaviour and result shape. They are only read
  // by the substring/path/snippet code path in SearchService.searchPage.
  //
  // NOTE (standalone stdio vs stock upstream): stock upstream validates this DTO
  // with `whitelist: true`, so an older server silently strips these unknown
  // fields and the request degrades gracefully to the plain FTS behaviour.

  // Enables the hybrid substring branch (title + text_content LIKE) merged with
  // the existing FTS branch, plus tiered ranking, path and windowed snippet.
  @IsOptional()
  @IsBoolean()
  substring?: boolean;

  // Restrict the search to a page and all of its descendants (inclusive).
  @IsOptional()
  @IsString()
  parentPageId?: string;

  // Match titles only; do not scan text_content.
  @IsOptional()
  @IsBoolean()
  titleOnly?: boolean;
}

export class SearchShareDTO extends SearchDTO {
  @IsNotEmpty()
  @IsString()
  shareId: string;

  @IsOptional()
  @IsString()
  spaceId: string;
}

export class SearchSuggestionDTO {
  @IsString()
  query: string;

  @IsOptional()
  @IsBoolean()
  includeUsers?: boolean;

  @IsOptional()
  @IsBoolean()
  includeGroups?: boolean;

  @IsOptional()
  @IsBoolean()
  includePages?: boolean;

  @IsOptional()
  @IsBoolean()
  onlyTemplates?: boolean;

  @IsOptional()
  @IsString()
  spaceId?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;
}
