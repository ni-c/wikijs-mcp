#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, missingConfigKeys } from './config.js';
import { PathScopeError } from './paths.js';
import { createServer } from './server.js';
import { ToolFilterError } from './tool-filter.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Everything human-readable goes to stderr: stdout belongs to the protocol,
  // and a single stray line on it breaks the MCP handshake.
  if (config.insecureTls) {
    console.error(
      'wikijs-mcp: WARNING: WIKIJS_INSECURE_TLS is set — TLS certificates are ' +
        'not verified for this host.'
    );
  }
  if (config.readOnly) {
    console.error(
      'wikijs-mcp: WIKIJS_READ_ONLY is set — only read tools are registered.'
    );
  }
  if (config.allowedPaths !== undefined && config.allowedPaths.trim() !== '') {
    console.error(
      `wikijs-mcp: writes are confined to WIKIJS_ALLOWED_PATHS (${config.allowedPaths}).`
    );
  }

  let server;
  try {
    server = createServer(config);
  } catch (error) {
    if (error instanceof ToolFilterError || error instanceof PathScopeError) {
      console.error(`wikijs-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  await server.connect(new StdioServerTransport());

  console.error(
    missingConfigKeys(config).length === 0
      ? `wikijs-mcp: connected to ${config.url} (locale ${config.locale})`
      : 'wikijs-mcp: connected without configuration — tools are listed but ' +
          'every call will fail until WIKIJS_URL and WIKIJS_TOKEN are set.'
  );
}

main().catch((error: unknown) => {
  console.error(
    `wikijs-mcp: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
