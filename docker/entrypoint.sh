#!/bin/bash
set -e

# The repository being indexed is mounted (or cloned) at /repo, and the
# repowise index (.repowise/) lives INSIDE that repo. We keep wiki.db and the
# LanceDB vectors together in /repo/.repowise — that is what the CLI (init) and
# the server (serve) both expect, so there is no split state.
REPO_DIR="${REPOWISE_REPO_PATH:-/repo}"
INDEX_DB="${REPO_DIR}/.repowise/wiki.db"

# Workspace mode: /repo IS the workspace root.
# All repos added via add-repo live as subdirectories under /repo/.
# We auto-discover them and generate the workspace config dynamically.
WORKSPACE_DIR="${REPO_DIR}"
USE_WORKSPACE=false

# Check if /repo has multiple git repos (workspace mode)
REPO_COUNT=$(find "${REPO_DIR}" -maxdepth 2 -name ".git" -type d 2>/dev/null | wc -l)
if [ "${REPO_COUNT}" -gt 1 ]; then
  USE_WORKSPACE=true
  echo "✅ Workspace mode detected: ${REPO_COUNT} repos found in ${REPO_DIR}"

  # Ensure .repowise-workspace.yaml exists with at least version header
  if [ ! -f "${REPO_DIR}/.repowise-workspace.yaml" ]; then
    echo "Creating workspace config..."
    cat > "${REPO_DIR}/.repowise-workspace.yaml" << 'WSEOF'
version: 1
repos: []
WSEOF
  fi
fi

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
# SGID bit: new files/dirs inside /repo inherit the repowise group, so a
# repo cloned as root (e.g. via the container terminal) is still writable
# by the repowise server without a manual chown.
chmod g+s "${REPO_DIR}" 2>/dev/null || true

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
    "unset QDRANT_URL QDRANT_API_KEY QDRANT_COLLECTION; export REPOWISE_DB_URL='${REPOWISE_DB_URL}' OPENROUTER_API_KEY='${OPENROUTER_API_KEY:-}' REPOWISE_PROVIDER='${REPOWISE_PROVIDER:-}' REPOWISE_EMBEDDER='${REPOWISE_EMBEDDER:-}' REPOWISE_EMBEDDING_MODEL='${REPOWISE_EMBEDDING_MODEL:-}' OPENAI_API_KEY='${OPENAI_API_KEY:-}' OPENAI_BASE_URL='${OPENAI_BASE_URL:-}' LITELLM_API_KEY='${LITELLM_API_KEY:-}' LITELLM_API_BASE='${LITELLM_API_BASE:-}' CLOUDFLARE_ACCOUNT_ID='${CLOUDFLARE_ACCOUNT_ID:-}' CLOUDFLARE_API_TOKEN='${CLOUDFLARE_API_TOKEN:-}' GITHUB_TOKEN='${GITHUB_TOKEN:-}' REPOWISE_GITHUB_WEBHOOK_SECRET='${REPOWISE_GITHUB_WEBHOOK_SECRET:-}'; repowise init '${REPO_DIR}' --yes --no-editor-setup ${INIT_MODEL}" || echo "WARNING: init failed for ${REPO_DIR} (non-fatal, continuing...)"
fi

# 3b. Workspace mode: auto-discover and index all repos under /repo
if [ "${USE_WORKSPACE}" = true ]; then
  echo "Auto-discovering repos in ${REPO_DIR}..."
  
  # Create workspace config if it doesn't exist
  if [ ! -f "${REPO_DIR}/.repowise-workspace.yaml" ]; then
    echo "Creating workspace config..."
    cat > "${REPO_DIR}/.repowise-workspace.yaml" << 'WSEOF'
version: 1
repos: []
WSEOF
  fi
  
  # Run workspace scan to auto-discover new repos
  su -p repowise -s /bin/sh -c \
    "export HOME='${HOME}' REPOWISE_DB_URL='${REPOWISE_DB_URL}' OPENROUTER_API_KEY='${OPENROUTER_API_KEY:-}' REPOWISE_PROVIDER='${REPOWISE_PROVIDER:-}' REPOWISE_EMBEDDER='${REPOWISE_EMBEDDER:-}' REPOWISE_EMBEDDING_MODEL='${REPOWISE_EMBEDDING_MODEL:-}' OPENAI_API_KEY='${OPENAI_API_KEY:-}' OPENAI_BASE_URL='${OPENAI_BASE_URL:-}' LITELLM_API_KEY='${LITELLM_API_KEY:-}' LITELLM_API_BASE='${LITELLM_API_BASE:-}' CLOUDFLARE_ACCOUNT_ID='${CLOUDFLARE_ACCOUNT_ID:-}' CLOUDFLARE_API_TOKEN='${CLOUDFLARE_API_TOKEN:-}' GITHUB_TOKEN='${GITHUB_TOKEN:-}' REPOWISE_GITHUB_WEBHOOK_SECRET='${REPOWISE_GITHUB_WEBHOOK_SECRET:-}'; repowise workspace scan '${REPO_DIR}' --yes" 2>/dev/null || true
  
  # Index each unindexed repo
  for repo_path in "${REPO_DIR}"/*/; do
    if [ -d "${repo_path}/.git" ]; then
      repo_name=$(basename "${repo_path}")
      repo_index="${repo_path}/.repowise/wiki.db"
      if [ ! -f "${repo_index}" ]; then
        echo "  Indexing ${repo_name}..."
        su -p repowise -s /bin/sh -c \
          "unset QDRANT_URL QDRANT_API_KEY QDRANT_COLLECTION; export HOME='${HOME}' REPOWISE_DB_URL='sqlite+aiosqlite:////${repo_index}' OPENROUTER_API_KEY='${OPENROUTER_API_KEY:-}' REPOWISE_PROVIDER='${REPOWISE_PROVIDER:-}' REPOWISE_EMBEDDER='${REPOWISE_EMBEDDER:-}' REPOWISE_EMBEDDING_MODEL='${REPOWISE_EMBEDDING_MODEL:-}' OPENAI_API_KEY='${OPENAI_API_KEY:-}' OPENAI_BASE_URL='${OPENAI_BASE_URL:-}' LITELLM_API_KEY='${LITELLM_API_KEY:-}' LITELLM_API_BASE='${LITELLM_API_BASE:-}' CLOUDFLARE_ACCOUNT_ID='${CLOUDFLARE_ACCOUNT_ID:-}' CLOUDFLARE_API_TOKEN='${CLOUDFLARE_API_TOKEN:-}' GITHUB_TOKEN='${GITHUB_TOKEN:-}' REPOWISE_GITHUB_WEBHOOK_SECRET='${REPOWISE_GITHUB_WEBHOOK_SECRET:-}'; repowise init '${repo_path}' --yes --no-editor-setup" || echo "  WARNING: init failed for ${repo_name} (non-fatal)"
      else
        echo "  ${repo_name} already indexed, skipping..."
      fi
    fi
  done
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
  # QDRANT: only for servers (MCP + API), NOT for init (init uses LanceDB)
  QDRANT_SERVER_ENV=""
  if [ -n "${QDRANT_URL:-}" ]; then
    QDRANT_SERVER_ENV="QDRANT_URL='${QDRANT_URL}' QDRANT_API_KEY='${QDRANT_API_KEY:-}' QDRANT_COLLECTION='${QDRANT_COLLECTION:-repowise-wiki}'"
    echo "   Qdrant enabled: ${QDRANT_URL}"
  fi
  su -p repowise -s /bin/sh -c \
    "REPOWISE_DB_URL='${REPOWISE_DB_URL}' OPENROUTER_API_KEY='${OPENROUTER_API_KEY:-}' REPOWISE_PROVIDER='${REPOWISE_PROVIDER:-}' REPOWISE_MODEL='${REPOWISE_MODEL:-}' REPOWISE_EMBEDDER='${REPOWISE_EMBEDDER:-}' REPOWISE_EMBEDDING_MODEL='${REPOWISE_EMBEDDING_MODEL:-}' OPENAI_API_KEY='${OPENAI_API_KEY:-}' OPENAI_BASE_URL='${OPENAI_BASE_URL:-}' LITELLM_API_KEY='${LITELLM_API_KEY:-}' LITELLM_API_BASE='${LITELLM_API_BASE:-}' CLOUDFLARE_ACCOUNT_ID='${CLOUDFLARE_ACCOUNT_ID:-}' CLOUDFLARE_API_TOKEN='${CLOUDFLARE_API_TOKEN:-}' GITHUB_TOKEN='${GITHUB_TOKEN:-}' REPOWISE_GITHUB_WEBHOOK_SECRET='${REPOWISE_GITHUB_WEBHOOK_SECRET:-}' ${QDRANT_SERVER_ENV} exec uvicorn repowise.server.app:create_app --factory --host 0.0.0.0 --port '${PORT_BACKEND}'" &

# Start the MCP server (streamable HTTP) for external MCP clients on 7338.
# Expose it via a second domain pointing at container port 7338. The repo path
# is the POSITIONAL argument (not --repo).
MCP_PORT="${REPOWISE_MCP_PORT:-7338}"
echo "Starting repowise MCP server (streamable-http) on port ${MCP_PORT}..."

# Determine MCP server path: workspace mode uses /repo as workspace root
if [ "${USE_WORKSPACE}" = true ]; then
  MCP_PATH="${REPO_DIR}"
  echo "   Using workspace mode: ${MCP_PATH} (${REPO_COUNT} repos)"
else
  MCP_PATH="${REPO_DIR}"
  echo "   Using single repo mode: ${MCP_PATH}"
fi

su -p repowise -s /bin/sh -c \
  "REPOWISE_DB_URL='${REPOWISE_DB_URL}' OPENROUTER_API_KEY='${OPENROUTER_API_KEY:-}' REPOWISE_PROVIDER='${REPOWISE_PROVIDER:-}' REPOWISE_MODEL='${REPOWISE_MODEL:-}' REPOWISE_EMBEDDER='${REPOWISE_EMBEDDER:-}' REPOWISE_EMBEDDING_MODEL='${REPOWISE_EMBEDDING_MODEL:-}' OPENAI_API_KEY='${OPENAI_API_KEY:-}' OPENAI_BASE_URL='${OPENAI_BASE_URL:-}' LITELLM_API_KEY='${LITELLM_API_KEY:-}' LITELLM_API_BASE='${LITELLM_API_BASE:-}' CLOUDFLARE_ACCOUNT_ID='${CLOUDFLARE_ACCOUNT_ID:-}' CLOUDFLARE_API_TOKEN='${CLOUDFLARE_API_TOKEN:-}' GITHUB_TOKEN='${GITHUB_TOKEN:-}' REPOWISE_GITHUB_WEBHOOK_SECRET='${REPOWISE_GITHUB_WEBHOOK_SECRET:-}' ${QDRANT_SERVER_ENV} exec repowise mcp '${MCP_PATH}' --transport streamable-http --host 0.0.0.0 --port '${MCP_PORT}' --all" &

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
