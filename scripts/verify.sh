#!/usr/bin/env bash
# One command that checks the main claims: tests pass, the site builds, the live
# pages answer, and the payout address on the site is the one the code pays.
# Usage: bash scripts/verify.sh [site-url]
set -euo pipefail
SITE="${1:-https://holdfast-bch.vercel.app}"
cd "$(dirname "$0")/.."
fail=0

echo "1. Tests"
npm test --silent 2>&1 | grep -E "Tests +[0-9]+" || fail=1

echo "2. Build"
npm run build --silent 2>&1 | grep -E "built in" || fail=1
git checkout --quiet -- src/*.artifact.ts

echo "3. Live pages"
for p in / /how-it-works/ /why/ /security/ /guardians/ /demo/ /faq/ /privacy/ /terms/ /under-the-hood/ /app/ /real/ /robots.txt /sitemap.xml /holdfast-deck.pdf; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE$p")
  [ "$code" = 200 ] || { echo "   $p -> $code"; fail=1; }
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/no-such-page")
[ "$code" = 404 ] || { echo "   404 page -> $code"; fail=1; }

echo "4. Payout address"
addr=$(grep -oE "FEE_HASH = '[a-z0-9]+'" src/real/core.ts | grep -oE "z[a-z0-9]+")
curl -s "$SITE/" | grep -q "bitcoincash:$addr" && echo "   site banner shows bitcoincash:$addr, the address the code pays" || { echo "   banner address differs from src/real/core.ts"; fail=1; }

[ "$fail" = 0 ] && echo "VERIFY PASSED" || { echo "VERIFY FAILED"; exit 1; }
