#!/usr/bin/env bash
# pi-review-gate PER-PROJECT installer — installs into ./.pi/ using the SAME
# layout as the global installer, so the extension's relative imports (./lib/*)
# and resolveTrustedRunner()'s candidate paths both resolve. Run from the target
# repo root (or pass the repo dir as $1).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST_ROOT="${1:-$(pwd)}"
PI_DIR="${DEST_ROOT}/.pi"
INSTALL_DIR="${PI_DIR}/extensions/pi-review-gate"

echo "pi-review-gate (per-project) → ${PI_DIR}"

# 1. Extension + lib under extensions/pi-review-gate/ with an index.ts entry.
rm -rf "${INSTALL_DIR}" 2>/dev/null || true
mkdir -p "${INSTALL_DIR}/lib"
cp "${SRC}/extensions/review-gate.ts" "${INSTALL_DIR}/"
cp "${SRC}/lib/"*.ts "${INSTALL_DIR}/lib/"
cat > "${INSTALL_DIR}/index.ts" <<'EOF'
export { default } from "./review-gate.ts";
EOF
echo "✓ Extension installed to ${INSTALL_DIR}/"

# 2. Trusted runner at .pi/scripts/pi-review-gate-precommit.mjs so that
#    resolveTrustedRunner()'s `here/../../scripts/pi-review-gate-precommit.mjs`
#    candidate (relative to extensions/pi-review-gate/) resolves.
mkdir -p "${PI_DIR}/scripts"
cp "${SRC}/scripts/precommit-runner.mjs" "${PI_DIR}/scripts/pi-review-gate-precommit.mjs"
echo "✓ Trusted precommit runner installed to ${PI_DIR}/scripts/"

# 2b. L6 test-label scanner so the extension's edit-time check resolves it as
#     ../../scripts/scan-test-labels.cjs (relative to extensions/pi-review-gate/).
#     MUST keep the original filename (same rule as the global installer).
cp "${SRC}/scripts/scan-test-labels.cjs" "${PI_DIR}/scripts/scan-test-labels.cjs"
echo "✓ Test-label scanner installed to ${PI_DIR}/scripts/"

# 2c. Staged-divergence checker for the pre-commit hook. MUST keep the original
#     filename (same rule as above).
cp "${SRC}/scripts/check-staged-divergence.cjs" "${PI_DIR}/scripts/check-staged-divergence.cjs"
echo "✓ Staged-divergence checker installed to ${PI_DIR}/scripts/"

# 3. Skill.
mkdir -p "${PI_DIR}/skills/pi-review-gate"
cp "${SRC}/skills/review-loop/SKILL.md" "${PI_DIR}/skills/pi-review-gate/SKILL.md" 2>/dev/null || true
echo "✓ Review-loop skill installed"

echo ""
echo "Done. Restart Pi or run /reload to activate for this project."
