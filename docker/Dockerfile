# =============================================================================
# repowise — multi-stage Docker build (backend + frontend)
# =============================================================================
# Usage:
#   docker build -t repowise -f docker/Dockerfile .
#   docker run -p 7337:7337 -p 3000:3000 -v /path/to/repo/.repowise:/data -e GEMINI_API_KEY=... repowise
# =============================================================================

# Use Debian-based Node builder (glibc) to match python:3.12-slim runtime.
# Alpine (musl) builds produce a node binary that fails to execute in Debian slim with exit code 127.
FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /app

# Copy root manifest/lockfile for workspace resolution
COPY package.json package-lock.json* ./

# Copy only workspace package.json manifests first so the npm install layer
# is cached independently of source changes. Any edit to a .ts/.tsx/etc. file
# will skip straight to `next build` without re-running the 2-min install.
COPY packages/web/package.json       ./packages/web/package.json
COPY packages/types/package.json     ./packages/types/package.json
COPY packages/ui/package.json        ./packages/ui/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json

# Change directory to web package and install dependencies
WORKDIR /app/packages/web
RUN npm install --production=false

# Copy full package source (after install — source changes skip the install cache)
WORKDIR /app
COPY packages/ ./packages/

# Build Next.js frontend
WORKDIR /app/packages/web
ENV NEXT_TELEMETRY_DISABLED=1
# Keep the client bundle on RELATIVE /api/* calls. NEXT_PUBLIC_* is inlined at
# build time into the browser bundle; if it were an absolute URL here (e.g.
# http://localhost:7337) the browser would try the user's own localhost and the
# UI could not reach the API. Empty string makes apicGet use relative paths that
# the middleware (/api/* -> REPOWISE_API_URL) proxies to the real backend.
ENV NEXT_PUBLIC_REPOWISE_API_URL=""
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Python backend + frontend runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# Install git (required by gitpython)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy Node.js from the official image instead of piping curl|bash
COPY --from=frontend-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=frontend-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

WORKDIR /app

# Install repowise Python package
COPY pyproject.toml README.md LICENSE MANIFEST.in ./
COPY packages/core/ packages/core/
COPY packages/cli/ packages/cli/
COPY packages/server/ packages/server/
RUN pip install --no-cache-dir ".[all]"

# Copy built Next.js standalone output
COPY --from=frontend-builder /app/packages/web/.next/standalone /app/web
COPY --from=frontend-builder /app/packages/web/.next/static /app/web/packages/web/.next/static
COPY --from=frontend-builder /app/packages/web/public /app/web/packages/web/public

# Data volume for .repowise directory
# mkdir is required: VOLUME only registers metadata and does not create the
# directory on the image filesystem at build time. Without it, the subsequent
# `chown -R repowise:repowise /data` (run at build time) fails with
# "cannot access '/data': No such file or directory".
RUN mkdir -p /data
VOLUME /data

# Environment defaults
ENV REPOWISE_DB_URL=sqlite+aiosqlite:////data/wiki.db
ENV REPOWISE_EMBEDDER=mock
ENV PORT_BACKEND=7337
ENV PORT_FRONTEND=3000
ENV HOSTNAME=0.0.0.0

# Expose both ports
EXPOSE 7337 3000

# Startup script
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# The entrypoint runs as root so it can clone the repo and write the
# .repowise index into the mounted /repo volume on first start (volumes owned
# by the host, not by a fixed uid). The `repowise` user is still created for
# ownership/isolation once /repo is populated.
RUN groupadd -r repowise && useradd -r -g repowise -d /app -s /sbin/nologin repowise \
    && chown -R repowise:repowise /app /data

# /repo is where the repository being indexed is mounted (self-hosting.md
# convention and what the entrypoint writes the .repowise index into).
RUN mkdir -p /repo && chown repowise:repowise /repo

# Run as root: the entrypoint clones the repo and runs `repowise init` the
# first time into the (host-owned) /repo volume, then starts the servers.
USER root

ENTRYPOINT ["/app/entrypoint.sh"]
