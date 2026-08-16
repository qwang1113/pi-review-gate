#!/usr/bin/env bash
# Install pi-review-gate git hooks into the current repo (idempotent, worktree-safe).
# Existing hooks are chained, not clobbered. Supports core.hooksPath.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# Resolve THIS script through any symlinks first: npm/npx expose the package
# bin as a node_modules/.bin/* symlink, so dirname "$0" would land in .bin and
# ../hooks would not resolve. Follow the chain to the real file.
resolve_symlink() {
  local src="$1" target
  while [ -L "$src" ]; do
    target="$(readlink "$src")"
    case "$target" in
      /*) src="$target" ;;
      *)  src="$(cd "$(dirname "$src")" && pwd -P)/$target" ;;
    esac
  done
  printf '%s\n' "$src"
}
SELF="$(resolve_symlink "${BASH_SOURCE[0]}")"
HOOKS_SRC="$(cd "$(dirname "$SELF")/../hooks" && pwd)"

# P1-1: use git rev-parse --git-path hooks for worktree/alternate hook dir support.
HOOKS_DST="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS_DST"

MARKER="# pi-review-gate:installed"
# Structured record of the chained original hook. P1 fix: the old extraction
# reverse-engineered the original path from the generated script line with
# `tr -d '" '`, which DELETED spaces inside the path — any original hook in a
# directory containing a space broke the chain on re-install. Now the path is
# recorded verbatim in a marker comment and read back with a single sed.
ORIG_MARKER="# pi-review-gate:original="

for hook in pre-commit pre-push commit-msg; do
  src="$HOOKS_SRC/$hook"
  dst="$HOOKS_DST/$hook"

  # Already installed by us → update without clobbering original.
  if [[ -f "$dst" ]] && grep -q "$MARKER" "$dst" 2>/dev/null; then
    # Preferred: structured marker (exact path, spaces safe). Fallback for
    # hooks written by OLDER installers: the known chained-backup location.
    original=$(sed -n "s|^${ORIG_MARKER}||p" "$dst" | head -1 || true)
    if [[ -z "$original" && -f "$dst.pre-pi-review-gate" ]]; then
      original="$dst.pre-pi-review-gate"
    fi
    if [[ -n "$original" && -f "$original" ]]; then
      # Re-create chain: us → original
      cat > "$dst" <<EOF
#!/usr/bin/env bash
$MARKER
${ORIG_MARKER}${original}
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
${ORIG_MARKER}$dst.pre-pi-review-gate
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
