# Getting started

## Requirements

- Node.js ≥ 22
- A running Wiki.js instance
- An API token with the scopes listed under [Configuration](/guide/configuration)

## Run it

```sh
WIKIJS_URL=https://wiki.example.com WIKIJS_TOKEN=… npx -y @ni-c/wikijs-mcp
```

Without credentials the server still starts and lists its tools; every call then
fails with setup instructions instead of reaching the API.
