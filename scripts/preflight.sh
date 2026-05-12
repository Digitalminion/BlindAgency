#!/usr/bin/env bash
# Mirrors the CI publish workflow (publish.yml) exactly.
# Run this before every `git tag` to catch failures locally.
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pass()   { echo -e "  ${GREEN}✓${RESET} $1"; }
fail()   { echo -e "\n  ${RED}✗ FAILED:${RESET} $1\n" >&2; exit 1; }
warn()   { echo -e "  ${YELLOW}⚠${RESET} $1"; }
header() { echo -e "\n${BOLD}$1${RESET}"; }

echo -e "${BOLD}BlindAgency publish preflight${RESET}"
echo    "  Mirrors .github/workflows/publish.yml (ubuntu-latest, Node 24, npm ci)"

# ── Git state ──────────────────────────────────────────────────────────────────
header "Git state"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  warn "Not on 'main' branch (currently on '$BRANCH') — CI only publishes from tags on main"
else
  pass "On main branch"
fi

if ! git diff --quiet HEAD; then
  fail "Uncommitted changes present — commit everything before tagging"
fi
pass "Working tree clean"

if git log origin/main..HEAD --oneline 2>/dev/null | grep -q .; then
  warn "Unpushed commits exist — push to main before tagging"
else
  pass "Up to date with origin/main"
fi

# ── Version consistency ────────────────────────────────────────────────────────
header "Package versions"

AWS_VER=$(node -p "require('./packages/aws/package.json').version")
BROWSER_VER=$(node -p "require('./packages/browser/package.json').version")

if [ "$AWS_VER" != "$BROWSER_VER" ]; then
  fail "Version mismatch — aws=$AWS_VER  browser=$BROWSER_VER (both must match)"
fi
pass "Both packages at v$AWS_VER"

EXPECTED_TAG="v-$AWS_VER"
if git rev-parse "$EXPECTED_TAG" > /dev/null 2>&1; then
  fail "Tag $EXPECTED_TAG already exists — bump the version before publishing"
fi
pass "Tag $EXPECTED_TAG not yet created"

# ── Lock file sync ─────────────────────────────────────────────────────────────
# CI runs `npm ci` (ubuntu-latest) which requires exact lock file match.
# Note: npm ci --dry-run on macOS cannot detect Linux-only optional deps
# that are missing from the lock file (e.g. @emnapi/* WASM fallbacks).
# If CI fails with "Missing: @emnapi/..." add those packages to root devDependencies.
header "Lock file (npm ci --dry-run)"

if npm ci --dry-run --ignore-scripts > /dev/null 2>&1; then
  pass "package-lock.json is in sync with package.json"
else
  fail "package-lock.json is out of sync — run 'npm install' and commit the result"
fi

# ── Build (mirrors CI 'Build packages' step exactly) ──────────────────────────
header "Build: @blindagency/browser"
npm run build --workspace packages/browser \
  || fail "Browser build failed — fix before tagging"
pass "Browser build OK"

header "Build: @blindagency/aws"
npm run build --workspace packages/aws \
  || fail "AWS build failed — fix before tagging"
pass "AWS build OK"

# ── Tests (mirrors CI 'Test packages' step exactly) ───────────────────────────
header "Tests: @blindagency/browser"
npm test --workspace packages/browser \
  || fail "Browser tests failed"
pass "Browser tests OK"

header "Tests: @blindagency/aws"
npm test --workspace packages/aws \
  || fail "AWS tests failed"
pass "AWS tests OK"

# ── Type check (extra — not in CI but catches tsc errors before push) ─────────
header "Type check"
if npm run typecheck --workspaces --if-present > /dev/null 2>&1; then
  pass "TypeScript clean across all packages"
else
  fail "TypeScript errors found — run 'npm run typecheck --workspaces' for details"
fi

# ── Audit ─────────────────────────────────────────────────────────────────────
header "Security audit"
AUDIT_JSON=$(npm audit --json 2>/dev/null || true)
CRITICAL=$(echo "$AUDIT_JSON" | node -e \
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).metadata?.vulnerabilities?.critical??0)}catch{console.log(0)}})" \
  <<< "$AUDIT_JSON" 2>/dev/null || echo "0")

if [ "$CRITICAL" -gt 0 ]; then
  fail "npm audit: $CRITICAL critical vulnerabilities in published dependency tree — fix before publishing"
else
  HIGH=$(npm audit --audit-level=high 2>&1 | grep -c "high" || true)
  if [ "$HIGH" -gt 0 ]; then
    warn "High severity findings present (run 'npm audit' for details)"
    warn "Known exception: fast-uri inside aws-cdk-lib bundled deps is not in published code"
  else
    pass "No critical/high vulnerabilities"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}All checks passed.${RESET} Safe to tag and publish:\n"
echo -e "  git push origin main"
echo -e "  git tag $EXPECTED_TAG"
echo -e "  git push origin $EXPECTED_TAG"
echo
