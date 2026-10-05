#!/usr/bin/env bash
# IF-07c reproduction pack — maintainer clean-room rehearsal
#
# Simulates what a third-party outsider does starting only from the public
# release archive. Run this from any directory — it does NOT use the local
# working tree for pack files.
#
# Purpose: maintainer self-audit ONLY.
# This is NOT independent reproduction; it does not replace external runs.
#
# Usage:
#   ./scripts/outsider-repro.sh [--tag v1.0.2] [--commit <sha>]
#   ./scripts/outsider-repro.sh --commit-only <sha>   # verify candidate before tag exists
#   ./scripts/outsider-repro.sh --local               # skip git clone, use current tree
#
# Requires: git, node, npm, curl, shasum (or sha256sum), jq

set -euo pipefail

REPO_URL="https://github.com/WasmAgent/if07c-reproduction"
DEFAULT_TAG="v1.0.2"
TAG="$DEFAULT_TAG"
COMMIT_SHA=""
COMMIT_ONLY=false
LOCAL_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --commit) COMMIT_SHA="$2"; shift 2;;
    --commit-only) COMMIT_SHA="$2"; COMMIT_ONLY=true; shift 2;;
    --local) LOCAL_MODE=true; shift;;
    *) echo "Unknown argument: $1" >&2; exit 2;;
  esac
done

if $COMMIT_ONLY && [[ -z "$COMMIT_SHA" ]]; then
  echo "--commit-only requires a SHA argument" >&2
  exit 2
fi

# ── Platform helpers ────────────────────────────────────────────────────────────

sha256sum_file() {
  if command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

PASS=0
FAIL=0

result() {
  local label="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "ok" ]]; then
    echo "  PASS  $label${detail:+  ($detail)}"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $label${detail:+  ($detail)}"
    FAIL=$((FAIL+1))
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "# IF-07c outsider reproduction rehearsal"
echo "# Work directory: $WORK"
echo ""

# ── 1. Obtain release archive ──────────────────────────────────────────────────────

echo "[1] Obtain release archive"

CLONE_DIR="$WORK/pack"

if $LOCAL_MODE; then
  # Use the current repo (for CI or when already cloned)
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PACK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  CLONE_DIR="$PACK_ROOT"
  result "local mode" ok "using $PACK_ROOT"
elif $COMMIT_ONLY; then
  # Clone without --branch to verify a candidate SHA before a tag exists
  echo "  Cloning $REPO_URL at candidate $COMMIT_SHA (no tag required) …"
  git clone "$REPO_URL" "$CLONE_DIR" 2>&1 | sed 's/^/  /'
  git -C "$CLONE_DIR" checkout "$COMMIT_SHA" 2>&1 | sed 's/^/  /'
  result "git clone + checkout" ok "$COMMIT_SHA"
else
  echo "  Cloning $REPO_URL …"
  git clone --depth 1 --branch "$TAG" "$REPO_URL" "$CLONE_DIR" 2>&1 | sed 's/^/  /'
  result "git clone" ok "$TAG"
fi

cd "$CLONE_DIR"

# ── 2. Verify tag/commit identity ────────────────────────────────────────────────

echo ""
echo "[2] Verify tag/commit identity"

if ! $LOCAL_MODE; then
  ACTUAL_COMMIT="$(git rev-parse HEAD)"
  echo "  HEAD commit: $ACTUAL_COMMIT"
  if [[ -n "$COMMIT_SHA" ]]; then
    if [[ "$ACTUAL_COMMIT" == "$COMMIT_SHA" ]]; then
      result "commit matches expected" ok "$ACTUAL_COMMIT"
    else
      result "commit matches expected" fail "expected $COMMIT_SHA, got $ACTUAL_COMMIT"
    fi
  else
    result "commit recorded" ok "$ACTUAL_COMMIT"
  fi
fi

NODE_VER="$(node --version)"
NPM_VER="$(npm --version)"
OS_INFO="$(uname -s -r -m)"
echo "  node: $NODE_VER"
echo "  npm:  $NPM_VER"
echo "  os:   $OS_INFO"

# ── 3. Verify ARTIFACTS files ──────────────────────────────────────────────────────

echo ""
echo "[3] Verify ARTIFACTS.json manifest"

if [[ ! -f ARTIFACTS.json ]]; then
  echo "  FATAL: ARTIFACTS.json not found"
  exit 1
fi

ARTIFACTS="$(cat ARTIFACTS.json)"

FILES_COUNT=0
HASH_PASS=0
HASH_FAIL=0

while IFS='=' read -r relpath expected_hash; do
  FILES_COUNT=$((FILES_COUNT+1))
  if [[ ! -f "$relpath" ]]; then
    result "exists: $relpath" fail "missing"
    HASH_FAIL=$((HASH_FAIL+1))
    continue
  fi
  actual_hash="$(sha256sum_file "$relpath")"
  if [[ "$actual_hash" == "$expected_hash" ]]; then
    result "hash: $relpath" ok
    HASH_PASS=$((HASH_PASS+1))
  else
    result "hash: $relpath" fail "expected ${expected_hash:0:12}… got ${actual_hash:0:12}…"
    HASH_FAIL=$((HASH_FAIL+1))
  fi
done < <(node - <<'JS'
const a = JSON.parse(require("fs").readFileSync("ARTIFACTS.json","utf8"));
for (const [k,v] of Object.entries(a.files??{})) process.stdout.write(k+"="+v+"\n");
JS
)

echo "  Files checked: $FILES_COUNT  passed: $HASH_PASS  failed: $HASH_FAIL"

# ── 4. Independently fetch registry metadata ────────────────────────────────────────

echo ""
echo "[4] Registry metadata verification"

node - <<'JS'
const a = JSON.parse(require("fs").readFileSync("ARTIFACTS.json","utf8"));
const {execFileSync} = require("child_process");
for (const [name, p] of Object.entries(a.packages??{})) {
  if (!p.version) { console.log(`  SKIP  ${name}: no version`); continue; }
  let live;
  try {
    live = execFileSync("npm",["view",`${name}@${p.version}`,"dist.integrity"],{encoding:"utf8"}).trim();
  } catch(e) {
    console.log(`  FAIL  registry integrity fetch: ${name}: ${e.message}`);
    continue;
  }
  if (live === p.integrity) {
    console.log(`  PASS  registry integrity: ${name}@${p.version}`);
  } else {
    console.log(`  FAIL  registry integrity: ${name}@${p.version}  expected ${p.integrity.slice(0,20)}… got ${live.slice(0,20)}…`);
  }
}
JS

# ── 5. Independently download and verify tarballs ─────────────────────────────────

echo ""
echo "[5] Tarball SHA256 verification"

TARBALL_TMP="$WORK/tarballs"
mkdir -p "$TARBALL_TMP"

node - "$TARBALL_TMP" <<'JS'
const [,,tarDir] = process.argv;
const a = JSON.parse(require("fs").readFileSync("ARTIFACTS.json","utf8"));
const {spawnSync} = require("child_process");
const {createHash} = require("crypto");
const {readFileSync,readdirSync,rmSync} = require("fs");
const {join} = require("path");
for (const [name,p] of Object.entries(a.packages??{})) {
  if (!p.version) continue;
  try {
    spawnSync("npm",["pack",`${name}@${p.version}`,"--pack-destination",tarDir],{stdio:"pipe"});
    const files = readdirSync(tarDir).filter(f=>f.endsWith(".tgz"));
    if (!files.length) { console.log(`  FAIL  tarball pack: ${name}: no file produced`); continue; }
    const tgz = files[0];
    const hash = createHash("sha256").update(readFileSync(join(tarDir,tgz))).digest("hex");
    rmSync(join(tarDir,tgz),{force:true});
    if (hash === p.tarballSha256) {
      console.log(`  PASS  tarball sha256: ${name}@${p.version}`);
    } else {
      console.log(`  FAIL  tarball sha256: ${name}@${p.version}  expected ${p.tarballSha256.slice(0,12)}… got ${hash.slice(0,12)}…`);
    }
  } catch(e) {
    console.log(`  FAIL  tarball sha256: ${name}: ${e.message}`);
  }
}
JS

# ── 6. Install exact dependencies (clean) ────────────────────────────────────────

echo ""
echo "[6] Clean dependency install"

INSTALL_TMP="$WORK/install"
mkdir -p "$INSTALL_TMP"

INSTALL_ARGS="$(node -e "
const a=JSON.parse(require('fs').readFileSync('ARTIFACTS.json','utf8'));
console.log(Object.entries(a.packages??{}).filter(([,p])=>p.version).map(([n,p])=>n+'@'+p.version).join(' '));
")"

echo "  Installing: $INSTALL_ARGS"
(
  cd "$INSTALL_TMP"
  npm init -y >/dev/null 2>&1
  npm install --ignore-scripts $INSTALL_ARGS 2>&1 | tail -3 | sed 's/^/  /'
)
result "clean npm install" ok

# Verify resolved versions
node - "$INSTALL_TMP" <<'JS'
const [,,instDir] = process.argv;
const a = JSON.parse(require("fs").readFileSync("ARTIFACTS.json","utf8"));
const {readFileSync,existsSync} = require("fs");
const {join} = require("path");
for (const [name,p] of Object.entries(a.packages??{})) {
  if (!p.version) continue;
  const pkgPath = join(instDir,"node_modules",name,"package.json");
  if (!existsSync(pkgPath)) { console.log(`  FAIL  installed: ${name}: package.json missing`); continue; }
  const resolved = JSON.parse(readFileSync(pkgPath,"utf8")).version;
  if (resolved===p.version) {
    console.log(`  PASS  resolved version: ${name}@${resolved}`);
  } else {
    console.log(`  FAIL  resolved version: ${name}: expected ${p.version} got ${resolved}`);
  }
}
JS

# ── 7. Execute runner ────────────────────────────────────────────────────────────────

echo ""
echo "[7] Execute runner"

RUN_TMP="$WORK/run"
mkdir -p "$RUN_TMP"
cp -r fixtures runner "$RUN_TMP/"
cp profile.json expected-results.json CLAIM-BOUNDARY.md "$RUN_TMP/" 2>/dev/null || true
cp -r "$INSTALL_TMP/node_modules" "$RUN_TMP/"

# Clean-room assertions: runner and node_modules must resolve inside the clean temp directory.
# The runner must NOT be executed from the repository root where no node_modules exists.
echo "  Clean-room assertions:"
echo "    RUN_TMP:      $RUN_TMP"
echo "    runner path:  $RUN_TMP/runner/run.mjs"
echo "    node_modules: $RUN_TMP/node_modules"
[[ -f "$RUN_TMP/runner/run.mjs" ]] || { echo "  FATAL: runner/run.mjs not found in RUN_TMP"; exit 1; }
[[ -d "$RUN_TMP/node_modules" ]] || { echo "  FATAL: node_modules not found in RUN_TMP"; exit 1; }
RUNNER_REAL="$(realpath "$RUN_TMP/runner/run.mjs")"
RUNTMP_REAL="$(realpath "$RUN_TMP")"
[[ "$RUNNER_REAL" == "$RUNTMP_REAL/"* ]] || { echo "  FATAL: runner resolves outside RUN_TMP ($RUNNER_REAL)"; exit 1; }
result "runner inside clean temp dir" ok "$RUN_TMP"

echo "  Executing node runner/run.mjs from clean directory …"
set +e
(
  cd "$RUN_TMP"
  node runner/run.mjs
) > "$WORK/runner-output.txt" 2>&1
RUN_EXIT=$?
set -e

echo ""
echo "  --- runner output ---"
cat "$WORK/runner-output.txt" | sed 's/^/  /'
echo "  ---------------------"

if [[ $RUN_EXIT -eq 0 ]]; then
  result "runner exits 0" ok
else
  result "runner exits 0" fail "exit $RUN_EXIT"
fi

for CLAIM in "C1: PASS" "C2: PASS" "C3: PASS" "N1: BOUNDARY-HELD" "N2: BOUNDARY-HELD" "N3: BOUNDARY-HELD" "N4: BOUNDARY-HELD"; do
  if grep -qF "$CLAIM" "$WORK/runner-output.txt"; then
    result "verdict: $CLAIM" ok
  else
    result "verdict: $CLAIM" fail "not found in output"
  fi
done

# ── 8–10. Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "[8] Environment"
echo "  node: $NODE_VER"
echo "  npm:  $NPM_VER"
echo "  os:   $OS_INFO"
if ! $LOCAL_MODE; then
  echo "  clone tag:    $TAG"
  echo "  HEAD commit:  $(git rev-parse HEAD 2>/dev/null || echo unknown)"
fi

echo ""
echo "# Outsider rehearsal summary: $PASS passed, $FAIL failed"
if [[ $FAIL -eq 0 ]]; then
  echo "# Result: REHEARSAL PASSED"
  exit 0
else
  echo "# Result: REHEARSAL FAILED — review output above"
  exit 1
fi
