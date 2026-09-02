#!/bin/bash
set -e

# The repository being indexed is mounted (or cloned) at /repo, and the
# repowise index (.repowise/) lives INSIDE that repo. We keep wiki.db and the
# LanceDB vectors together in /repo/.repowise — that is what the CLI (init) and
# the server (serve) both expect, so there is no split state.
REPO_DIR="${REPOWISE_REPO_PATH:-/repo}"
INDEX_DB="${REPO_DIR}/.repowise/wiki.db"

REPOWISE_DB_URL="${REPOWISE_DB_URL:-sqlite+aiosqlite:////${INDEX_DB}}"

# `su -p` preserves the container's HOME (usually /root), but the servers run as
# the `repowise` user and need a home they can write to. The `repowise` user's
# home is /app (per the Dockerfile), which is owned by repowise. Without this,
# steps like provider_config (e.g. where to store provider/provider_config.json)
# fail with "PermissionError: /root/.repowise/provider_config.json".
export HOME="${REPOWISE_HOME:-/app}"

# 1. Give the repowise user write access to /repo (volumes from the host are
#    often root-owned). Harmless if already correct.
chown -R repowise:repowise "${REPO_DIR}" 2>/dev/null || true

# 2. First run: if /repo has no repo, clone it so there is something to index.
#    Set REPOWISE_REPO_URL to the git repo to clone when you are not mounting a
#    pre-cloned checkout into /repo.
if [ -n "${REPOWISE_REPO_URL:-}" ] && [ ! -d "${REPO_DIR}/.git" ]; then
  echo "Cloning ${REPOWISE_REPO_URL} into ${REPO_DIR}..."
  su -p repowise -s /bin/sh -c "git clone --quiet '${REPOWISE_REPO_URL}' '${REPO_DIR}'"
fi

# 3. First run: index once if no DB exists yet. Subsequent restarts reuse it.
#    --no-editor-setup: index only, write nothing outside the repo/.repowise.
if [ ! -f "${INDEX_DB}" ] && [ -d "${REPO_DIR}/.git" ]; then
  echo "No index found — running \`repowise init\` on ${REPO_DIR}..."
  INIT_MODEL=""
  if [ -n "${REPOWISE_MODEL:-}" ]; then
    INIT_MODEL="--model '${REPOWISE_MODEL}'"
  fi
  su -p repowise -s /bin/sh -c \
    "export REPOWISE_DB_URL='${REPOWISE_DB_URL}' OPENROUTER_API_KEY='${OPENROUTER_API_KEY:-}' REPOWISE_PROVIDER='${REPOWISE_PROVIDER:-}' REPOWISE_EMBEDDER='${REPOWISE_EMBEDDER:-}' REPOWISE_EMBEDDING_MODEL='${REPOWISE_EMBEDDING_MODEL:-}'; repowise init '${REPO_DIR}' --yes --no-editor-setup ${INIT_MODEL}"
fi

# 4. Both servers bind 0.0.0.0 inside the container, so without a key the only
#    thing standing between the API and the network is the port publishing.
if [ -z "${REPOWISE_API_KEY}" ]; then
  echo "WARNING: REPOWISE_API_KEY is not set. Requests from outside the container" \
       "will be refused; the API is only usable from inside it. Set REPOWISE_API_KEY."
fi

# Start the FastAPI backend
echo "Starting repowise API server on port ${PORT_BACKEND}..."
su -p repowise -s /bin/sh -c \
  "REPOWISE_DB_URL='${REPOWISE_DB_URL}' OPENROUTER_API_KEY='${OPENROUTER_API_KEY:-}' REPOWISE_PROVIDER='${REPOWISE_PROVIDER:-}' REPOWISE_MODEL='${REPOWISE_MODEL:-}' REPOWISE_EMBEDDER='${REPOWISE_EMBEDDER:-}' REPOWISE_EMBEDDING_MODEL='${REPOWISE_EMBEDDING_MODEL:-}' exec uvicorn repowise.server.app:create_app --factory --host 0.0.0.0 --port '${PORT_BACKEND}'" &

# Start the MCP server (streamable HTTP) for external MCP clients on 7338.
# Expose it via a second domain pointing at container port 7338. The repo path
# is the POSITIONAL argument (not --repo).
MCP_PORT="${REPOWISE_MCP_PORT:-7338}"
echo "Starting repowise MCP server (streamable-http) on port ${MCP_PORT}..."
su -p repowise -s /bin/sh -c \
  "REPOWISE_DB_URL='${REPOWISE_DB_URL}' OPENROUTER_API_KEY='${OPENROUTER_API_KEY:-}' REPOWISE_PROVIDER='${REPOWISE_PROVIDER:-}' REPOWISE_MODEL='${REPOWISE_MODEL:-}' REPOWISE_EMBEDDER='${REPOWISE_EMBEDDER:-}' REPOWISE_EMBEDDING_MODEL='${REPOWISE_EMBEDDING_MODEL:-}' exec repowise mcp '${REPO_DIR}' --transport streamable-http --host 0.0.0.0 --port '${MCP_PORT}'" &

# Start the Next.js frontend
# outputFileTracingRoot points to the repo root, so Next.js standalone output
# nests server.js under packages/web/ relative to the standalone root directory.
echo "Starting repowise Web UI on port ${PORT_FRONTEND}..."
cd /app/web/packages/web
REPOWISE_API_KEY="${REPOWISE_API_KEY:-}" \
REPOWISE_API_URL="http://localhost:${PORT_BACKEND}" \
HOSTNAME="0.0.0.0" \
PORT="${PORT_FRONTEND}" \
  su -p repowise -s /bin/sh -c 'exec node server.js' &

# Wait for either process to exit
wait -n
exit $?
