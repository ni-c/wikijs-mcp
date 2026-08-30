// Calls every tool in the catalogue at least once against the sandbox,
// following the confirm-token dance where one is required.
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ALL_TOOLS } from '../../dist/tools/catalogue.js';

const cfg = JSON.parse(
  fs.readFileSync(new URL('./sandbox.json', import.meta.url), 'utf8')
);
const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../../dist/index.js', import.meta.url).pathname],
  env: { PATH: process.env.PATH, WIKIJS_URL: cfg.url, WIKIJS_TOKEN: cfg.key },
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const called = new Set();
const failures = [];

async function call(name, args = {}, { confirm = false } = {}) {
  called.add(name);
  let r = await client.callTool({ name, arguments: args });
  let text = r.content.map((c) => c.text ?? '').join('\n');
  if (confirm) {
    const token = /confirm_token="([0-9a-f]{32})"/.exec(text)?.[1];
    if (!token) {
      failures.push([
        name,
        'no confirmation token offered: ' + text.slice(0, 160),
      ]);
      return text;
    }
    r = await client.callTool({
      name,
      arguments: { ...args, confirm_token: token },
    });
    text = r.content.map((c) => c.text ?? '').join('\n');
  }
  if (r.isError) failures.push([name, text.slice(0, 200)]);
  return text;
}

// A previous aborted run may have left fixtures behind; this has to be
// repeatable, so clear them before starting.
for (const stale of ['smoke/page', 'smoke/moved']) {
  const found = await client.callTool({
    name: 'get_page',
    arguments: { path: stale, mode: 'metadata' },
  });
  if (found.isError) continue;
  const id = JSON.parse(
    found.content
      .map((c) => c.text ?? '')
      .join('\n')
      .replace(/^[^{]*/, '')
  ).page.id;
  const first = await client.callTool({
    name: 'delete_page',
    arguments: { page_id: id },
  });
  const tok = /confirm_token="([0-9a-f]{32})"/.exec(
    first.content.map((c) => c.text ?? '').join('\n')
  )?.[1];
  if (tok) {
    await client.callTool({
      name: 'delete_page',
      arguments: { page_id: id, confirm_token: tok },
    });
  }
  console.log('cleared leftover', stale);
}

// Same for the account and group: create_user refuses a duplicate email.
{
  const raw = await client.callTool({ name: 'list_users', arguments: {} });
  const users = JSON.parse(
    raw.content
      .map((c) => c.text ?? '')
      .join('\n')
      .replace(/^[^{]*/, '')
  ).users;
  for (const u of users.filter((u) => u.email === 'smoke@example.test')) {
    const first = await client.callTool({
      name: 'delete_user',
      arguments: { user_id: u.id, replace_with_user_id: 1 },
    });
    const tok = /confirm_token="([0-9a-f]{32})"/.exec(
      first.content.map((c) => c.text ?? '').join('\n')
    )?.[1];
    if (tok) {
      await client.callTool({
        name: 'delete_user',
        arguments: {
          user_id: u.id,
          replace_with_user_id: 1,
          confirm_token: tok,
        },
      });
    }
    console.log('cleared leftover user', u.email);
  }
  const rawG = await client.callTool({ name: 'list_groups', arguments: {} });
  const groups = JSON.parse(
    rawG.content
      .map((c) => c.text ?? '')
      .join('\n')
      .replace(/^[^{]*/, '')
  ).groups;
  for (const g of groups.filter((g) => g.name === 'Smoke Group')) {
    const first = await client.callTool({
      name: 'delete_group',
      arguments: { group_id: g.id },
    });
    const tok = /confirm_token="([0-9a-f]{32})"/.exec(
      first.content.map((c) => c.text ?? '').join('\n')
    )?.[1];
    if (tok) {
      await client.callTool({
        name: 'delete_group',
        arguments: { group_id: g.id, confirm_token: tok },
      });
    }
    console.log('cleared leftover group', g.name);
  }
}

// --- read surface -----------------------------------------------------------
await call('get_site_info');
await call('list_locales');
await call('get_navigation_tree');
await call('list_search_engines');
await call('list_api_keys');
await call('list_storage_targets');
await call('list_pages', { limit: 5 });
await call('get_page', { path: 'docs/setup', mode: 'metadata' });
await call('search_pages', { query: 'Setup' });
await call('grep_pages', { pattern: 'PINEAPPLE', max_pages: 10 });
await call('get_page_tree', { path: 'docs' });
await call('list_page_links', {});
await call('list_tags');
await call('search_tags', { query: 'do' });
await call('list_asset_folders', {});
await call('list_assets', {});
await call('list_users', {});
await call('search_users', { query: 'admin' });
await call('get_user', { user_id: 1 });
await call('list_groups', {});
await call('get_group', { group_id: 1 });
await call('list_comments', { path: 'docs/setup' });

// --- pages ------------------------------------------------------------------
const created = await call('create_page', {
  path: 'smoke/page',
  title: 'Smoke',
  content: '# Smoke\n\n## One\n\nalpha\n\n## Two\n\nbeta\n',
  tags: ['smoke'],
});
const pageId = JSON.parse(created).created.id;
await call('get_page', { page_id: pageId, mode: 'outline' });
await call('get_page', { page_id: pageId, mode: 'rendered' });
await call('get_page', {
  page_id: pageId,
  mode: 'content',
  offset: 0,
  max_chars: 200,
});
await call('update_page', {
  page_id: pageId,
  edits: [{ old_text: 'alpha', new_text: 'gamma' }],
});
const history = await call('list_page_history', { page_id: pageId });
// Version ids are global across the wiki, not 1-based per page.
const versionId = JSON.parse(history.replace(/^[^{]*/, '')).versions.at(
  -1
).versionId;
await call('get_page_version', { page_id: pageId, version_id: versionId });
await call('diff_page_versions', { page_id: pageId, from_version: versionId });
await call('get_page_conflict', { page_id: pageId });
await call(
  'restore_page_version',
  { page_id: pageId, version_id: versionId },
  { confirm: true }
);
await call(
  'convert_page_editor',
  { page_id: pageId, editor: 'code' },
  { confirm: true }
);
await call('render_page', { page_id: pageId });
await call(
  'move_page',
  { page_id: pageId, destination_path: 'smoke/moved' },
  { confirm: true }
);

// --- comments ---------------------------------------------------------------
// Wiki.js throttles comment creation to about one per second, undocumented.
await new Promise((r) => setTimeout(r, 1500));
const comment = await call('create_comment', {
  page_id: pageId,
  content: 'A smoke comment.',
});
const commentId = JSON.parse(comment).created;
await call('get_comment', { comment_id: commentId });
await call('update_comment', {
  comment_id: commentId,
  content: 'An edited smoke comment.',
});
await call('delete_comment', { comment_id: commentId }, { confirm: true });

// --- assets -----------------------------------------------------------------
await call('create_asset_folder', { slug: `smoke-${process.pid}` });
await call('upload_asset', {
  filename: 'smoke.txt',
  content_base64: Buffer.from('smoke').toString('base64'),
  content_type: 'text/plain',
});
const assets = JSON.parse(
  (await call('list_assets', {})).slice(
    (await call('list_assets', {})).indexOf('{')
  )
).assets;
const assetId = assets.find((a) => a.filename === 'smoke.txt')?.id;
if (assetId) {
  await call(
    'rename_asset',
    { asset_id: assetId, filename: 'smoke2.txt' },
    { confirm: true }
  );
  await call('delete_asset', { asset_id: assetId }, { confirm: true });
}

// --- tags -------------------------------------------------------------------
// On its own page: Wiki.js garbage-collects a tag as soon as no page carries
// it, so a tag borrowed from an earlier step may already be gone by now.
const tagHost = JSON.parse(
  (
    await call('create_page', {
      path: `smoke/tagged-${process.pid}`,
      title: 'Tag host',
      content: '# Tag host\n',
      tags: [`smoketag${process.pid}`],
    })
  ).replace(/^[^{]*/, '')
).created.id;
const tags = JSON.parse((await call('list_tags')).replace(/^[^{]*/, '')).tags;
const smokeTag = tags.find((t) => t.tag === `smoketag${process.pid}`);
if (smokeTag) {
  await call(
    'update_tag',
    { tag_id: smokeTag.id, tag: `smoketag${process.pid}b`, title: 'Renamed' },
    { confirm: true }
  );
  await call('delete_tag', { tag_id: smokeTag.id }, { confirm: true });
} else {
  failures.push([
    'update_tag',
    'the freshly created tag was not found in list_tags',
  ]);
}
await call('delete_page', { page_id: tagHost }, { confirm: true });

// --- users and groups -------------------------------------------------------
const group = await call('create_group', { name: 'Smoke Group' });
const groupId = JSON.parse(group).created.id;
await call(
  'update_group',
  {
    group_id: groupId,
    name: 'Smoke Group',
    permissions: ['read:pages'],
    page_rules: [
      {
        id: 'r1',
        deny: false,
        match: 'START',
        roles: ['read:pages'],
        path: 'docs',
        locales: [],
      },
    ],
  },
  { confirm: true }
);
const user = await call(
  'create_user',
  {
    email: 'smoke@example.test',
    name: 'Smoke User',
    password: 'smoke-password-1',
    groups: [],
  },
  { confirm: true }
);
const userId = JSON.parse(user).created.id;
await call(
  'update_user',
  { user_id: userId, job_title: 'Tester' },
  { confirm: true }
);
await call('verify_user', { user_id: userId }, { confirm: true });
await call(
  'set_user_active',
  { user_id: userId, active: false },
  { confirm: true }
);
await call(
  'set_user_tfa',
  { user_id: userId, enabled: true },
  { confirm: true }
);
await call(
  'assign_user_to_group',
  { group_id: groupId, user_id: userId },
  { confirm: true }
);
await call(
  'unassign_user_from_group',
  { group_id: groupId, user_id: userId },
  { confirm: true }
);
// Expected to fail in the sandbox: Wiki.js needs a configured mail server to
// send the reset link, and returns a null result envelope without one. What is
// being verified here is that the server reports that clearly instead of
// crashing on the null.
const reset = await call(
  'reset_user_password',
  { user_id: userId },
  { confirm: true }
);
if (reset.includes('no result envelope')) {
  failures.pop();
  console.log(
    'reset_user_password: expected mail-server failure, reported cleanly'
  );
}
await call(
  'delete_user',
  { user_id: userId, replace_with_user_id: 1 },
  { confirm: true }
);
await call('delete_group', { group_id: groupId }, { confirm: true });

// --- maintenance ------------------------------------------------------------
await call('flush_page_cache', {}, { confirm: true });
await call('rebuild_page_tree', {}, { confirm: true });
await call('rebuild_search_index', {}, { confirm: true });
await call('purge_page_history', { older_than: 'P3Y' }, { confirm: true });
await call(
  'migrate_pages_locale',
  { source_locale: 'zz', target_locale: 'yy' },
  { confirm: true }
);

// --- cleanup ----------------------------------------------------------------
await call('delete_page', { page_id: pageId }, { confirm: true });

// --- api keys ---------------------------------------------------------------
// Both of these can lock the server out of its own instance, so they are proved
// against a throwaway key rather than the one in use, and set_api_state is only
// ever called with true (the value it already has).
const spare = await fetch(cfg.url + '/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + cfg.key,
  },
  body: JSON.stringify({
    query: `mutation{authentication{createApiKey(name:"smoke-throwaway",expiration:"1y",fullAccess:false,group:1){key responseResult{succeeded message}}}}`,
  }),
}).then((r) => r.json());
if (spare.data?.authentication?.createApiKey?.responseResult?.succeeded) {
  const listed = JSON.parse(
    (await call('list_api_keys')).replace(/^[^{]*/, '')
  );
  const throwaway = listed.apiKeys.find(
    (k) => k.name === 'smoke-throwaway' && !k.isRevoked
  );
  if (throwaway) {
    await call('revoke_api_key', { key_id: throwaway.id }, { confirm: true });
  } else {
    failures.push(['revoke_api_key', 'the throwaway key was not listed']);
  }
} else {
  failures.push(['revoke_api_key', 'could not mint a throwaway key to revoke']);
}
await call('set_api_state', { enabled: true }, { confirm: true });

const skipped = [];

await client.close();

const missing = ALL_TOOLS.filter((t) => !called.has(t) && !skipped.includes(t));
console.log(`called ${called.size}/${ALL_TOOLS.length} tools`);
console.log('skipped on purpose:', skipped.join(', '));
if (missing.length) console.log('NOT CALLED:', missing.join(', '));
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const [name, msg] of failures) console.log(`  ${name}: ${msg}`);
} else {
  console.log('\nno failures');
}
