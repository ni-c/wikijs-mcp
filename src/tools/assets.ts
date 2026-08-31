import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { assertSucceeded, type WikiJsApi } from '../api.js';
import { identifier } from '../confirm.js';
import * as gql from '../gql/admin.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import { assertWithinScope, type PathScope } from '../paths.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import { confirmTokenParam, idParam } from '../schema.js';
import type { ToolContext } from './context.js';

/** Depth the folder walk gives up at, so a cycle cannot loop forever. */
const MAX_FOLDER_DEPTH = 12;

/**
 * The slash-separated path of an asset folder, found by walking down from the
 * root.
 *
 * Wiki.js has no parent pointer on an asset folder and no way to look one up by
 * id — `assets.folders(parentFolderId)` returns one level and nothing else — so
 * the path has to be reconstructed by descending. Folder trees are small; this
 * is a handful of queries and only runs when WIKIJS_ALLOWED_PATHS is set.
 *
 * Returns `''` for the root, which is outside every prefix — writing to the root
 * of the asset store is correctly refused while a scope is active.
 */
async function folderPath(api: WikiJsApi, folderId: number): Promise<string> {
  if (folderId === 0) return '';
  let level: Array<{ id: number; path: string }> = [{ id: 0, path: '' }];
  for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth++) {
    const next: Array<{ id: number; path: string }> = [];
    for (const parent of level) {
      const data = await api.execute('asset scope', gql.LIST_ASSET_FOLDERS, {
        parentFolderId: parent.id,
      });
      const folders = listOf(
        objectOf(data.assets, 'the asset query').folders,
        'asset folders'
      ) as Array<{ id: number; slug: string }>;
      for (const folder of folders) {
        const path = parent.path
          ? `${parent.path}/${folder.slug}`
          : folder.slug;
        if (folder.id === folderId) return path;
        next.push({ id: folder.id, path });
      }
    }
    if (next.length === 0) break;
    level = next;
  }
  throw new Error(
    `asset folder ${folderId} was not found under the asset root, so this ` +
      'server cannot tell whether it is inside WIKIJS_ALLOWED_PATHS. Refusing ' +
      'rather than guessing.'
  );
}

/**
 * Refuses an asset write whose folder is outside the configured scope.
 *
 * The asset store is a second namespace beside the page tree, and
 * `WIKIJS_ALLOWED_PATHS` is applied to both: an operator who confined writes to
 * `docs` is told nothing outside `docs` can be written, and an asset deletion
 * that breaks images across the whole wiki would make that untrue.
 */
async function assertFolderWithinScope(
  api: WikiJsApi,
  scope: PathScope,
  folderId: number,
  role: string
): Promise<void> {
  if (!scope.active) return;
  const path = await folderPath(api, folderId);
  assertWithinScope(scope, path === '' ? '(asset root)' : path, role);
}

/** The folder an asset currently lives in, for the tools that take an asset id. */
async function assetFolderId(api: WikiJsApi, assetId: number): Promise<number> {
  // Wiki.js cannot look an asset up by id, only list a folder's contents, so the
  // folder has to be found by scanning. Bounded by MAX_FOLDER_DEPTH as above.
  const seen: number[] = [0];
  for (let depth = 0; depth < MAX_FOLDER_DEPTH && seen.length > 0; depth++) {
    const next: number[] = [];
    for (const folder of seen) {
      const listed = await api.execute('asset scope', gql.LIST_ASSETS, {
        folderId: folder,
        kind: 'ALL',
      });
      const assets = listOf(
        objectOf(listed.assets, 'the asset query').list,
        'assets'
      ) as Array<{ id: number }>;
      if (assets.some((asset) => asset.id === assetId)) return folder;
      const children = await api.execute(
        'asset scope',
        gql.LIST_ASSET_FOLDERS,
        {
          parentFolderId: folder,
        }
      );
      for (const child of listOf(
        objectOf(children.assets, 'the asset query').folders,
        'asset folders'
      ) as Array<{ id: number }>) {
        next.push(child.id);
      }
    }
    seen.length = 0;
    seen.push(...next);
  }
  throw new Error(
    `asset ${assetId} was not found in any folder, so this server cannot tell ` +
      'whether it is inside WIKIJS_ALLOWED_PATHS. Refusing rather than guessing.'
  );
}

/**
 * Ceiling on an upload.
 *
 * Wiki.js has its own `uploadMaxFileSize` setting and will reject anything
 * above it, but the payload arrives here as base64 inside a tool call first —
 * so it has to be bounded before it is ever decoded, not after.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Asset filenames end up in URLs and on disk. */
const filenameParam = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/,
    'a filename must start with a letter or digit, carry an extension, and use ' +
      'only letters, digits, dot, underscore and hyphen'
  )
  .refine((value) => !value.includes('..'), {
    message: 'a filename may not contain ".."',
  })
  .refine((value) => !ACTIVE_EXTENSIONS.test(value), {
    message:
      'this server refuses to upload SVG, HTML or XML: Wiki.js serves assets ' +
      'from the wiki’s own origin, so a file of one of those types can carry ' +
      'script that runs for every reader. Convert it to PNG first.',
  })
  .describe('File name including its extension, e.g. "diagram.png".');

/** File types that execute in a browser when served from the wiki's origin. */
const ACTIVE_EXTENSIONS = /\.(svgz?|x?html?|xml|mhtml?)$/i;

/**
 * The content type for a filename, rather than the caller's word for it.
 *
 * A caller-supplied MIME type is not evidence: `evil.html` announced as
 * `image/png` is still served as whatever Wiki.js decides, and the only thing
 * the claim achieves is to make the upload look harmless in a transcript.
 */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  gz: 'application/gzip',
};

function contentTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export function registerAssetTools(
  server: McpServer,
  { api, confirmations, scope, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_assets',
    {
      title: 'List assets in a folder',
      description:
        'Lists the images and files in one asset folder. Folder 0 is the root. ' +
        'Assets are flat within a folder and Wiki.js has no search across them, ' +
        'so finding one means walking list_asset_folders.',
      inputSchema: z.object({
        folder_id: idParam
          .or(z.literal(0))
          .optional()
          .describe(
            'Folder id from list_asset_folders. 0 (default) is the root.'
          ),
        kind: z
          .enum(['ALL', 'IMAGE', 'BINARY'])
          .optional()
          .describe('Restrict to images or to non-image files.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ folder_id, kind }) =>
      run(async () => {
        const data = await api.execute('list_assets', gql.LIST_ASSETS, {
          folderId: folder_id ?? 0,
          kind: kind ?? 'ALL',
        });
        const assets = listOf(
          objectOf(data.assets, 'the asset query').list,
          'assets'
        );
        return budgetedList('assets', assets, {
          untrusted: true,
          extra: { folderId: folder_id ?? 0, count: assets.length },
        });
      })
  );

  server.registerTool(
    'list_asset_folders',
    {
      title: 'List asset folders',
      description:
        'Lists the folders directly under an asset folder. Folder 0 is the ' +
        'root. Wiki.js returns one level at a time, so a deep tree needs one ' +
        'call per level.',
      inputSchema: z.object({
        parent_folder_id: idParam
          .or(z.literal(0))
          .optional()
          .describe('Parent folder id. 0 (default) is the root.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ parent_folder_id }) =>
      run(async () => {
        const data = await api.execute(
          'list_asset_folders',
          gql.LIST_ASSET_FOLDERS,
          { parentFolderId: parent_folder_id ?? 0 }
        );
        const folders = listOf(
          objectOf(data.assets, 'the asset query').folders,
          'asset folders'
        );
        return budgetedList('folders', folders, {
          untrusted: true,
          extra: { parentFolderId: parent_folder_id ?? 0 },
        });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'upload_asset',
    {
      title: 'Upload a file',
      description:
        'Uploads an image or file to an asset folder, so it can be embedded in ' +
        'a page. Content is passed base64-encoded and the content type is ' +
        'derived from the extension. SVG, HTML and XML are refused: Wiki.js ' +
        'serves assets from the wiki’s own origin, so those can carry script ' +
        'that runs for every reader. Note that Wiki.js 2.x has no GraphQL ' +
        'mutation for uploads at all — this uses the editor’s own route, which ' +
        'is undocumented and could change in a future Wiki.js release.',
      inputSchema: z.object({
        filename: filenameParam,
        content_base64: z
          .string()
          .min(1)
          .max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8)
          .describe('File contents, base64-encoded.'),
        folder_id: idParam
          .or(z.literal(0))
          .optional()
          .describe('Target folder id. 0 (default) is the root.'),
      }),
      annotations: { idempotentHint: false },
    },
    async ({ filename, content_base64, folder_id }) =>
      run(async () => {
        let bytes: Buffer;
        try {
          bytes = Buffer.from(content_base64, 'base64');
        } catch {
          throw new Error('content_base64 is not valid base64.');
        }
        if (bytes.byteLength === 0) {
          throw new Error(
            'content_base64 decoded to zero bytes — check the encoding.'
          );
        }
        if (bytes.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(
            `the file is ${Math.round(bytes.byteLength / 1024)} KB, above this ` +
              `server’s ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload ceiling.`
          );
        }

        await assertFolderWithinScope(
          api,
          scope,
          folder_id ?? 0,
          'asset folder'
        );
        await api.upload(
          filename,
          contentTypeFor(filename),
          bytes,
          folder_id ?? 0
        );
        return jsonResult({
          uploaded: filename,
          bytes: bytes.byteLength,
          folderId: folder_id ?? 0,
          note:
            'Wiki.js assigns the id and path itself — call list_assets on the ' +
            'folder to get them.',
        });
      })
  );

  server.registerTool(
    'create_asset_folder',
    {
      title: 'Create an asset folder',
      description:
        'Creates a folder in the asset store. The slug is what appears in the ' +
        'URL of every file inside it.',
      inputSchema: z.object({
        parent_folder_id: idParam
          .or(z.literal(0))
          .optional()
          .describe('Parent folder id. 0 (default) is the root.'),
        slug: z
          .string()
          .trim()
          .toLowerCase()
          .min(1)
          .max(255)
          .regex(
            /^[a-z0-9][a-z0-9-]*$/,
            'a slug is lowercase letters, digits and hyphens'
          )
          .describe('URL segment for the folder.'),
        name: z
          .string()
          .trim()
          .max(255)
          .optional()
          .describe('Display name (defaults to the slug).'),
      }),
      annotations: { idempotentHint: false },
    },
    async ({ parent_folder_id, slug, name }) =>
      run(async () => {
        await assertFolderWithinScope(
          api,
          scope,
          parent_folder_id ?? 0,
          'parent asset folder'
        );
        const data = await api.execute(
          'create_asset_folder',
          gql.CREATE_ASSET_FOLDER,
          {
            parentFolderId: parent_folder_id ?? 0,
            slug,
            name: name ?? null,
          }
        );
        assertSucceeded(
          objectOf(data.assets, 'the asset mutation').createFolder,
          'create_asset_folder'
        );
        return textResult(`Created asset folder "${slug}".`);
      })
  );

  server.registerTool(
    'rename_asset',
    {
      title: 'Rename a file',
      description:
        'Renames an asset. Pages embedding it by its old URL will break — ' +
        'Wiki.js does not rewrite them.',
      inputSchema: z.object({
        asset_id: idParam.describe('Asset id from list_assets.'),
        filename: filenameParam.describe('New file name, including extension.'),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ asset_id, filename, confirm_token }) =>
      run(async () => {
        if (scope.active) {
          await assertFolderWithinScope(
            api,
            scope,
            await assetFolderId(api, asset_id),
            'asset folder'
          );
        }
        return guarded(
          confirmations,
          {
            tool: 'rename_asset',
            targets: [`asset:${asset_id}`, `filename:${filename}`],
            what: `rename asset ${asset_id} to ${identifier(filename, 'filename')}`,
            consequence:
              'Pages that embed this file by its current URL will stop showing it.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('rename_asset', gql.RENAME_ASSET, {
              id: asset_id,
              filename,
            });
            assertSucceeded(
              objectOf(data.assets, 'the asset mutation').renameAsset,
              'rename_asset'
            );
            return textResult(`Renamed asset ${asset_id} to "${filename}".`);
          }
        );
      })
  );

  server.registerTool(
    'delete_asset',
    {
      title: 'Delete a file',
      description:
        'Deletes an asset permanently. Any page embedding it will show a broken ' +
        'image or a dead link. Requires a confirmation token.',
      inputSchema: z.object({
        asset_id: idParam.describe('Asset id from list_assets.'),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ asset_id, confirm_token }) =>
      run(async () => {
        if (scope.active) {
          await assertFolderWithinScope(
            api,
            scope,
            await assetFolderId(api, asset_id),
            'asset folder'
          );
        }
        return guarded(
          confirmations,
          {
            tool: 'delete_asset',
            targets: [String(asset_id)],
            what: `delete asset ${asset_id}`,
            consequence:
              'The file is removed for good and every page embedding it breaks.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('delete_asset', gql.DELETE_ASSET, {
              id: asset_id,
            });
            assertSucceeded(
              objectOf(data.assets, 'the asset mutation').deleteAsset,
              'delete_asset'
            );
            return textResult(`Deleted asset ${asset_id}.`);
          }
        );
      })
  );
}
