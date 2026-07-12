import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { PageReadFormat } from './create-page.dto';
import { IsPageIdOrSlugId } from './page-identity.validator';

export class PageIdDto {
  @IsString()
  @IsNotEmpty()
  // Format-validate the double identity (#435): accept only a page UUID or a
  // 10-char slugId so a malformed / swapped identity is rejected at the boundary
  // rather than passed to the repo as a bare string. Base for PageInfoDto,
  // DeletePageDto, BacklinksListDto, AddLabelsDto/RemoveLabelDto, etc.
  @IsPageIdOrSlugId()
  pageId: string;
}

export class SpaceIdDto {
  @IsUUID()
  spaceId: string;
}

export class PageHistoryIdDto {
  @IsUUID()
  historyId: string;
}

export class PageInfoDto extends PageIdDto {
  @IsOptional()
  @IsBoolean()
  includeSpace: boolean;

  @IsOptional()
  @IsBoolean()
  includeContent: boolean;

  @IsOptional()
  @Transform(({ value }) => value?.toLowerCase())
  @IsIn(['json', 'markdown', 'html', 'text'])
  format?: PageReadFormat;
}

export class PageWorkTimeDto extends PageIdDto {
  // Viewer IANA timezone for the per-day punch-card buckets (§6.3). Optional —
  // falls back to UTC server-side. Length-capped so a bogus value cannot bloat
  // the request; the value is only ever handed to Intl.DateTimeFormat, which
  // throws on an unknown zone (caught by the controller → 400).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tz?: string;
}

export class DeletePageDto extends PageIdDto {
  @IsOptional()
  @IsBoolean()
  permanentlyDelete?: boolean;
}
