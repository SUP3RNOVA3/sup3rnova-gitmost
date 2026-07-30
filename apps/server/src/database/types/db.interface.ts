import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import { AiProviderCredentials } from '@docmost/db/types/ai-provider-credentials.types';
import { AiMcpServers } from '@docmost/db/types/ai-mcp-servers.types';
import { AiMcpOauthGrants } from '@docmost/db/types/ai-mcp-oauth-grants.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  aiProviderCredentials: AiProviderCredentials;
  aiMcpServers: AiMcpServers;
  aiMcpOauthGrants: AiMcpOauthGrants;
}
