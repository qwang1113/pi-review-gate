#!/usr/bin/env bash
# pi-review-gate global installer — installs extension+lib to ~/.pi/agent/
# Flat structure: review-gate.ts + lib/ side by side in extensions/pi-review-gate/
# Pi discovers pi-review-gate/ via index.ts (directory entry point pattern).
set -euo pipefail

# P1: cross-platform sed (macOS requires '' after -i, GNU does not)
sed_i() { if sed --version 2>/dev/null | grep -q GNU; then sed -i "$@"; else sed -i '' "$@"; fi; }

# Resolve THIS script through any symlinks first. npm installs the bin as a
# node_modules/.bin/* symlink pointing at ../<pkg>/scripts/install-global.sh;
# cd-ing to the symlink's own dirname/.. lands in node_modules, NOT the package
# root. Follow the link chain to the real file, then take its dir/.. .
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
SRC="$(cd "$(dirname "$SELF")/.." && pwd -P)"  # package root (scripts/ -> ..)
AGENT_DIR="${HOME}/.pi/agent"
INSTALL_DIR="${AGENT_DIR}/extensions/pi-review-gate"

echo "pi-review-gate v$(node -e "console.log(JSON.parse(require('fs').readFileSync('${SRC}/package.json','utf8')).version)" 2>/dev/null || echo "?")"
echo ""

# 1. Install extension + lib in pi-review-gate/ directory with index.ts entry point
rm -rf "${INSTALL_DIR}" 2>/dev/null || true
mkdir -p "${INSTALL_DIR}/lib"
cp "${SRC}/extensions/review-gate.ts" "${INSTALL_DIR}/"
cp "${SRC}/lib/"*.ts "${INSTALL_DIR}/lib/"

# Pi auto-discovers directories with index.ts
cat > "${INSTALL_DIR}/index.ts" <<'EOF'
export { default } from "./review-gate.ts";
EOF

echo "✓ Extension installed to ${INSTALL_DIR}/"

# 1b. Install the pdw runtime (REQUIRED — the engine ships with the extension).
# @quintinshaw/pi-dynamic-workflows must resolve from the extension directory;
# the parallel loop has NO serial fallback, so a failed install is a failed
# install: the gate's parallel tools will report a clear error until this works.
if ! command -v npm >/dev/null 2>&1; then
  echo "✗ npm not found — cannot install the required pdw runtime." >&2
  echo "  Install Node.js/npm and re-run this installer." >&2
  exit 1
fi
if ! (cd "${INSTALL_DIR}" && npm install --no-audit --no-fund --loglevel=error \
    @quintinshaw/pi-dynamic-workflows@^3.5.1 @earendil-works/pi-ai@^0.84.1) \
    >/dev/null; then
  echo "✗ pdw runtime install FAILED — the parallel loop cannot run without it." >&2
  echo "  Re-run this installer (it retries the npm install), or run:" >&2
  echo "  (cd ${INSTALL_DIR} && npm install @quintinshaw/pi-dynamic-workflows@^3.5.1 @earendil-works/pi-ai@^0.84.1)" >&2
  exit 1
fi
echo "✓ pdw runtime installed (parallel loop engine ready)"

# 2. Copy skills
mkdir -p "${AGENT_DIR}/skills/pi-review-gate"
cp "${SRC}/skills/review-loop/SKILL.md" "${AGENT_DIR}/skills/pi-review-gate/SKILL.md" 2>/dev/null || true
echo "✓ Review-loop skill installed"

# 2b. Install the subagents — adviser/reviewer/arbiter (gate roles) plus
# planner/worker/module-reviewer (the /decompose orchestration roles), ALWAYS
# overwritten with the shipped version (same policy as the extension/skill/
# scripts above: the repo is the single source of truth). Customize by editing
# the repo's agents/*.md and re-running this installer, not the installed copies.
mkdir -p "${AGENT_DIR}/agents"
# Clean up state from the removed three-way-merge updater (older installs).
rm -rf "${AGENT_DIR}/agents/.pi-review-gate-shipped" 2>/dev/null || true
for a in adviser reviewer arbiter planner worker module-reviewer; do
  SRC_AGENT="${SRC}/agents/${a}.md"
  [ -f "${SRC_AGENT}" ] || continue
  cp "${SRC_AGENT}" "${AGENT_DIR}/agents/${a}.md"
  echo "✓ ${a} subagent installed (overwritten with shipped version)"
done

# 2c. Install the opt-in leaderboard fetcher (gate-external, network) + ranking lib.
mkdir -p "${AGENT_DIR}/scripts"
cp "${SRC}/scripts/fetch-leaderboard.mjs" "${AGENT_DIR}/scripts/pi-review-gate-fetch-leaderboard.mjs"
echo "✓ Leaderboard fetcher installed (run manually to refresh model scores)"

# 3. Precommit runner + the modules it imports.
#
# precommit-plan.mjs / precommit-cache.mjs MUST keep their original filenames:
# the runner imports them by relative specifier, so a pi-review-gate-* rename
# would make every run crash on startup (which the extension reports as a
# fail-closed ERROR — no PASS, no commits).
mkdir -p "${AGENT_DIR}/scripts"
cp "${SRC}/scripts/precommit-runner.mjs" "${AGENT_DIR}/scripts/pi-review-gate-precommit.mjs"
cp "${SRC}/scripts/precommit-plan.mjs" "${AGENT_DIR}/scripts/precommit-plan.mjs"
cp "${SRC}/scripts/precommit-config.mjs" "${AGENT_DIR}/scripts/precommit-config.mjs"
cp "${SRC}/scripts/precommit-cache.mjs" "${AGENT_DIR}/scripts/precommit-cache.mjs"
echo "✓ Precommit runner installed"

# 3b. Fingerprint script for git hooks. MUST keep the original filename
# (compute-fingerprint.cjs): the installed hooks resolve it relative to their
# own dir as ../scripts/compute-fingerprint.cjs, so a pi-review-gate-* rename
# would break the hook lookup and fail every commit closed.
cp "${SRC}/scripts/compute-fingerprint.cjs" "${AGENT_DIR}/scripts/compute-fingerprint.cjs"
echo "✓ Fingerprint script installed"

# 3c. Test-label English scanner for git hooks. MUST keep the original filename
# (scan-test-labels.cjs): the installed pre-commit resolves it relative to its
# own dir as ../scripts/scan-test-labels.cjs. A rename would silently disable
# the L6 gate.
cp "${SRC}/scripts/scan-test-labels.cjs" "${AGENT_DIR}/scripts/scan-test-labels.cjs"
echo "✓ Test-label scanner installed"

# 3d. Staged-divergence checker. MUST keep the original filename
# (check-staged-divergence.cjs): the installed pre-commit resolves it as
# ../scripts/check-staged-divergence.cjs relative to its own dir. A rename
# would silently disable the staged-vs-reviewed gate.
cp "${SRC}/scripts/check-staged-divergence.cjs" "${AGENT_DIR}/scripts/check-staged-divergence.cjs"
echo "✓ Staged-divergence checker installed"

# 4. Hook installer + git hooks (NOT in ~/.pi/agent/hooks — Pi deprecated that dir)
mkdir -p "${AGENT_DIR}/scripts"
cp "${SRC}/hooks/"* "${AGENT_DIR}/scripts/"
cp "${SRC}/scripts/install-git-hooks.sh" "${AGENT_DIR}/scripts/pi-review-gate-install-hooks.sh"
sed_i "s#HOOKS_SRC=.*#HOOKS_SRC=\"${AGENT_DIR}/scripts\"#" "${AGENT_DIR}/scripts/pi-review-gate-install-hooks.sh"
# Clean up stale hooks/ dir from older installer versions
rm -rf "${AGENT_DIR}/hooks/pi-review-gate" 2>/dev/null || true

echo ""
echo "Done. Restart Pi or run /reload to activate."
echo "Install git hooks per repo:"
echo "  bash ${AGENT_DIR}/scripts/pi-review-gate-install-hooks.sh"
