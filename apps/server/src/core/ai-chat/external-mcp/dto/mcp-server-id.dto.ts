import { IsString } from 'class-validator';

/**
 * Path/body param identifying a single MCP server for the per-server routes
 * (update/delete/test). Shared (#686) by the admin controller and the personal
 * `account/mcp-servers` controller so both validate the id the same way.
 */
export class McpServerIdDto {
  @IsString()
  id: string;
}
