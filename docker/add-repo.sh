#!/bin/bash
# =============================================================================
# add-repo — Clone a git repository with correct repowise user permissions.
#
# Usage:
#   add-repo <git-url> [<target-dir>]
#
# Examples:
#   add-repo https://github.com/tiangolo/asyncer
#   add-repo https://github.com/tiangolo/asyncer /repo/asyncer
#
# The repository is cloned as the `repowise` user so the server can write
# its index (.repowise/) without permission errors.  If <target-dir> is
# omitted, the repo name is used inside /repo (e.g. /repo/asyncer).
# =============================================================================
set -e

if [ $# -lt 1 ]; then
  echo "Usage: add-repo <git-url> [<target-dir>]" >&2
  exit 1
fi

GIT_URL="$1"
shift

if [ $# -ge 1 ]; then
  TARGET="$1"
else
  REPO_NAME="$(basename "${GIT_URL%.git}")"
  TARGET="/repo/${REPO_NAME}"
fi

echo "Cloning ${GIT_URL} into ${TARGET} as repowise user..."
su -p repowise -s /bin/sh -c "git clone --depth 1 '${GIT_URL}' '${TARGET}'"
echo "Done! You can now add '${TARGET}' via the Repowise UI."