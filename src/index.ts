#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig, missingConfigKeys } from './config.js';
import { PathScopeError } from './paths.js';
import { createServer } from './server.js';
import { ToolFilterError } from 'mcp-tool-allowlist';

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
  // Printed only when it is off, like the line above. ELICITATION is
  // unprefixed, so one `export ELICITATION=false` reaches every MCP server in
  // the environment — this line is what makes that visible in the log of each
  // one it actually reached.
  if (!config.elicitation) {
    console.error(
      'wikijs-mcp: ELICITATION=false — guarded tools fall back to the two-call token.'
    );
  }
  if (config.allowedPaths !== undefined && config.allowedPaths.trim() !== '') {
    console.error(
      `wikijs-mcp: writes are confined to WIKIJS_ALLOWED_PATHS (${config.allowedPaths}).`
    );
  }

  // Built before anything is served, so a rejected tool filter or path scope
  // still ends the process rather than surfacing as a failed handshake once a
  // client has already connected.
  let pending: McpServer | undefined;
  try {
    pending = createServer(config);
  } catch (error) {
    if (error instanceof ToolFilterError || error instanceof PathScopeError) {
      console.error(`wikijs-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // `serveStdio` owns the era decision for the connection: the opening exchange
  // selects 2025-11-25 or 2026-07-28 and pins one instance from this factory
  // for its lifetime. Hand-wiring `server.connect(new StdioServerTransport())`
  // serves only the 2025 era, which is why a negotiating client's
  // `server/discover` probe was answered with "Method not found".
  //
  // The instance built above serves the first connection; a second call — a
  // modern probe followed by the real connection — builds a fresh one, which is
  // safe because `createServer` only registers tools.
  serveStdio(() => {
    const server = pending ?? createServer(config);
    pending = undefined;
    return server;
  });

  console.error(
    missingConfigKeys(config).length === 0
      ? `wikijs-mcp: connected to ${config.url} (locale ${config.locale})`
      : 'wikijs-mcp: connected without configuration — tools are listed but ' +
          'every call will fail until WIKIJS_URL and WIKIJS_TOKEN are set.'
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error(
    `wikijs-mcp: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
