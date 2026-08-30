# vhs script for the demo GIF: `vhs docs/demo.tape` writes docs/public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs) and jq on PATH
#   * the server built (npm run build)
#   * a reachable Wiki.js — use the throwaway one, never a real wiki:
#       docker compose -f scripts/sandbox/docker-compose.yml up -d
#       python3 scripts/sandbox/bootstrap.py
#       node scripts/sandbox/smoke.mjs      # also seeds fixtures worth showing
#
# Recording against a real wiki would put its page titles into a public GIF.
# Run vhs from the repository root, not from docs/.
#
# Rules learned the hard way:
#   * inside a Hide block use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * vhs cannot type a string containing both quote characters, and every JSON
#     argument needs both. That is why call.mjs also takes key=value pairs, and
#     why the alias below hides the path to it.
#   * start from the running server; do not record the setup
#
# Three beats: the search that cannot see page text, the one that can, and a
# request refused for being ambiguous rather than guessed at.

Output docs/public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "alias wikijs='node scripts/sandbox/call.mjs 2>/dev/null'" Enter
Type "clear" Enter
Sleep 500ms
Show

Type "# Wiki.js' default search engine indexes titles only, not page text" Enter
Sleep 1500ms
Type "wikijs search_pages query=PINEAPPLE | jq '{totalHits, searchEngine, note}'" Enter
Sleep 5s

Type "" Enter
Type "# grep_pages searches what is actually written in the pages" Enter
Sleep 1500ms
Type "wikijs grep_pages pattern=PINEAPPLE | jq -c '.pages[] | {path, matches}'" Enter
Sleep 6s

Type "" Enter
Type "# and an ambiguous request is refused, never guessed at" Enter
Sleep 1500ms
Type "wikijs get_page path=docs/setup mode=content section=Install | jq -r .error" Enter
Sleep 6s

Sleep 2s
