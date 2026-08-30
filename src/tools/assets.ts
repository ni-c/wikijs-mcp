import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { assertSucceeded } from '../api.js';
import { identifier } from '../confirm.js';
import * as gql from '../gql/admin.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import { confirmTokenParam, idParam } from '../schema.js';
import type { ToolContext } from './context.js';

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
  .describe('File name including its extension, e.g. "diagram.png".');

export function registerAssetTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_assets',
    {
      title: 'List assets in a folder',
      description:
        'Lists the images and files in one asset folder. Folder 0 is the root. ' +
        'Assets are flat within a folder and Wiki.js has no search across them, ' +
        'so finding one means walking list_asset_folders.',
      inputSchema: {
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
      },
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
      inputSchema: {
        parent_folder_id: idParam
          .or(z.literal(0))
          .optional()
          .describe('Parent folder id. 0 (default) is the root.'),
      },
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
        'a page. Content is passed base64-encoded. Note that Wiki.js 2.x has no ' +
        'GraphQL mutation for this at all — this uses the editor’s own upload ' +
        'route, which is not part of the documented API and could change in a ' +
        'future Wiki.js release.',
      inputSchema: {
        filename: filenameParam,
        content_base64: z
          .string()
          .min(1)
          .max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8)
          .describe('File contents, base64-encoded.'),
        content_type: z
          .string()
          .trim()
          .regex(
            /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i,
            'must be a MIME type such as "image/png"'
          )
          .optional()
          .describe('MIME type (default application/octet-stream).'),
        folder_id: idParam
          .or(z.literal(0))
          .optional()
          .describe('Target folder id. 0 (default) is the root.'),
      },
      annotations: { idempotentHint: false },
    },
    async ({ filename, content_base64, content_type, folder_id }) =>
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

        await api.upload(
          filename,
          content_type ?? 'application/octet-stream',
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
      inputSchema: {
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
      },
      annotations: { idempotentHint: false },
    },
    async ({ parent_folder_id, slug, name }) =>
      run(async () => {
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
      inputSchema: {
        asset_id: idParam.describe('Asset id from list_assets.'),
        filename: filenameParam.describe('New file name, including extension.'),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ asset_id, filename, confirm_token }) =>
      run(async () =>
        guarded(
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
        )
      )
  );

  server.registerTool(
    'delete_asset',
    {
      title: 'Delete a file',
      description:
        'Deletes an asset permanently. Any page embedding it will show a broken ' +
        'image or a dead link. Requires a confirmation token.',
      inputSchema: {
        asset_id: idParam.describe('Asset id from list_assets.'),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ asset_id, confirm_token }) =>
      run(async () =>
        guarded(
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
        )
      )
  );
}
