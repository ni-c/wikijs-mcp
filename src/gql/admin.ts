/** GraphQL documents for assets, comments, users, groups and the system surface. */

const RESPONSE_RESULT = 'responseResult { succeeded errorCode slug message }';

/* -------------------------------------------------------------- assets -- */

export const LIST_ASSETS = `
  query ListAssets($folderId: Int!, $kind: AssetKind!) {
    assets {
      list(folderId: $folderId, kind: $kind) {
        id
        filename
        ext
        kind
        mime
        fileSize
        createdAt
        updatedAt
        folder { id slug name }
      }
    }
  }
`;

export const LIST_ASSET_FOLDERS = `
  query ListAssetFolders($parentFolderId: Int!) {
    assets { folders(parentFolderId: $parentFolderId) { id slug name } }
  }
`;

export const CREATE_ASSET_FOLDER = `
  mutation CreateAssetFolder($parentFolderId: Int!, $slug: String!, $name: String) {
    assets {
      createFolder(parentFolderId: $parentFolderId, slug: $slug, name: $name) {
        ${RESPONSE_RESULT}
      }
    }
  }
`;

export const RENAME_ASSET = `
  mutation RenameAsset($id: Int!, $filename: String!) {
    assets { renameAsset(id: $id, filename: $filename) { ${RESPONSE_RESULT} } }
  }
`;

export const DELETE_ASSET = `
  mutation DeleteAsset($id: Int!) {
    assets { deleteAsset(id: $id) { ${RESPONSE_RESULT} } }
  }
`;

/* ------------------------------------------------------------ comments -- */

export const LIST_COMMENTS = `
  query ListComments($locale: String!, $path: String!) {
    comments {
      list(locale: $locale, path: $path) {
        id
        content
        render
        authorId
        authorName
        createdAt
        updatedAt
      }
    }
  }
`;

export const GET_COMMENT = `
  query GetComment($id: Int!) {
    comments {
      single(id: $id) {
        id
        content
        render
        authorId
        authorName
        createdAt
        updatedAt
      }
    }
  }
`;

export const CREATE_COMMENT = `
  mutation CreateComment($pageId: Int!, $replyTo: Int, $content: String!) {
    comments {
      create(pageId: $pageId, replyTo: $replyTo, content: $content) {
        ${RESPONSE_RESULT}
        id
      }
    }
  }
`;

export const UPDATE_COMMENT = `
  mutation UpdateComment($id: Int!, $content: String!) {
    comments { update(id: $id, content: $content) { ${RESPONSE_RESULT} } }
  }
`;

export const DELETE_COMMENT = `
  mutation DeleteComment($id: Int!) {
    comments { delete(id: $id) { ${RESPONSE_RESULT} } }
  }
`;

/* --------------------------------------------------------------- users -- */

export const LIST_USERS = `
  query ListUsers($filter: String, $orderBy: String) {
    users {
      list(filter: $filter, orderBy: $orderBy) {
        id
        name
        email
        providerKey
        isSystem
        isActive
        createdAt
        lastLoginAt
      }
    }
  }
`;

/**
 * Only id, name, email and providerKey.
 *
 * `UserMinimal` also declares `isSystem` and `isActive` as non-null, but the
 * search resolver never selects them from the database — so asking for either
 * fails the whole query with "Cannot return null for non-nullable field". Use
 * LIST_USERS or GET_USER when those flags are needed; both populate them.
 */
export const SEARCH_USERS = `
  query SearchUsers($query: String!) {
    users {
      search(query: $query) { id name email providerKey }
    }
  }
`;

export const GET_USER = `
  query GetUser($id: Int!) {
    users {
      single(id: $id) {
        id
        name
        email
        providerKey
        providerName
        isSystem
        isActive
        isVerified
        location
        jobTitle
        timezone
        createdAt
        updatedAt
        lastLoginAt
        tfaIsActive
        groups { id name }
      }
    }
  }
`;

export const CREATE_USER = `
  mutation CreateUser(
    $email: String!
    $name: String!
    $passwordRaw: String
    $providerKey: String!
    $groups: [Int]!
    $mustChangePassword: Boolean
    $sendWelcomeEmail: Boolean
  ) {
    users {
      create(
        email: $email
        name: $name
        passwordRaw: $passwordRaw
        providerKey: $providerKey
        groups: $groups
        mustChangePassword: $mustChangePassword
        sendWelcomeEmail: $sendWelcomeEmail
      ) {
        ${RESPONSE_RESULT}
        user { id name email }
      }
    }
  }
`;

export const UPDATE_USER = `
  mutation UpdateUser(
    $id: Int!
    $email: String
    $name: String
    $groups: [Int]
    $location: String
    $jobTitle: String
  ) {
    users {
      update(
        id: $id
        email: $email
        name: $name
        groups: $groups
        location: $location
        jobTitle: $jobTitle
      ) {
        ${RESPONSE_RESULT}
      }
    }
  }
`;

export const DELETE_USER = `
  mutation DeleteUser($id: Int!, $replaceId: Int!) {
    users { delete(id: $id, replaceId: $replaceId) { ${RESPONSE_RESULT} } }
  }
`;

export const ACTIVATE_USER = `
  mutation ActivateUser($id: Int!) { users { activate(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const DEACTIVATE_USER = `
  mutation DeactivateUser($id: Int!) { users { deactivate(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const VERIFY_USER = `
  mutation VerifyUser($id: Int!) { users { verify(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const ENABLE_TFA = `
  mutation EnableTfa($id: Int!) { users { enableTFA(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const DISABLE_TFA = `
  mutation DisableTfa($id: Int!) { users { disableTFA(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const RESET_PASSWORD = `
  mutation ResetPassword($id: Int!) { users { resetPassword(id: $id) { ${RESPONSE_RESULT} } } }
`;

/* -------------------------------------------------------------- groups -- */

export const LIST_GROUPS = `
  query ListGroups($filter: String, $orderBy: String) {
    groups {
      list(filter: $filter, orderBy: $orderBy) {
        id
        name
        isSystem
        userCount
        createdAt
        updatedAt
      }
    }
  }
`;

export const GET_GROUP = `
  query GetGroup($id: Int!) {
    groups {
      single(id: $id) {
        id
        name
        isSystem
        redirectOnLogin
        permissions
        pageRules { id deny match roles path locales }
        users { id name email isActive }
        createdAt
        updatedAt
      }
    }
  }
`;

export const CREATE_GROUP = `
  mutation CreateGroup($name: String!) {
    groups { create(name: $name) { ${RESPONSE_RESULT} group { id name } } }
  }
`;

export const UPDATE_GROUP = `
  mutation UpdateGroup(
    $id: Int!
    $name: String!
    $redirectOnLogin: String!
    $permissions: [String]!
    $pageRules: [PageRuleInput]!
  ) {
    groups {
      update(
        id: $id
        name: $name
        redirectOnLogin: $redirectOnLogin
        permissions: $permissions
        pageRules: $pageRules
      ) {
        ${RESPONSE_RESULT}
      }
    }
  }
`;

export const DELETE_GROUP = `
  mutation DeleteGroup($id: Int!) { groups { delete(id: $id) { ${RESPONSE_RESULT} } } }
`;

export const ASSIGN_USER = `
  mutation AssignUser($groupId: Int!, $userId: Int!) {
    groups { assignUser(groupId: $groupId, userId: $userId) { ${RESPONSE_RESULT} } }
  }
`;

export const UNASSIGN_USER = `
  mutation UnassignUser($groupId: Int!, $userId: Int!) {
    groups { unassignUser(groupId: $groupId, userId: $userId) { ${RESPONSE_RESULT} } }
  }
`;

/* -------------------------------------------------------------- system -- */

/**
 * Site and system information.
 *
 * The fields that describe the host filesystem and internal network —
 * `configFile`, `workingDirectory`, `dbHost` — are deliberately *not* requested.
 * The redaction layer would blank them anyway; not asking is one fewer place
 * they can leak from.
 */
export const SITE_INFO = `
  query SiteInfo {
    site { config { host title description company contentLicense featurePageComments featurePageRatings } }
    system {
      info {
        currentVersion
        latestVersion
        latestVersionReleaseDate
        dbType
        dbVersion
        nodeVersion
        operatingSystem
        platform
        cpuCores
        ramTotal
        pagesTotal
        usersTotal
        groupsTotal
        tagsTotal
        httpsPort
        sslStatus
        sslExpirationDate
        upgradeCapable
        telemetry
      }
    }
  }
`;

export const LIST_LOCALES = `
  query ListLocales {
    localization {
      locales { code name nativeName isInstalled isRTL availability }
      config { locale namespacing namespaces }
    }
  }
`;

export const NAVIGATION_TREE = `
  query NavigationTree {
    navigation {
      config { mode }
      tree {
        locale
        items { id kind label icon targetType target visibilityMode visibilityGroups }
      }
    }
  }
`;

export const LIST_SEARCH_ENGINES = `
  query ListSearchEngines {
    search { searchEngines { key title description isEnabled isAvailable } }
  }
`;

export const REBUILD_SEARCH_INDEX = `
  mutation RebuildSearchIndex { search { rebuildIndex { ${RESPONSE_RESULT} } } }
`;

export const LIST_API_KEYS = `
  query ListApiKeys {
    authentication {
      apiState
      apiKeys { id name keyShort expiration createdAt updatedAt isRevoked }
    }
  }
`;

export const REVOKE_API_KEY = `
  mutation RevokeApiKey($id: Int!) {
    authentication { revokeApiKey(id: $id) { ${RESPONSE_RESULT} } }
  }
`;

export const SET_API_STATE = `
  mutation SetApiState($enabled: Boolean!) {
    authentication { setApiState(enabled: $enabled) { ${RESPONSE_RESULT} } }
  }
`;

export const LIST_STORAGE_TARGETS = `
  query ListStorageTargets {
    storage {
      targets {
        key
        title
        description
        isAvailable
        isEnabled
        mode
        supportedModes
        hasSchedule
        syncInterval
        config { key value }
      }
      status { key title status message lastAttempt }
    }
  }
`;
