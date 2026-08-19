# pi-cloud-agent — the pi coding agent behind an HTTP control API.
#
# Build from the repo root:
#
#   docker build -t pi-cloud-agent .
#
# The backend runtime injects these env vars when spawning the container:
#   AGENT_PORT            — TCP port the server listens on (default 8000)
#   BACKEND_CALLBACK_URL  — backend base URL for callbacks
#   RUN_ID                — workflow run identifier

FROM node:22-slim

WORKDIR /app

# ── System dependencies ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        apt-transport-https \
        ca-certificates \
        gnupg \
        lsb-release \
        git \
        ripgrep \
        jq \
        wget \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# ── Google Cloud CLI + kubectl ─────────────────────────────────────────────
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] \
        https://packages.cloud.google.com/apt cloud-sdk main" \
        > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        google-cloud-cli \
        kubectl \
    && rm -rf /var/lib/apt/lists/*

# ── GitHub CLI ────────────────────────────────────────────────────────────
# Pinned tarball rather than the apt repo: one fewer keyring to rotate, and the
# version is visible in the image. Only usable when the carrier grants the `gh`
# tool, which is what supplies GH_TOKEN.
RUN GH_VERSION=2.97.0 \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
        | tar -xz --strip-components=2 -C /usr/local/bin "gh_${GH_VERSION}_linux_amd64/bin/gh"

# ── Helm ──────────────────────────────────────────────────────────────────
RUN HELM_VERSION=3.17.3 \
    && curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
        | tar -xz --strip-components=1 -C /usr/local/bin linux-amd64/helm

# ── uv / uvx (for stdio MCP servers e.g. mcp-atlassian/Jira) ─────────────
# Installed into /usr/local, never /root/.local: the container runs as a
# non-root user, and /root is mode 700 — a symlink into it resolves to
# permission denied, taking uv, uvx, semble and graphify with it.
ENV UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN curl -LsSf https://astral.sh/uv/install.sh \
        | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh

# ── semble (code search) + graphify (codebase knowledge graph) ────────────
RUN uv tool install "semble[mcp]" \
    && uv tool install graphifyy \
    && chmod -R a+rX /opt/uv

# ── git config ────────────────────────────────────────────────────────────
# The credential helper resolves tokens from the environment per host
# (GIT_TOKEN_<HOST> / GIT_TOKEN), so any code host a granted tool configures
# works without this image knowing which forge it is.
COPY bin/git-credential-env /usr/local/bin/git-credential-env
COPY bin/seed-agent-home /usr/local/bin/seed-agent-home
RUN chmod +x /usr/local/bin/git-credential-env /usr/local/bin/seed-agent-home \
    && git config --system user.email "agent@container" \
    && git config --system user.name "Agent" \
    && git config --system credential.helper env

# ── Agent server Node app ─────────────────────────────────────────────────
# vendor/ is copied before `npm ci` because pi-post-compact is a file:
# dependency — the install fails outright if the directory is not there yet.
COPY vendor ./vendor
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── pi-mcp-adapter + pi-post-compact (extensions loaded by pi SDK) ─────────
# A SECOND install of the same vendored package, into the pi agent home. This
# copy is what pi discovers and loads as an extension for native tool calls
# (its `context` and `tool_result` hooks); the file: dependency installed above
# is what src/runner.js imports directly for the mcp-resolver loop. Same code,
# two consumers.
# Baked at PI_BAKED_AGENT_DIR, not at PI_CODING_AGENT_DIR: the latter is a
# writable mount at runtime (pi writes settings.json / mcp.json / mcp-cache.json
# / sessions/ there) and a mount would hide anything baked underneath it. The
# entrypoint copies this tree in at start — see bin/seed-agent-home.
COPY vendor/pi-post-compact /opt/pi/agent/vendor/pi-post-compact
RUN mkdir -p /opt/pi/agent/npm && \
    cd /opt/pi/agent/npm && \
    npm init -y && \
    npm install pi-mcp-adapter@2.11.0 --legacy-peer-deps && \
    npm install /opt/pi/agent/vendor/pi-post-compact --legacy-peer-deps --install-links

COPY src ./src

# ── Non-root runtime ──────────────────────────────────────────────────────
# `node` (uid/gid 1000) ships with the base image. Every path written at run
# time lives under one of these three, so the root filesystem can be mounted
# read-only: HOME (pi agent dir, kube cache, gcloud config), /tmp (credential
# temp files, the disabled-command stubs) and /workspace (restored repos and
# .tool_artifacts). The chart mounts an emptyDir over each; a plain
# `docker run` gets the image's own writable copies instead.
ENV HOME=/home/node \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_BAKED_AGENT_DIR=/opt/pi/agent \
    CLOUDSDK_CONFIG=/home/node/.config/gcloud \
    npm_config_cache=/tmp/.npm

RUN mkdir -p /workspace /home/node/.pi/agent /home/node/.config \
    && chown -R node:node /workspace /home/node

USER node

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/seed-agent-home"]
CMD ["node", "src/server.js"]
