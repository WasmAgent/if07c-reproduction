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
#   ./scripts/outsider-repro.sh [--tag v1.2.0] [--commit <sha>]
#   ./scripts/outsider-repro.sh --commit-only <sha>   # verify candidate before tag exists
#   ./scripts/outsider-repro.sh --local               # skip git clone, use current tree
#   ./scripts/outsider-repro.sh --self-test           # run only the negative controls
#
# Failure propagation (v1.2.1): every embedded verification block (registry
# integrity, tarball sha256, resolved versions) exits nonzero on ANY failed
# item, and the shell counts that into FAIL — a FAIL line can no longer hide
# behind exit 0. The expected runner-verdict list is derived from
# expected-results.json + fixture kinds, with an exact-coverage assertion
# (no missing, no extra). Negative controls cover wrong integrity, download
# failure, and version mismatch.
#
# Requires: git, node, npm, curl, shasum (or sha256sum), jq

set -euo pipefail

REPO_URL="https://github.com/WasmAgent/if07c-reproduction"
DEFAULT_TAG="v1.2.0"
TAG="$DEFAULT_TAG"
COMMIT_SHA=""
COMMIT_ONLY=false
LOCAL_MODE=false
SELF_TEST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --commit) COMMIT_SHA="$2"; shift 2;;
    --commit-only) COMMIT_SHA="$2"; COMMIT_ONLY=true; shift 2;;
    --local) LOCAL_MODE=true; shift;;
    --self-test) SELF_TEST=true; shift;;
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

# ── 0. Verification block helpers (parameterised by manifest path so the
#       negative controls can run the SAME logic against mutated manifests) ────

cat > "$WORK/registry-check.cjs" <<'JS'
// Registry integrity check. Usage: node registry-check.cjs <manifest>
// Exits nonzero when any package's live registry integrity differs from the
// manifest or cannot be fetched.
const a = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const { execFileSync } = require("child_process");
let fails = 0, passes = 0;
for (const [name, p] of Object.entries(a.packages ?? {})) {
  if (!p.version) { console.log(`  SKIP  ${name}: no version`); continue; }
  let live;
  try {
    live = execFileSync("npm", ["view", `${name}@${p.version}`, "dist.integrity"], { encoding: "utf8" }).trim();
  } catch (e) {
    console.log(`  FAIL  registry integrity fetch: ${name}: ${e.message.split("\n")[0]}`);
    fails++; continue;
  }
  if (live === p.integrity) {
    console.log(`  PASS  registry integrity: ${name}@${p.version}`);
    passes++;
  } else {
    console.log(`  FAIL  registry integrity: ${name}@${p.version}  expected ${p.integrity.slice(0, 20)}… got ${live.slice(0, 20)}…`);
    fails++;
  }
}
console.log(`  Registry check: ${passes} passed, ${fails} failed`);
process.exit(fails > 0 ? 1 : 0);
JS

cat > "$WORK/tarball-check.cjs" <<'JS'
// Tarball SHA256 check. Usage: node tarball-check.cjs <manifest> <tarDir>
// Exits nonzero when any tarball cannot be produced or its SHA256 differs.
const [,, manifestPath, tarDir] = process.argv; // <manifest> <tarDir>
const a = JSON.parse(require("fs").readFileSync(manifestPath, "utf8"));
const { spawnSync } = require("child_process");
const { createHash } = require("crypto");
const { readFileSync, readdirSync, rmSync } = require("fs");
const { join } = require("path");
let fails = 0, passes = 0;
for (const [name, p] of Object.entries(a.packages ?? {})) {
  if (!p.version) continue;
  try {
    spawnSync("npm", ["pack", `${name}@${p.version}`, "--pack-destination", tarDir], { stdio: "pipe" });
    const prefix = name.replace(/@/g, "").replace(/\//g, "-") + "-";
    const files = readdirSync(tarDir).filter((f) => f.endsWith(".tgz") && f.startsWith(prefix));
    if (!files.length) { console.log(`  FAIL  tarball pack: ${name}: no file produced`); fails++; continue; }
    const tgz = files[0];
    const hash = createHash("sha256").update(readFileSync(join(tarDir, tgz))).digest("hex");
    rmSync(join(tarDir, tgz), { force: true });
    if (hash === p.tarballSha256) {
      console.log(`  PASS  tarball sha256: ${name}@${p.version}`);
      passes++;
    } else {
      console.log(`  FAIL  tarball sha256: ${name}@${p.version}  expected ${p.tarballSha256.slice(0, 12)}… got ${hash.slice(0, 12)}…`);
      fails++;
    }
  } catch (e) {
    console.log(`  FAIL  tarball sha256: ${name}: ${e.message}`);
    fails++;
  }
}
console.log(`  Tarball check: ${passes} passed, ${fails} failed`);
process.exit(fails > 0 ? 1 : 0);
JS

cat > "$WORK/resolved-check.cjs" <<'JS'
// Resolved-version check. Usage: node resolved-check.cjs <manifest> <installDir>
// Exits nonzero when any installed version differs from the manifest.
const [,, manifestPath, instDir] = process.argv; // <manifest> <installDir>
const a = JSON.parse(require("fs").readFileSync(manifestPath, "utf8"));
const { readFileSync, existsSync } = require("fs");
const { join } = require("path");
let fails = 0, passes = 0;
for (const [name, p] of Object.entries(a.packages ?? {})) {
  if (!p.version) continue;
  const pkgPath = join(instDir, "node_modules", name, "package.json");
  if (!existsSync(pkgPath)) { console.log(`  FAIL  installed: ${name}: package.json missing`); fails++; continue; }
  const resolved = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (resolved === p.version) {
    console.log(`  PASS  resolved version: ${name}@${resolved}`);
    passes++;
  } else {
    console.log(`  FAIL  resolved version: ${name}: expected ${p.version} got ${resolved}`);
    fails++;
  }
}
console.log(`  Resolved-version check: ${passes} passed, ${fails} failed`);
process.exit(fails > 0 ? 1 : 0);
JS

# ── 1. Obtain release archive ──────────────────────────────────────────────────────

echo "[1] Obtain release archive"

CLONE_DIR="$WORK/pack"

if $SELF_TEST; then
  echo "  self-test mode: verifying against the CURRENT tree only"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PACK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  CLONE_DIR="$PACK_ROOT"
  result "self-test local tree" ok "using $PACK_ROOT"
elif $LOCAL_MODE; then
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

if ! $LOCAL_MODE && ! $SELF_TEST; then
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

set +e
node "$WORK/registry-check.cjs" "ARTIFACTS.json"
REGISTRY_RC=$?
set -e
if [[ $REGISTRY_RC -ne 0 ]]; then
  result "registry integrity verification" fail "exit $REGISTRY_RC (FAIL lines above)"
else
  result "registry integrity verification" ok
fi

# ── 5. Independently download and verify tarballs ─────────────────────────────────

echo ""
echo "[5] Tarball SHA256 verification"

TARBALL_TMP="$WORK/tarballs"
mkdir -p "$TARBALL_TMP"

set +e
node "$WORK/tarball-check.cjs" "ARTIFACTS.json" "$TARBALL_TMP"
TARBALL_RC=$?
set -e
if [[ $TARBALL_RC -ne 0 ]]; then
  result "tarball sha256 verification" fail "exit $TARBALL_RC (FAIL lines above)"
else
  result "tarball sha256 verification" ok
fi

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
set +e
(
  cd "$INSTALL_TMP"
  npm init -y >/dev/null 2>&1
  npm install --ignore-scripts $INSTALL_ARGS > "$WORK/npm-install.log" 2>&1
)
NPM_RC=$?
set -e
tail -3 "$WORK/npm-install.log" | sed 's/^/  /'
if [[ $NPM_RC -ne 0 ]]; then
  result "clean npm install" fail "exit $NPM_RC"
else
  result "clean npm install" ok
fi

echo "  Verifying resolved versions …"
set +e
node "$WORK/resolved-check.cjs" "ARTIFACTS.json" "$INSTALL_TMP"
RESOLVED_RC=$?
set -e
if [[ $RESOLVED_RC -ne 0 ]]; then
  result "resolved version verification" fail "exit $RESOLVED_RC (FAIL lines above)"
else
  result "resolved version verification" ok
fi

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

# Expected verdicts are DERIVED from expected-results.json + fixture kinds, so
# the rehearsal tracks the current case set instead of a hardcoded list.
echo "  Deriving expected verdicts from expected-results.json + fixtures …"
CLAIM_LIST="$(node -e '
const e = JSON.parse(require("fs").readFileSync("expected-results.json","utf8"));
const { readFileSync } = require("fs");
const list = Object.entries(e.claims ?? {}).map(([id, c]) => {
  const f = JSON.parse(readFileSync(c.fixture, "utf8"));
  return id + ": " + (f.kind === "negative" ? "BOUNDARY-HELD" : "PASS");
}).sort();
if (new Set(list).size !== list.length) { console.error("duplicate claim ids"); process.exit(1); }
console.log(list.join("\n"));
')" || { echo "  FATAL: could not derive expected verdicts"; exit 1; }

while IFS= read -r CLAIM; do
  [[ -z "$CLAIM" ]] && continue
  if grep -qF "$CLAIM" "$WORK/runner-output.txt"; then
    result "verdict: $CLAIM" ok
  else
    result "verdict: $CLAIM" fail "not found in output"
  fi
done <<< "$CLAIM_LIST"

# Reverse coverage: the runner must not report verdicts outside the expected
# set (exact set equality — no missing, no extra, no duplicates).
EXPECTED_SORTED="$(printf '%s\n' "$CLAIM_LIST" | sed '/^$/d' | sort)"
OBSERVED_SORTED="$(grep -oE '^[A-Za-z0-9]+: (PASS|BOUNDARY-HELD|BOUNDARY-BROKEN|FAIL)' "$WORK/runner-output.txt" | sort -u)"
if [[ "$OBSERVED_SORTED" == "$EXPECTED_SORTED" ]]; then
  result "verdict coverage exact (no missing, no extra)" ok "($(printf '%s\n' "$CLAIM_LIST" | grep -c .) claims)"
else
  result "verdict coverage exact (no missing, no extra)" fail "runner verdict set differs from expected set"
  diff <(printf '%s\n' "$EXPECTED_SORTED") <(printf '%s\n' "$OBSERVED_SORTED") | sed 's/^/    /' || true
fi

# ── 8. Negative controls (self-test of the verification blocks) ─────────────────

echo ""
echo "[8] Negative controls (verification blocks must reject tampering)"

NC_TMP="$WORK/negative-controls"
mkdir -p "$NC_TMP/tarballs" "$NC_TMP/fake-install/node_modules/@wasmagent/core"
nc() {
  local label="$1" rc="$2"
  if [[ $rc -ne 0 ]]; then
    result "$label" ok "correctly rejected"
  else
    result "$label" fail "control passed but should have failed"
  fi
}

# NC1: wrong registry integrity → registry check must exit nonzero
node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync("ARTIFACTS.json", "utf8"));
if (a.packages?.["@wasmagent/core"]) a.packages["@wasmagent/core"].integrity = "sha512-" + "A".repeat(88) + "==";
fs.writeFileSync(process.argv[1], JSON.stringify(a, null, 2));
' "$NC_TMP/manifest-nc1.json"
set +e
node "$WORK/registry-check.cjs" "$NC_TMP/manifest-nc1.json" > /dev/null 2>&1
NC1_RC=$?
set -e
nc "NC1: wrong integrity → registry check fails" "$NC1_RC"

# NC2: nonexistent version → tarball check must exit nonzero (download failure)
node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync("ARTIFACTS.json", "utf8"));
if (a.packages?.["@wasmagent/core"]) a.packages["@wasmagent/core"].version = "999.999.999";
fs.writeFileSync(process.argv[1], JSON.stringify(a, null, 2));
' "$NC_TMP/manifest-nc2.json"
set +e
node "$WORK/tarball-check.cjs" "$NC_TMP/manifest-nc2.json" "$NC_TMP/tarballs" > /dev/null 2>&1
NC2_RC=$?
set -e
nc "NC2: nonexistent version → tarball check fails (download failure)" "$NC2_RC"

# NC3: version mismatch → resolved-version check must exit nonzero
node -e '
const fs = require("fs");
const path = require("path");
const [manifestPath, fakeInstall] = process.argv.slice(1); // node -e: argv[1] is the first following arg
const a = JSON.parse(fs.readFileSync("ARTIFACTS.json", "utf8"));
if (a.packages?.["@wasmagent/core"]) a.packages["@wasmagent/core"].version = "3.9.999";
fs.writeFileSync(manifestPath, JSON.stringify(a, null, 2));
fs.mkdirSync(path.join(fakeInstall, "node_modules/@wasmagent/core"), { recursive: true });
fs.writeFileSync(path.join(fakeInstall, "node_modules/@wasmagent/core/package.json"), JSON.stringify({ name: "@wasmagent/core", version: "3.9.0" }));
' "$NC_TMP/manifest-nc3.json" "$NC_TMP/fake-install"
set +e
node "$WORK/resolved-check.cjs" "$NC_TMP/manifest-nc3.json" "$NC_TMP/fake-install" > /dev/null 2>&1
NC3_RC=$?
set -e
nc "NC3: version mismatch → resolved-version check fails" "$NC3_RC"

# ── 9–11. Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "[9] Environment"
echo "  node: $NODE_VER"
echo "  npm:  $NPM_VER"
echo "  os:   $OS_INFO"
if ! $LOCAL_MODE && ! $SELF_TEST; then
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
