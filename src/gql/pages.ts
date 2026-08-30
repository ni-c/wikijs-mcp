/**
 * GraphQL documents for the page surface.
 *
 * Kept apart from the tool code for one reason beyond tidiness: Wiki.js 3.0
 * flattens the schema to root-level operations (`pages.single` becomes
 * `pageById`), so when it eventually ships, the port is a second file in this
 * directory rather than a rewrite of every tool.
 *
 * `Page.content` sits in its own document on purpose. It is gated behind the
 * `read:source` scope, and a field-level refusal fails the *whole* query — so a
 * key that may list pages but not read their source would otherwise be unable
 * to fetch even a page's title.
 */

export const PAGE_METADATA_FIELDS = `
  id
  path
  locale
  title
  description
  contentType
  editor
  isPublished
  isPrivate
  publishStartDate
  publishEndDate
  createdAt
  updatedAt
  authorId
  authorName
  creatorId
  creatorName
  tags { tag title }
`;

export const GET_PAGE_METADATA = `
  query GetPageMetadata($id: Int!) {
    pages { single(id: $id) { ${PAGE_METADATA_FIELDS} } }
  }
`;

export const GET_PAGE_METADATA_BY_PATH = `
  query GetPageMetadataByPath($path: String!, $locale: String!) {
    pages { singleByPath(path: $path, locale: $locale) { ${PAGE_METADATA_FIELDS} } }
  }
`;

export const GET_PAGE_CONTENT = `
  query GetPageContent($id: Int!) {
    pages { single(id: $id) { id path locale contentType content } }
  }
`;

export const GET_PAGE_RENDER = `
  query GetPageRender($id: Int!) {
    pages { single(id: $id) { id path locale render } }
  }
`;

export const LIST_PAGES = `
  query ListPages(
    $limit: Int
    $orderBy: PageOrderBy
    $orderByDirection: PageOrderByDirection
    $tags: [String!]
    $locale: String
    $creatorId: Int
    $authorId: Int
  ) {
    pages {
      list(
        limit: $limit
        orderBy: $orderBy
        orderByDirection: $orderByDirection
        tags: $tags
        locale: $locale
        creatorId: $creatorId
        authorId: $authorId
      ) {
        id
        path
        locale
        title
        description
        contentType
        isPublished
        isPrivate
        createdAt
        updatedAt
        tags
      }
    }
  }
`;

export const SEARCH_PAGES = `
  query SearchPages($query: String!, $path: String, $locale: String) {
    pages {
      search(query: $query, path: $path, locale: $locale) {
        totalHits
        suggestions
        results { id title description path locale }
      }
    }
  }
`;

export const PAGE_TREE = `
  query PageTree($path: String, $parent: Int, $mode: PageTreeMode!, $locale: String!, $includeAncestors: Boolean) {
    pages {
      tree(path: $path, parent: $parent, mode: $mode, locale: $locale, includeAncestors: $includeAncestors) {
        id
        path
        depth
        title
        isPrivate
        isFolder
        parent
        pageId
        locale
      }
    }
  }
`;

export const PAGE_LINKS = `
  query PageLinks($locale: String!) {
    pages { links(locale: $locale) { id path title links } }
  }
`;

export const PAGE_HISTORY = `
  query PageHistory($id: Int!, $offsetPage: Int, $offsetSize: Int) {
    pages {
      history(id: $id, offsetPage: $offsetPage, offsetSize: $offsetSize) {
        total
        trail {
          versionId
          versionDate
          authorId
          authorName
          actionType
          valueBefore
          valueAfter
        }
      }
    }
  }
`;

export const PAGE_VERSION = `
  query PageVersion($pageId: Int!, $versionId: Int!) {
    pages {
      version(pageId: $pageId, versionId: $versionId) {
        versionId
        versionDate
        action
        authorId
        authorName
        path
        locale
        title
        description
        editor
        contentType
        isPublished
        tags
        content
      }
    }
  }
`;

export const CHECK_CONFLICTS = `
  query CheckConflicts($id: Int!, $checkoutDate: Date!) {
    pages { checkConflicts(id: $id, checkoutDate: $checkoutDate) }
  }
`;

export const CONFLICT_LATEST = `
  query ConflictLatest($id: Int!) {
    pages {
      conflictLatest(id: $id) {
        id
        authorId
        authorName
        path
        locale
        title
        description
        isPublished
        updatedAt
        createdAt
        tags
      }
    }
  }
`;

export const LIST_TAGS = `
  query ListTags { pages { tags { id tag title createdAt updatedAt } } }
`;

export const SEARCH_TAGS = `
  query SearchTags($query: String!) { pages { searchTags(query: $query) } }
`;

const RESPONSE_RESULT = 'responseResult { succeeded errorCode slug message }';

export const CREATE_PAGE = `
  mutation CreatePage(
    $content: String!
    $description: String!
    $editor: String!
    $isPublished: Boolean!
    $isPrivate: Boolean!
    $locale: String!
    $path: String!
    $tags: [String]!
    $title: String!
  ) {
    pages {
      create(
        content: $content
        description: $description
        editor: $editor
        isPublished: $isPublished
        isPrivate: $isPrivate
        locale: $locale
        path: $path
        tags: $tags
        title: $title
      ) {
        ${RESPONSE_RESULT}
        # No locale field here. Wiki.js leaves it unset on the Page it returns
        # from create and update, and the field is non-nullable, so selecting it
        # turns a write that actually succeeded into
        # "Cannot return null for non-nullable field Page.locale".
        page { id path title updatedAt }
      }
    }
  }
`;

export const UPDATE_PAGE = `
  mutation UpdatePage(
    $id: Int!
    $content: String
    $description: String
    $editor: String
    $isPublished: Boolean
    $isPrivate: Boolean
    $tags: [String]
    $title: String
  ) {
    pages {
      update(
        id: $id
        content: $content
        description: $description
        editor: $editor
        isPublished: $isPublished
        isPrivate: $isPrivate
        tags: $tags
        title: $title
      ) {
        ${RESPONSE_RESULT}
        # No locale field here. Wiki.js leaves it unset on the Page it returns
        # from create and update, and the field is non-nullable, so selecting it
        # turns a write that actually succeeded into
        # "Cannot return null for non-nullable field Page.locale".
        page { id path title updatedAt }
      }
    }
  }
`;

export const MOVE_PAGE = `
  mutation MovePage($id: Int!, $destinationPath: String!, $destinationLocale: String!) {
    pages {
      move(id: $id, destinationPath: $destinationPath, destinationLocale: $destinationLocale) {
        ${RESPONSE_RESULT}
      }
    }
  }
`;

export const DELETE_PAGE = `
  mutation DeletePage($id: Int!) { pages { delete(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const CONVERT_PAGE = `
  mutation ConvertPage($id: Int!, $editor: String!) {
    pages { convert(id: $id, editor: $editor) { ${RESPONSE_RESULT} } }
  }
`;

export const RESTORE_VERSION = `
  mutation RestoreVersion($pageId: Int!, $versionId: Int!) {
    pages { restore(pageId: $pageId, versionId: $versionId) { ${RESPONSE_RESULT} } }
  }
`;

export const PURGE_HISTORY = `
  mutation PurgeHistory($olderThan: String!) {
    pages { purgeHistory(olderThan: $olderThan) { ${RESPONSE_RESULT} } }
  }
`;

export const UPDATE_TAG = `
  mutation UpdateTag($id: Int!, $tag: String!, $title: String!) {
    pages { updateTag(id: $id, tag: $tag, title: $title) { ${RESPONSE_RESULT} } }
  }
`;

export const DELETE_TAG = `
  mutation DeleteTag($id: Int!) { pages { deleteTag(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const RENDER_PAGE = `
  mutation RenderPage($id: Int!) { pages { render(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const FLUSH_CACHE = `
  mutation FlushCache { pages { flushCache { ${RESPONSE_RESULT} } } }
`;

export const REBUILD_TREE = `
  mutation RebuildTree { pages { rebuildTree { ${RESPONSE_RESULT} } } }
`;

export const MIGRATE_LOCALE = `
  mutation MigrateLocale($sourceLocale: String!, $targetLocale: String!) {
    pages {
      migrateToLocale(sourceLocale: $sourceLocale, targetLocale: $targetLocale) {
        ${RESPONSE_RESULT}
        count
      }
    }
  }
`;
