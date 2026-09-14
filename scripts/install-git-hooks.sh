#!/usr/bin/env bash
# Install pi-review-gate git hooks into the current repo (idempotent, worktree-safe).
# Existing hooks are chained, not clobbered. Supports core.hooksPath.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# REFUSE TO RUN FROM A REVIEW SNAPSHOT. `.git/hooks` lives in the COMMON git dir,
# so a linked worktree shares it with the real checkout: installing from inside a
# reviewer's disposable snapshot repoints the REAL repo's hooks at a directory
# that is deleted at the end of the round, and the L3 hook layer then fails on
# every commit (observed exactly once, which is why this guard exists). A
# reviewer has no business installing anything anyway.
case "$REPO_ROOT" in
  */rg-review-snap-*)
    echo "refusing to install hooks from a review snapshot ($REPO_ROOT):" >&2
    echo "  .git/hooks is shared with the real checkout, so this would repoint it at" >&2
    echo "  a directory that disappears when the review round ends." >&2
    echo "  Run it from the real worktree instead." >&2
    exit 1
    ;;
  */rg-orchestration/*)
    # R-28, and this one was an INCIDENT rather than a near miss. An
    # orchestration child works in a gate-created worktree under
    # $TMPDIR/rg-orchestration/…; installing from there repointed the whole
    # repository's shared hooks at that directory, and the moment
    # `orchestrator_close` removed the worktree, EVERY session in the repo
    # lost the ability to commit ("cannot execute: No such file or
    # directory") — including an innocent third child in the middle of a
    # merge, which could not repair itself either, because `.git/hooks` is
    # gate-blocked and reinstalling from its own temp worktree only moves the
    # crater. The repository's hooks belong to the main worktree.
    echo "refusing to install hooks from an orchestration worktree ($REPO_ROOT):" >&2
    echo "  .git/hooks is shared by every linked worktree, so this would point the WHOLE" >&2
    echo "  repository at a temporary directory that is deleted when this child is closed." >&2
    echo "  Run it from the main worktree instead." >&2
    exit 1
    ;;
esac

# A LINKED WORKTREE NEVER INSTALLS (third incident of this class, 2026-09-14).
# The two path checks above only cover layouts WE name. A review round's
# throwaway worktree is named by whoever creates it — a judge running
# `git worktree add $TMPDIR/rgrev-<sha> HEAD` is enough — and installing there
# repointed the real repository's hooks at a directory that vanished with the
# round, so every later commit failed with "No such file or directory" until
# someone reinstalled from the real checkout. `.git/hooks` lives in the COMMON
# git dir, so the rule is topological, not about names or locations: the hooks
# belong to the MAIN worktree, and anything else is refused.
MAIN_WORKTREE="$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1)"
if [ -n "$MAIN_WORKTREE" ]; then
  MAIN_REAL="$(cd "$MAIN_WORKTREE" 2>/dev/null && pwd -P || printf '%s' "$MAIN_WORKTREE")"
  ROOT_REAL="$(cd "$REPO_ROOT" && pwd -P)"
  if [ "$MAIN_REAL" != "$ROOT_REAL" ]; then
    echo "refusing to install hooks from a LINKED worktree ($REPO_ROOT):" >&2
    echo "  .git/hooks is shared with the main worktree ($MAIN_REAL), so installing" >&2
    echo "  here points the whole repository at a directory that disappears with this" >&2
    echo "  one — every later commit then fails with 'No such file or directory'." >&2
    echo "  Run it from the main worktree instead." >&2
    exit 1
  fi
fi


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

# P1-1: use git rev-parse for worktree/alternate hook dir support.
# R-28 (b): resolve the hooks directory in the COMMON git dir, not in this
# worktree's private one — `--git-path hooks` returns a path relative to the
# CURRENT worktree when run from a linked one, and the hooks a repository runs
# live with the common dir. Asking for the common dir explicitly makes the
# destination the same file no matter which worktree runs the installer.
HOOKS_DST="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
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
