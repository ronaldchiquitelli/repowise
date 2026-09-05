#!/bin/bash
# =============================================================================
# add-repo — Clone a git repository with correct repowise user permissions.
#
# Usage:
#   add-repo <git-url> [<target-dir>]
#   add-repo --private owner/repo-name [<target-dir>]
#
# Examples:
#   add-repo https://github.com/tiangolo/asyncer
#   add-repo https://github.com/tiangolo/asyncer /repo/asyncer
#   add-repo --private my-org/my-private-repo
#   add-repo --private my-org/my-private-repo /repo/my-private-repo
#
# The repository is cloned as the `repowise` user so the server can write
# its index (.repowise/) without permission errors.  If <target-dir> is
# omitted, the repo name is used inside /repo (e.g. /repo/asyncer).
#
# --private: uses GITHUB_TOKEN to clone private repos. The token is embedded
# in .git/config so subsequent `git pull` calls work without re-authentication.
# =============================================================================
set -e

PRIVATE=false
if [ "$1" = "--private" ]; then
  PRIVATE=true
  shift
fi

if [ $# -lt 1 ]; then
  if [ "$PRIVATE" = true ]; then
    echo "Usage: add-repo --private <owner/repo-name> [<target-dir>]" >&2
  else
    echo "Usage: add-repo <git-url> [<target-dir>]" >&2
  fi
  exit 1
fi

REPO_INPUT="$1"
shift

# For --private, build the authenticated URL
if [ "$PRIVATE" = true ]; then
  if [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "Error: GITHUB_TOKEN is not set. Export it before running add-repo --private." >&2
    exit 1
  fi
  # Parse owner/repo or full URL
  REPO_INPUT_CLEAN="${REPO_INPUT%.git}"
  REPO_NAME="$(basename "${REPO_INPUT_CLEAN}")"
  GIT_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_INPUT_CLEAN}.git"
else
  GIT_URL="$REPO_INPUT"
  REPO_NAME="$(basename "${GIT_URL%.git}")"
fi

if [ $# -ge 1 ]; then
  TARGET="$1"
else
  TARGET="/repo/${REPO_NAME}"
fi

echo "Cloning ${REPO_NAME} into ${TARGET} as repowise user..."
if [ "$PRIVATE" = true ]; then
  su -p repowise -s /bin/sh -c "git clone --depth 1 '${GIT_URL}' '${TARGET}'"
else
  su -p repowise -s /bin/sh -c "git clone --depth 1 '${GIT_URL}' '${TARGET}'"
fi
echo "Done! You can now add '${TARGET}' via the Repowise UI."