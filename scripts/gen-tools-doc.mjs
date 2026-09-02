#!/usr/bin/env node
/**
 * Generates docs/reference/tools.md from the tools the server actually
 * registers, so the reference for 62 tools cannot drift from the code.
 *
 *   node scripts/gen-tools-doc.mjs           write the file
 *   node scripts/gen-tools-doc.mjs --check   fail if the committed file is stale
 *
 * Runs against dist/, so `npm run build` has to come first. Plain JavaScript on
 * purpose: no extra toolchain, and it works on every Node version in the matrix.
 *
 * The curated summary table in README.md is NOT generated — it groups the tools
 * by what someone would want to do with them, which is editorial. Only this
 * complete reference, with every parameter, is mechanical enough to generate.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';
import { ESSENTIAL_TOOLS } from '../dist/tools/catalogue.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'docs', 'reference', 'tools.md');

/** Connects to a fully configured server so every tool is registered. */
async function listTools() {
  const server = createServer({
    url: 'https://wiki.example.com',
    token: 'placeholder',
    locale: 'en',
    insecureTls: false,
    readOnly: false,
    elicitation: true,
    allowedPaths: undefined,
    allowTools: undefined,
    denyTools: undefined,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gen-tools-doc', version: '0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/** A JSON Schema node rendered as a short type name. */
function typeName(schema) {
  if (!schema) return 'unknown';
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => `\`"${v}"\``).join(' \\| ');
  }
  if (schema.type === 'array') {
    return `${typeName(schema.items)}[]`;
  }
  if (schema.type === 'object') return 'object';
  return schema.type ?? 'unknown';
}

/**
 * Markdown alone is not enough here: VitePress compiles every page as a Vue
 * template, so a description containing `filter_value=<author id>` is parsed as
 * an unclosed HTML tag and fails the docs build. Angle brackets therefore become
 * entities, and `{{` — Vue interpolation — is broken up.
 */
function escapeCell(text) {
  return (
    String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\{\{/g, '{&#123;')
      // Backslashes first: the pipe escape below introduces one, and an input
      // that already contained `\|` would otherwise come out as `\\|` — an
      // escaped backslash followed by a live pipe, which splits the table cell.
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function renderTool(tool) {
  // `?? true` rather than a plain read: the specification gives
  // destructiveHint a default of *true*, so a tool that omits it is claiming
  // to be destructive. Reading it as falsy would have this page understate
  // exactly the tools whose annotation somebody forgot.
  const kind = tool.annotations?.readOnlyHint
    ? 'read-only'
    : (tool.annotations?.destructiveHint ?? true)
      ? 'write, destructive'
      : 'write';
  // Generated from the same constant the filter reads, so "which tools does
  // `essential` select" cannot be written down twice and drift.
  // Read off the schema rather than from a list kept next to it: a tool is
  // guarded exactly when it accepts the fallback token, and that is a fact
  // about this server's own registration.
  const asks = Object.hasOwn(
    tool.inputSchema?.properties ?? {},
    'confirm_token'
  )
    ? ' 👤'
    : '';
  const preset = ESSENTIAL_TOOLS.includes(tool.name) ? ', **essential**' : '';

  const lines = [`### \`${tool.name}\`${asks}`, ''];
  if (tool.title) lines.push(`**${tool.title}** — ${kind}${preset}`, '');
  lines.push(escapeCell(tool.description), '');

  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const names = Object.keys(properties);

  if (names.length === 0) {
    lines.push('Takes no parameters.', '');
    return lines;
  }

  lines.push(
    '| Parameter | Type | Required | Description |',
    '| --- | --- | --- | --- |'
  );
  for (const name of names) {
    const schema = properties[name];
    lines.push(
      `| \`${name}\` | ${typeName(schema)} | ${required.has(name) ? 'yes' : 'no'} | ${escapeCell(schema?.description)} |`
    );
  }
  lines.push('');
  return lines;
}

function render(tools) {
  const read = tools.filter((t) => t.annotations?.readOnlyHint);
  const write = tools.filter((t) => !t.annotations?.readOnlyHint);

  const out = [
    '<!--',
    '  GENERATED FILE — do not edit by hand.',
    '  Regenerate with: npm run build && npm run docs:tools',
    '  The CI test job fails when this file is out of date.',
    '-->',
    '',
    '# Tool reference',
    '',
    `All ${tools.length} tools: ${read.length} read, ${write.length} write.`,
    'With `WIKIJS_READ_ONLY=true` the write tools are not registered at all.',
    '',
    `All ${tools.length} are registered unless you say otherwise. \`WIKIJS_ALLOW_TOOLS\``,
    'and `WIKIJS_DENY_TOOLS` narrow the list to the ones you want, and',
    `\`WIKIJS_ALLOW_TOOLS=essential\` selects the ${ESSENTIAL_TOOLS.length} marked **essential**`,
    'below — see [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).',
    '',
    'Every tool that addresses a page takes either `page_id` or `path` plus',
    "`locale` — the locale is part of a page's identity and defaults to",
    '`WIKIJS_LOCALE`.',
    '',
    '👤 marks a tool that **asks a person** before it acts, through MCP',
    'elicitation — a dialog the model cannot answer on its behalf. Where the',
    'client cannot show one it falls back to a two-call `confirm_token` bound to',
    'the exact target, and says which of the two it was. `ELICITATION=false`',
    'takes that fallback deliberately; it never removes the guard. See',
    '[Asking a person](/guide/approval).',
    '',
    'Every tool declares all four MCP annotations — `readOnlyHint`,',
    '`destructiveHint`, `idempotentHint`, `openWorldHint`. `update_page` is',
    'deliberately **not** destructive: Wiki.js keeps page history, which is what',
    'separates it from the same verb in servers that do not.',
    '',
    'Every tool declares an `outputSchema` and answers with `structuredContent` beside',
    'the text block, so a client can use a result without parsing prose. The tools',
    'that report wiki content carry `untrusted: true` and `source: "wikijs"` as fields',
    'of that object — page text, titles, descriptions and comments are written by',
    'anyone with edit rights.',
    '',
    '## Read tools',
    '',
  ];
  for (const tool of read) out.push(...renderTool(tool));
  out.push('## Write tools', '');
  for (const tool of write) out.push(...renderTool(tool));

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const tools = await listTools();
const generated = render(tools);

if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error(`${target} is missing — run: npm run docs:tools`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(
      `${target} is out of date — run: npm run build && npm run docs:tools`
    );
    process.exit(1);
  }
  console.log(`${target} is up to date (${tools.length} tools)`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, generated);
  console.log(`wrote ${target} (${tools.length} tools)`);
}
