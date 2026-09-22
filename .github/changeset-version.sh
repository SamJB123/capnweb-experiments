#! /bin/sh
# This script is called by the changeset action in release.yml.
set -e
pnpm exec changeset version
# Changesets does not update the workspace lockfile itself.
pnpm install --lockfile-only --no-frozen-lockfile
