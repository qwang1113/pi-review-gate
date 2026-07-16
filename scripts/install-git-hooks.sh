#!/usr/bin/env bash
# Install pi-review-gate git hooks into the current repo (idempotent, worktree-safe).
# Existing hooks are chained, not clobbered. Supports core.hooksPath.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)"

# P1-1: use git rev-parse --git-path hooks for worktree/alternate hook dir support.
HOOKS_DST="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS_DST"

MARKER="# pi-review-gate:installed"

for hook in pre-commit pre-push commit-msg; do
  src="$HOOKS_SRC/$hook"
  dst="$HOOKS_DST/$hook"

  # Already installed by us → update without clobbering original.
  if [[ -f "$dst" ]] && grep -q "$MARKER" "$dst" 2>/dev/null; then
    # Extract the original hook path from the chain.
    original=$(grep -v "$MARKER" "$dst" | grep -v "exec.*$src" | grep -v '^#!/' | grep -v '^set ' | grep '^".*" "\$@"' | sed 's/"\$@"//' | tr -d '" ' || true)
    if [[ -n "$original" && -f "$original" ]]; then
      # Re-create chain: us → original
      cat > "$dst" <<EOF
#!/usr/bin/env bash
$MARKER
set -e
"$src" "\$@"
"$original" "\$@"
EOF
    else
      cat > "$dst" <<EOF
#!/usr/bin/env bash
$MARKER
exec "$src" "\$@"
EOF
    fi
    chmod +x "$dst"
    echo "updated: $dst"
    continue
  fi

  # Existing non-pi hook → chain it.
  if [[ -f "$dst" ]] && [[ -x "$dst" ]]; then
    mv "$dst" "$dst.pre-pi-review-gate"
    cat > "$dst" <<EOF
#!/usr/bin/env bash
$MARKER
set -e
"$src" "\$@"
"$dst.pre-pi-review-gate" "\$@"
EOF
    chmod +x "$dst"
    echo "installed (chained): $dst"
  else
    cat > "$dst" <<EOF
#!/usr/bin/env bash
$MARKER
exec "$src" "\$@"
EOF
    chmod +x "$dst"
    echo "installed: $dst"
  fi
done
