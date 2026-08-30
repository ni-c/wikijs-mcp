#!/usr/bin/env node
/**
 * Calls one tool on the built server and prints its text result.
 *
 *   node scripts/sandbox/call.mjs get_site_info
 *   node scripts/sandbox/call.mjs grep_pages '{"pattern":"widget"}'
 *   node scripts/sandbox/call.mjs grep_pages pattern=widget max_pages=5
 *
 * The key=value form exists for the demo tape: vhs cannot type a string
 * containing both quote characters, and every JSON argument needs both.
 *
 * Credentials come from scripts/sandbox/sandbox.json (written by bootstrap.py),
 * or from WIKIJS_URL / WIKIJS_TOKEN if that file is not there — which is how the
 * demo tape drives it. Development helper, not shipped: `files` in package.json
 * is `dist` only.
 */
import { existsSync, readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sandbox = new URL('./sandbox.json', import.meta.url);
const config = existsSync(sandbox)
  ? JSON.parse(readFileSync(sandbox, 'utf8'))
  : { url: process.env.WIKIJS_URL, key: process.env.WIKIJS_TOKEN };

if (!config.url || !config.key) {
  console.error(
    'No credentials: run scripts/sandbox/bootstrap.py, or set WIKIJS_URL and WIKIJS_TOKEN.'
  );
  process.exit(1);
}

const [tool, ...rest] = process.argv.slice(2);
if (!tool) {
  console.error('usage: call.mjs <tool> [json | key=value ...]');
  process.exit(1);
}

/** Either one JSON object, or a list of key=value pairs. */
function parseArguments(parts) {
  if (parts.length === 0) return {};
  if (parts.length === 1 && parts[0].trimStart().startsWith('{')) {
    return JSON.parse(parts[0]);
  }
  const out = {};
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at === -1) throw new Error(`not a key=value pair: ${part}`);
    const key = part.slice(0, at);
    const raw = part.slice(at + 1);
    if (raw === 'true' || raw === 'false') out[key] = raw === 'true';
    else if (/^-?\d+$/.test(raw)) out[key] = Number(raw);
    else if (raw.startsWith('[') || raw.startsWith('{'))
      out[key] = JSON.parse(raw);
    else out[key] = raw;
  }
  return out;
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../../dist/index.js', import.meta.url).pathname],
  env: {
    PATH: process.env.PATH,
    WIKIJS_URL: config.url,
    WIKIJS_TOKEN: config.key,
    ...(process.env.WIKIJS_ALLOWED_PATHS
      ? { WIKIJS_ALLOWED_PATHS: process.env.WIKIJS_ALLOWED_PATHS }
      : {}),
    ...(process.env.WIKIJS_READ_ONLY
      ? { WIKIJS_READ_ONLY: process.env.WIKIJS_READ_ONLY }
      : {}),
  },
});

const client = new Client({ name: 'call', version: '1.0.0' });
await client.connect(transport);
const result = await client.callTool({
  name: tool,
  arguments: parseArguments(rest),
});
await client.close();

// The untrusted-content marker is a paragraph in front of the JSON; strip it so
// the output can be piped into jq.
const text = result.content.map((part) => part.text ?? '').join('\n');
const start = text.indexOf('{');
console.log(start === -1 ? text : text.slice(start));
process.exit(result.isError ? 1 : 0);
