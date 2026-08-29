#!/bin/sh
# PreToolUse hook: nudges the assistant toward the knowledge graph before it
# starts grepping, and — the part that matters — tells it when the graph it is
# about to trust no longer matches the checkout.
#
# Wired up by .claude/settings.json. `graphify claude install` leaves an
# existing Bash PreToolUse entry alone, so editing this file is safe: the next
# `npm install` will not overwrite it or add a second copy.
#
# Three hard rules, because this runs before every Bash call:
#   1. Always exit 0. A hook that fails must never block a tool call.
#   2. No interpreter beyond /bin/sh. The old version shelled out to python3 to
#      parse the payload, which meant a contributor without python3 on PATH got
#      a hook that silently did nothing — and graphify installs via uv, which
#      does not put python3 on PATH.
#   3. Stay quiet unless there is something to say.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
REPORT="$PROJECT_DIR/graphify-out/GRAPH_REPORT.md"
GRAPH="$PROJECT_DIR/graphify-out/graph.json"

# Match against the whole payload rather than extracting tool_input.command:
# picking one field out of JSON in pure sh means a regex that breaks on escaped
# quotes. A false positive here costs one advisory line, so the trade is easy.
PAYLOAD=$(cat 2>/dev/null || true)

case "$PAYLOAD" in
  *grep*|*ripgrep*|*"rg "*|*"find "*|*"fd "*|*"ack "*|*"ag "*) ;;
  *) exit 0 ;;
esac

emit() {
  # Only ever called with the literal strings below — no quotes, no newlines,
  # nothing that would need JSON escaping.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$1"
  exit 0
}

if [ ! -f "$GRAPH" ]; then
  emit "graphify: no knowledge graph in this checkout. Build it with 'npm run graphify:setup' (about a second, offline, no API key) for a structural map of the codebase, or continue with grep."
fi

# Freshness. The report records the commit it was built from; a mismatch means
# somebody committed without the post-commit hook installed, which is exactly
# what a fresh clone looks like before 'npm run graphify:setup' has run. A stale
# graph is worse than no graph: it reads as authoritative while describing code
# that has since moved.
BUILT=$(sed -n 's/^- Built from commit: `\([0-9a-f]\{7,\}\)`.*/\1/p' "$REPORT" 2>/dev/null | head -1)
HEAD=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)

if [ -n "$BUILT" ] && [ -n "$HEAD" ]; then
  case "$HEAD" in
    "$BUILT"*)
      emit "graphify: knowledge graph is current with HEAD. Read graphify-out/GRAPH_REPORT.md for god nodes and community structure before searching raw files." ;;
    *)
      emit "graphify: the knowledge graph is STALE - it was built from a different commit than HEAD, so treat its symbol locations as unreliable. Run 'graphify update .' (about a second, no API cost) to refresh it, then read graphify-out/GRAPH_REPORT.md." ;;
  esac
fi

emit "graphify: knowledge graph exists. Read graphify-out/GRAPH_REPORT.md for god nodes and community structure before searching raw files."
