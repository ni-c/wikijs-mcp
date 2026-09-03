import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { ConfirmationStore, createApproval } from 'mcp-approval';
import {
  buildToolFilter,
  installToolFilter,
  type ToolFilter,
} from 'mcp-tool-allowlist';

import { WikiJsApi } from './api.js';
import type { Config } from './config.js';
import { buildPathScope } from './paths.js';
import { PageReadLog } from './read-log.js';
import { ALL_TOOLS, ESSENTIAL_TOOLS, READ_TOOLS } from './tools/catalogue.js';
import { registerAssetTools } from './tools/assets.js';
import { registerCommentTools } from './tools/comments.js';
import type { Registrar, ToolContext } from './tools/context.js';
import { registerGroupTools } from './tools/groups.js';
import { registerHistoryTools } from './tools/history.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerPageTools } from './tools/pages.js';
import { registerSystemTools } from './tools/system.js';
import { registerTagTools } from './tools/tags.js';
import { registerUserTools } from './tools/users.js';

/**
 * The filter this server's configuration describes.
 *
 * Exported because the filter tests build one too, and the options are this
 * server's own vocabulary rather than something to restate in a second place —
 * a test asking for a different catalogue would prove nothing about what runs.
 */
export function toolFilterFor(config: Config): ToolFilter {
  return buildToolFilter({
    allowTools: config.allowTools,
    denyTools: config.denyTools,
    catalogue: {
      all: ALL_TOOLS,
      essential: ESSENTIAL_TOOLS,
      ungated: READ_TOOLS,
    },
    names: {
      allow: 'WIKIJS_ALLOW_TOOLS',
      deny: 'WIKIJS_DENY_TOOLS',
      server: 'wikijs-mcp',
    },
    gate: {
      closed: config.readOnly,
      variable: 'WIKIJS_READ_ONLY',
      noun: 'read-only mode',
    },
  });
}

/**
 * In catalogue order, so that `src/tools/catalogue.ts`, this list and the
 * documentation's tool table can be read side by side and disagree visibly.
 */
const MODULES: Registrar[] = [
  registerPageTools,
  registerHistoryTools,
  registerTagTools,
  registerAssetTools,
  registerCommentTools,
  registerUserTools,
  registerGroupTools,
  registerSystemTools,
  registerMaintenanceTools,
];

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createServer(config: Config): McpServer {
  // Built first, so a typo in WIKIJS_ALLOW_TOOLS or WIKIJS_ALLOWED_PATHS fails
  // on the way in rather than after half the tools are registered.
  const filter = toolFilterFor(config);
  const scope = buildPathScope(config.allowedPaths);

  const server = new McpServer({
    name: 'wikijs-mcp',
    version: packageVersion(),
  });

  // Before the first registerTool call, or the tools registered until now would
  // escape the filter.
  installToolFilter(server, filter);

  const context: ToolContext = {
    api: new WikiJsApi(config),
    confirmations: new ConfirmationStore(),
    // One approver per server: it holds the key that seals the request state
    // carried out through the client and back.
    approval: createApproval({
      server: 'wikijs-mcp',
      elicitation: config.elicitation,
    }),
    scope,
    reads: new PageReadLog(),
    readOnly: config.readOnly,
  };

  for (const register of MODULES) register(server, context);

  return server;
}
