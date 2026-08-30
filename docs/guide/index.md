# What is wikijs-mcp?

Search, read and edit Wiki.js pages, and manage its assets, users, groups and comments

## Why

Because a wiki is where the answers already are, and getting at them through a browser breaks the thread. This server puts the wiki in reach of the client you are already working in — and does the two things that turn out to matter most once you try it: finding text that the built-in search cannot see, and not quietly overwriting somebody else while you do.

## What it is not

- **Wiki.js 3.x.** Still alpha with no release date, and its GraphQL schema is being flattened to root-level operations. This targets 2.x; the documents live in `src/gql/` so a 3.0 adapter is a new module rather than a rewrite.
- **Minting API keys.** Wiki.js can do it over GraphQL and this server deliberately cannot: a model able to create a full-access key could grant itself administrative access outliving the session. Revoking and listing keys are here.
- **Editing the navigation menu.** Wiki.js replaces the whole tree in one mutation, and a partial answer from a model would silently delete the rest.
