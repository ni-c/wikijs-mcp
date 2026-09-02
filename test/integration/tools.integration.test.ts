import {
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import {
  bootstrap,
  foreignEdit,
  GREP_MARKER,
  mintThrowawayKey,
  type Sandbox,
} from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real Wiki.js in Docker.
 *
 * The unit suite stubs `fetch` and therefore tests what I believe Wiki.js
 * does. This tests what it does. Both of the things this file knows that the
 * stub could not have told me are marked below: version ids are global rather
 * than per-page, and comment creation is throttled to roughly one per second.
 *
 * Order matters and state is shared — a fixture created in one block is read
 * and deleted in a later one — so this is one sequential story rather than a
 * table of independent cases. Vitest runs a file's tests in order.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;
let pageId: number;

/** Tool output is a sentence followed by JSON. */
function parse<T>(text: string): T {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON in result: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}

beforeAll(async () => {
  sandbox = await bootstrap();
  const env = { WIKIJS_URL: sandbox.url, WIKIJS_TOKEN: sandbox.key };
  asking = await startServer({ env, elicit: 'accept' });
  plain = await startServer({ env });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the read surface', () => {
  it('answers for the instance itself', async () => {
    expect(await asking.call('get_site_info')).toContain('2.5');
    await asking.call('list_locales');
    await asking.call('get_navigation_tree');
    await asking.call('list_search_engines');
    await asking.call('list_api_keys');
    await asking.call('list_storage_targets');
  });

  it('finds the seeded pages', async () => {
    const listed = await asking.call('list_pages', { limit: 50 });
    expect(listed).toContain('docs/setup');

    const page = await asking.call('get_page', {
      path: 'docs/setup',
      mode: 'metadata',
    });
    expect(page).toContain('Setup');

    await asking.call('search_pages', { query: 'Setup' });
    await asking.call('get_page_tree', { path: 'docs' });
    await asking.call('list_page_links', {});
  });

  it('greps page content rather than titles', async () => {
    // The marker is in the body only, so a hit proves grep_pages fetched
    // content instead of matching metadata — which is what it claims to do
    // and what no stub could have confirmed.
    const hits = await asking.call('grep_pages', {
      pattern: GREP_MARKER,
      max_pages: 20,
    });
    expect(hits).toContain('docs/setup');
  });

  it('lists tags, assets, users and groups', async () => {
    expect(await asking.call('list_tags')).toContain('docs');
    await asking.call('search_tags', { query: 'do' });
    await asking.call('list_asset_folders', {});
    await asking.call('list_assets', {});
    expect(await asking.call('list_users', {})).toContain(
      'admin@sandbox.local'
    );
    await asking.call('search_users', { query: 'admin' });
    await asking.call('get_user', { user_id: 1 });
    await asking.call('list_groups', {});
    await asking.call('get_group', { group_id: 1 });
    await asking.call('list_comments', { path: 'docs/setup' });
  });
});

describe('a page through its whole life', () => {
  it('creates one and reads it back in every mode', async () => {
    const created = await asking.call('create_page', {
      path: 'integration/page',
      title: 'Integration',
      content: '# Integration\n\n## One\n\nalpha\n\n## Two\n\nbeta\n',
      tags: ['integration'],
    });
    pageId = parse<{ created: { id: number } }>(created).created.id;

    expect(
      await asking.call('get_page', { page_id: pageId, mode: 'outline' })
    ).toContain('One');
    await asking.call('get_page', { page_id: pageId, mode: 'rendered' });
    await asking.call('get_page', {
      page_id: pageId,
      mode: 'content',
      offset: 0,
      max_chars: 200,
    });
  });

  it('edits it and keeps the history', async () => {
    await asking.call('update_page', {
      page_id: pageId,
      edits: [{ old_text: 'alpha', new_text: 'gamma' }],
    });
    const content = await asking.call('get_page', {
      page_id: pageId,
      mode: 'content',
    });
    expect(content).toContain('gamma');

    const history = await asking.call('list_page_history', { page_id: pageId });
    // Version ids are global across the wiki, not 1-based per page. Reading
    // the id out of the list rather than counting is the whole lesson here.
    const versions = parse<{ versions: { versionId: number }[] }>(
      history
    ).versions;
    const versionId = versions.at(-1)?.versionId;
    expect(versionId).toBeDefined();

    await asking.call('get_page_version', {
      page_id: pageId,
      version_id: versionId,
    });
    await asking.call('diff_page_versions', {
      page_id: pageId,
      from_version: versionId,
    });
    await asking.call('restore_page_version', {
      page_id: pageId,
      version_id: versionId,
    });
  });

  it('re-renders it — which counts as an edit, including against yourself', async () => {
    // Found by this suite. `render_page` regenerates derived HTML and changes
    // no content, but Wiki.js still bumps `updatedAt`, and the conflict guard
    // reads exactly that. So a render between a read and a write makes the
    // server refuse the caller's *own* next write, in a sentence that blames
    // "somebody else".
    //
    // Pinned rather than worked around: it is real behaviour, the recovery the
    // message prescribes does work, and a future fix should make this test
    // fail rather than pass quietly.
    const before = parse<{ page: { updatedAt: string } }>(
      await asking.call('get_page', { page_id: pageId, mode: 'metadata' })
    ).page.updatedAt;

    await asking.call('render_page', { page_id: pageId });

    const after = parse<{ page: { updatedAt: string } }>(
      await asking.call('get_page', { page_id: pageId, mode: 'metadata' })
    ).page.updatedAt;
    expect(after).not.toBe(before);

    await asking.call('get_page', { page_id: pageId, mode: 'content' });
    await asking.call('render_page', { page_id: pageId });
    const refused = await asking.call('update_page', {
      page_id: pageId,
      edits: [{ old_text: 'beta', new_text: 'delta' }],
    });
    expect(refused).toContain('changed after you read it');

    // And the prescribed recovery — re-read, then write — does work.
    await asking.call('get_page', { page_id: pageId, mode: 'content' });
    await asking.call('update_page', {
      page_id: pageId,
      edits: [{ old_text: 'beta', new_text: 'delta' }],
    });
  });

  it('converts, moves and finally deletes it', async () => {
    await asking.call('convert_page_editor', {
      page_id: pageId,
      editor: 'code',
    });
    await asking.call('move_page', {
      page_id: pageId,
      destination_path: 'integration/moved',
    });
    expect(
      await asking.call('get_page', {
        path: 'integration/moved',
        mode: 'metadata',
      })
    ).toContain('integration/moved');
    await asking.call('delete_page', { page_id: pageId });
  });
});

describe('the concurrent-edit guard', () => {
  // Ported from scripts/sandbox/conflict.mjs. It cannot be a unit test: the
  // point is that something which is *not* the server saves in between, and
  // a stubbed fetch has no "in between".
  it('refuses a write over an edit the model has not seen', async () => {
    await foreignEdit(
      sandbox,
      sandbox.faqPageId,
      '# FAQ\n\n## Why\n\nBaseline.\n\n## How\n\nBecause.\n'
    );
    await asking.call('get_page', {
      page_id: sandbox.faqPageId,
      mode: 'content',
    });

    await foreignEdit(
      sandbox,
      sandbox.faqPageId,
      '# FAQ\n\nA colleague rewrote this while the model was thinking.\n'
    );

    // Not an error result: the refusal comes back as an ordinary result whose
    // text tells the model how to recover. That is deliberate — an isError
    // would make a client surface it as a failure, when what it is is an
    // instruction — and it is only visible from outside the process.
    const refused = await asking.call('update_page', {
      page_id: sandbox.faqPageId,
      edits: [{ old_text: 'Baseline.', new_text: 'Changed by the model.' }],
    });
    expect(refused).toContain('Refusing to write');
    await asking.call('get_page_conflict', { page_id: sandbox.faqPageId });
  });

  it('accepts the write after a fresh read', async () => {
    await asking.call('get_page', {
      page_id: sandbox.faqPageId,
      mode: 'content',
    });
    await asking.call('update_page', {
      page_id: sandbox.faqPageId,
      edits: [
        {
          old_text: 'A colleague rewrote this',
          new_text: 'A colleague and the model both touched this',
        },
      ],
    });
  });

  it('lets force override a stale read', async () => {
    await asking.call('get_page', {
      page_id: sandbox.faqPageId,
      mode: 'content',
    });
    await foreignEdit(
      sandbox,
      sandbox.faqPageId,
      '# FAQ\n\nColleague again.\n'
    );
    await asking.call('update_page', {
      page_id: sandbox.faqPageId,
      content: '# FAQ\n\nForced by the model.\n',
      force: true,
    });
  });
});

describe('comments', () => {
  it('creates, reads, edits and deletes one', async () => {
    // Wiki.js throttles comment creation to roughly one per second and says
    // nothing about it anywhere.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const created = await asking.call('create_comment', {
      page_id: sandbox.setupPageId,
      content: 'An integration comment.',
    });
    const commentId = parse<{ created: number }>(created).created;

    expect(
      await asking.call('get_comment', { comment_id: commentId })
    ).toContain('integration comment');
    await asking.call('update_comment', {
      comment_id: commentId,
      content: 'An edited integration comment.',
    });
    await asking.call('delete_comment', { comment_id: commentId });
  });
});

describe('assets', () => {
  it('uploads, renames and deletes one', async () => {
    await asking.call('create_asset_folder', { slug: 'integration' });
    await asking.call('upload_asset', {
      filename: 'integration.txt',
      content_base64: Buffer.from('integration').toString('base64'),
      content_type: 'text/plain',
    });

    const listed = await asking.call('list_assets', {});
    const asset = parse<{ assets: { id: number; filename: string }[] }>(
      listed
    ).assets.find((candidate) => candidate.filename === 'integration.txt');
    expect(asset).toBeDefined();

    await asking.call('rename_asset', {
      asset_id: asset!.id,
      filename: 'renamed.txt',
    });
    await asking.call('delete_asset', { asset_id: asset!.id });
  });
});

describe('tags', () => {
  it('renames and deletes one, on a page of its own', async () => {
    // Its own page because Wiki.js garbage-collects a tag the moment no page
    // carries it, so a tag borrowed from an earlier block may already be gone.
    const host = parse<{ created: { id: number } }>(
      await asking.call('create_page', {
        path: 'integration/tagged',
        title: 'Tag host',
        content: '# Tag host\n',
        tags: ['integrationtag'],
      })
    ).created.id;

    const tags = parse<{ tags: { id: number; tag: string }[] }>(
      await asking.call('list_tags')
    ).tags;
    const tag = tags.find((candidate) => candidate.tag === 'integrationtag');
    expect(tag).toBeDefined();

    await asking.call('update_tag', {
      tag_id: tag!.id,
      tag: 'integrationtag2',
      title: 'Renamed',
    });
    await asking.call('delete_tag', { tag_id: tag!.id });
    await asking.call('delete_page', { page_id: host });
  });
});

describe('users and groups', () => {
  it('runs an account and a group through every state they have', async () => {
    const groupId = parse<{ created: { id: number } }>(
      await asking.call('create_group', { name: 'Integration Group' })
    ).created.id;

    await asking.call('update_group', {
      group_id: groupId,
      name: 'Integration Group',
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
    });

    const userId = parse<{ created: { id: number } }>(
      await asking.call('create_user', {
        email: 'integration@example.test',
        name: 'Integration User',
        password: 'integration-password-1',
        groups: [],
      })
    ).created.id;

    await asking.call('update_user', { user_id: userId, job_title: 'Tester' });
    await asking.call('verify_user', { user_id: userId });
    await asking.call('set_user_active', { user_id: userId, active: false });
    await asking.call('set_user_tfa', { user_id: userId, enabled: true });
    await asking.call('assign_user_to_group', {
      group_id: groupId,
      user_id: userId,
    });
    await asking.call('unassign_user_from_group', {
      group_id: groupId,
      user_id: userId,
    });

    // Expected to fail: Wiki.js needs a configured mail server to send the
    // reset link and returns a null envelope without one. What is asserted is
    // that the server reports that rather than crashing on the null — which is
    // exactly the kind of thing a stub returning a tidy object cannot check.
    // The reason travels with the expectation rather than after it: a bare
    // `expectError: true` stays green when the call starts failing for some
    // other reason entirely, which is the failure mode worth naming here —
    // what is being proved is that the *null envelope* is reported, not that
    // something went wrong.
    await asking.call(
      'reset_user_password',
      { user_id: userId },
      { expectError: /no result envelope/ }
    );

    await asking.call('delete_user', {
      user_id: userId,
      replace_with_user_id: 1,
    });
    await asking.call('delete_group', { group_id: groupId });
  });
});

describe('maintenance', () => {
  it('runs the instance-wide operations', async () => {
    await asking.call('flush_page_cache', {});
    await asking.call('rebuild_page_tree', {});
    await asking.call('rebuild_search_index', {});
    await asking.call('purge_page_history', { older_than: 'P3Y' });
    await asking.call('migrate_pages_locale', {
      source_locale: 'zz',
      target_locale: 'yy',
    });
  });
});

describe('WIKIJS_ALLOWED_PATHS, against a wiki that really has the pages', () => {
  it('confines the page render and refuses the instance-wide jobs', async () => {
    // A third server process, configured the way an operator who wants writes
    // confined configures one. Every expectation names the refusal it wants:
    // a bare `expectError: true` here would stay green if the call started
    // failing because the fixture was missing, which is the same green as a
    // scope that works.
    const outside = parse<{ created: { id: number } }>(
      await asking.call('create_page', {
        path: 'team/notes',
        title: 'Outside the scope',
        content: '# Outside\n',
        tags: [],
      })
    ).created.id;

    const scoped = await startServer({
      env: {
        WIKIJS_URL: sandbox.url,
        WIKIJS_TOKEN: sandbox.key,
        WIKIJS_ALLOWED_PATHS: 'docs',
      },
      elicit: 'accept',
    });

    try {
      // Rewrites stored HTML and bumps updatedAt, so it is a page write and is
      // placed like one — which needs a real GET_PAGE_METADATA round trip.
      await scoped.call(
        'render_page',
        { page_id: outside },
        { expectError: /outside WIKIJS_ALLOWED_PATHS/ }
      );
      expect(
        await scoped.call('render_page', { page_id: sandbox.setupPageId })
      ).toContain('Re-rendered');

      for (const name of [
        'flush_page_cache',
        'rebuild_page_tree',
        'rebuild_search_index',
        'purge_page_history',
      ]) {
        await scoped.call(
          name,
          name === 'purge_page_history' ? { older_than: 'P3Y' } : {},
          { expectError: /cannot be confined to WIKIJS_ALLOWED_PATHS/ }
        );
      }
    } finally {
      await scoped.close();
    }

    await asking.call('delete_page', { page_id: outside });
  });
});

describe('api keys', () => {
  it('revokes a throwaway key rather than the one in use', async () => {
    // Both of these can lock the server out of the instance it is talking to,
    // so revoke_api_key is proved against a key minted for the purpose and
    // set_api_state is only ever called with the value it already has.
    await mintThrowawayKey(sandbox, 'integration-throwaway');
    const keys = parse<{
      apiKeys: { id: number; name: string; isRevoked: boolean }[];
    }>(await asking.call('list_api_keys')).apiKeys;
    const throwaway = keys.find(
      (key) => key.name === 'integration-throwaway' && !key.isRevoked
    );
    expect(throwaway).toBeDefined();

    await asking.call('revoke_api_key', { key_id: throwaway!.id });
    await asking.call('set_api_state', { enabled: true });
  });
});

describe('the fallback path for a client with no dialog', () => {
  it('takes the two-call token instead', async () => {
    // The same guarded tools, driven the other way. `plain` declared no
    // elicitation capability, so the server must offer a token — and this is
    // the only place in the repository where that is proved across a real
    // process boundary rather than through InMemoryTransport.
    const created = parse<{ created: { id: number } }>(
      await plain.call('create_page', {
        path: 'integration/fallback',
        title: 'Fallback',
        content: '# Fallback\n',
        tags: [],
      })
    ).created.id;

    const refusal = await plain.call('delete_page', { page_id: created });
    expect(refusal).toContain('confirm_token');
    expect(plain.prompts).toHaveLength(0);

    const groupId = parse<{ created: { id: number } }>(
      await plain.call('create_group', { name: 'Fallback Group' })
    ).created.id;
    await plain.confirmed('delete_group', { group_id: groupId });

    await plain.confirmed('delete_page', { page_id: created });
  });

  it('asked a person on the other harness, and nobody on this one', () => {
    // Every guarded tool the `asking` harness touched put a sentence in front
    // of a person, over a real process boundary. The dialog carries the
    // operation and its consequence — no "This will" prefix, which the
    // fallback text has and this does not.
    expect(asking.prompts.length).toBeGreaterThan(20);
    expect(asking.prompts.join('\n')).toContain('cannot be undone');
  });
});

it('exercises every tool in the catalogue', () => {
  // Both harnesses talk to the same instance, so coverage is their union.
  const called = new Set([...asking.called, ...plain.called]);
  const report = toolCoverage({ called }, ALL_TOOLS, {});
  console.log(
    `wikijs-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real Wiki.js`
  );
  expectEveryToolExercised({ called }, ALL_TOOLS, {});
});
