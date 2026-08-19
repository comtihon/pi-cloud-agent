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

# ── Helm ──────────────────────────────────────────────────────────────────
RUN HELM_VERSION=3.17.3 \
    && curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
        | tar -xz --strip-components=1 -C /usr/local/bin linux-amd64/helm

# ── uv / uvx (for stdio MCP servers e.g. mcp-atlassian/Jira) ─────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ln -s /root/.local/bin/uv /usr/local/bin/uv \
    && ln -s /root/.local/bin/uvx /usr/local/bin/uvx

# ── semble (code search) + graphify (codebase knowledge graph) ────────────
RUN uv tool install "semble[mcp]" \
    && ln -s /root/.local/bin/semble /usr/local/bin/semble \
    && uv tool install graphifyy \
    && ln -s /root/.local/bin/graphify /usr/local/bin/graphify

# ── git config ────────────────────────────────────────────────────────────
RUN git config --global user.email "agent@container" \
    && git config --global user.name "Agent"

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
COPY vendor/pi-post-compact /root/.pi/agent/vendor/pi-post-compact
RUN mkdir -p /root/.pi/agent/npm && \
    cd /root/.pi/agent/npm && \
    npm init -y && \
    npm install pi-mcp-adapter@2.11.0 --legacy-peer-deps && \
    npm install /root/.pi/agent/vendor/pi-post-compact --legacy-peer-deps --install-links

COPY src ./src

EXPOSE 8000

CMD ["node", "src/server.js"]
