import type { McpServer } from '@modelcontextprotocol/server';

import type { WikiJsApi } from '../api.js';
import type { ConfirmationStore } from '../confirm.js';
import type { PathScope } from '../paths.js';
import type { PageReadLog } from '../read-log.js';

/**
 * What every tool module needs.
 *
 * One object rather than four positional arguments, because the modules are
 * grouped by subject: `list_assets` and `delete_asset` share a folder id and a
 * kind enum, and splitting them into `read.ts` and `write.ts` would put them
 * hundreds of lines apart for no gain.
 */
export interface ToolContext {
  api: WikiJsApi;
  confirmations: ConfirmationStore;
  scope: PathScope;
  /** Shared so `get_page` and `update_page` agree on when a page was read. */
  reads: PageReadLog;
  readOnly: boolean;
}

export type Registrar = (server: McpServer, context: ToolContext) => void;
