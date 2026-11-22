#!/usr/bin/env bash
# Verify an installed Project Graph inside an Omnigent checkout: the source
# copy matches this repo, then the graph's vitest suite, type-check and lint.
#
# usage: verify.sh <omnigent-dir> [--build] [--no-install]
#
#   --build       also run `pnpm build`.
#   --no-install  skip `pnpm install --frozen-lockfile` (web/node_modules must exist).
set -euo pipefail

FEATURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PATHS=(src/projectGraph src/projectHome src/pages/ProjectHomePage)

die() { echo "project-graph: error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

build=0 install_deps=1 omnigent_dir=""
for arg in "$@"; do
  case "$arg" in
    --build) build=1 ;;
    --no-install) install_deps=0 ;;
    -h|--help) sed -n '5,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) omnigent_dir="$arg" ;;
  esac
done
[[ -n "$omnigent_dir" && -d "$omnigent_dir/web" ]] || die "usage: verify.sh <omnigent-dir> [--build] [--no-install]"
web="$(cd "$omnigent_dir/web" && pwd)"

step "source copy matches $FEATURE_ROOT/src/projectGraph"
diff -r "$FEATURE_ROOT/src/projectGraph" "$web/src/projectGraph" || die "installed source differs; run install.sh first"
echo "identical"

cd "$web"
if (( install_deps )); then
  step "pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
fi
[[ -d node_modules ]] || die "web/node_modules is missing; drop --no-install"

step "pnpm exec vitest run ${TEST_PATHS[*]}"
pnpm exec vitest run "${TEST_PATHS[@]}"

step "pnpm type-check"
pnpm type-check

step "pnpm lint"
pnpm lint

if (( build )); then
  step "pnpm build"
  pnpm build
fi

echo
echo "project-graph: verify passed"
