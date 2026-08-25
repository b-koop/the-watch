#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <version|major|minor|patch> <npm-otp>" >&2
  exit 1
fi

version=$1
otp=$2

case "$version" in
  major|minor|patch|premajor|preminor|prepatch|prerelease|[0-9]*.[0-9]*.[0-9]*)
    ;;
  *)
    echo "Invalid version '$version'. Use a semantic version or an npm version bump." >&2
    exit 1
    ;;
esac

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required but was not found." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found." >&2
  exit 1
fi

pnpm test
npm version "$version" --no-git-tag-version
pnpm pack:check
npm publish --access public --otp="$otp"
