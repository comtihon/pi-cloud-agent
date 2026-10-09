# pi-carrier-agent

The [pi coding agent](https://github.com/earendil-works/pi) as an
[ACP](https://agentclientprotocol.com) (Agent Client Protocol) agent, built on the pi SDK
in-process (`createAgentSession`), for
[**ai-agents-carrier**](https://github.com/comtihon/ai-agents-carrier).

`pi-carrier-agent` speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. In the agent pod it runs
behind [**acp-web-proxy**](https://github.com/comtihon/acp-web-proxy), which serves it over
WebSocket with bearer auth, reconnect-with-replay and an idle timeout:

```
carrier ──ws://<pod>:8000/acp (ACP)──► acp-web-proxy ──stdio (ACP)──► pi-carrier-agent ──► pi SDK session
                                                                       (tools, MCP, bash, git, kubectl…)
```

Context optimisations (tool-result compaction, truncation, artifacts, collapse) live in the
[**pi-post-compact**](https://github.com/comtihon/pi-post-compact) pi extension, which pi loads
like any other package — this repo no longer intercepts provider requests.

---

## The ACP contract

Framing: one JSON object per line, split on `"\n"` only (not `readline`, which also breaks on
U+2028/U+2029 inside JSON strings). stdout carries the protocol only; logs go to stderr.

### `initialize`

```json
{"protocolVersion": 1,
 "agentCapabilities": {"loadSession": true,
   "promptCapabilities": {"image": true, "audio": false, "embeddedContext": false},
   "mcpCapabilities": {"http": true, "sse": true},
   "_meta": {"carrier": {"version": "<pkg version>", "ask": true}}},
 "agentInfo": {"name": "pi-carrier-agent", "version": "<pkg version>"},
 "authMethods": []}
```

### `session/new {cwd, mcpServers, _meta: {carrier: <agent_config>}}`

`agent_config` is what carrier's `_build_agent_config` builds — `system_prompt`, `model`, `tools`,
`blocked_commands`, `mcp_servers`, `credentials`, `extra`, `env_vars`, `expected_output_fields` —
plus `run_id` / `task_id`. `mcpServers` is ACP-shaped, already converted by carrier:
stdio `{name, command, args, env: [{name, value}]}`, http/sse
`{type, name, url, headers: [{name, value}]}`.

In order, the agent:

1. registers the granted tools that exist on `PATH`, installs their env (undoing the previous
   session's), shadows `blocked_commands` with exit-127 stubs, and puts `credentials`, `env_vars`,
   the LLM key (`extra.llm_api_key_env`) and `extra.llm_base_url` on the process env;
2. materialises `*_JSON` service-account keys and activates gcloud;
3. restores the workspace from `gs://<extra.s3_bucket>/<extra.s3_path>/workspace.tar.gz` into
   `cwd` (default `/workspace`) and runs each tool's `workspace_hook` per repo — all async;
4. pre-starts stdio MCP servers as local streamable-HTTP servers when carrier's matching
   `mcp_servers` entry does not say `prestart_http: false` (waits for the port, falls back to stdio);
5. writes pi-mcp-adapter's `mcp.json` from the ACP `mcpServers` (`Authorization: Bearer …` →
   `bearerToken`), plus a `carrier-cli-tools` stdio server when any tool has `cli_tools`, and
   `settings.json` with `packages: ["npm:pi-mcp-adapter", "npm:pi-post-compact"]`;
6. creates the pi session (`cwd`, model via `resolveModelConfig` — `extra.context_window` /
   `extra.max_tokens` for a custom endpoint, defaults 128000 / 16384), persisting the session file
   under `<cwd>/.pi-sessions/` so it is archived with the workspace.

`system_prompt` is a **real system prompt**: it is appended to pi's own system prompt through the
resource loader (`appendSystemPromptOverride`) and sent as the provider's `system` message every
turn — never prefixed to the user's text.

Result: `{sessionId, _meta: {carrier: {session_file}}}`.

### `session/load {sessionId, cwd, mcpServers, _meta}`

Re-applies the config, reopens the pi session file (`_meta.carrier.session_file`, or found by id in
`<cwd>/.pi-sessions/`; if it is not on disk the workspace is restored from GCS first) and replays
the history as `session/update` (`user_message_chunk`, `agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`) before responding.

### `session/prompt {sessionId, prompt: ContentBlock[]}`

Text and image blocks go to `session.prompt()` (resource links / text resources are inlined as
text). While it runs, pi events stream as `session/update`:

| pi event | ACP update |
|---|---|
| text delta | `agent_message_chunk` |
| thinking delta | `agent_thought_chunk` |
| tool execution start | `tool_call {toolCallId, title, kind, status: "in_progress", rawInput, _meta.carrier}` |
| tool execution end | `tool_call_update {toolCallId, status: "completed"\|"failed", rawOutput (≤ 8000 chars), content}` |
| assistant message end | `usage_update {used, size}` (context tokens / window) |

`kind`: `read`, `edit` (edit/write), `execute` (bash), `search` (grep/find/ls), MCP tools →
`fetch` (get/list/search/read/query… names) or `other`, with `_meta.carrier.mcp_server` /
`mcp_tool`; bash calls carry `_meta.carrier.tools` (granted tools matched by `bash_match`).

The workspace is uploaded **before** the response:

```json
{"stopReason": "end_turn" | "cancelled" | "max_tokens" | "refusal",
 "_meta": {"carrier": {"usage": {"input_tokens", "output_tokens", "total_tokens"},
                        "meta_usage": {"input_tokens", "output_tokens", "total_tokens"} | null,
                        "workspace_path": "gs://…/workspace.tar.gz" | null,
                        "final_text": "<last assistant text>"}}}
```

`usage` covers this prompt only. `meta_usage` is pi-post-compact's meta-LLM spend from its
`post-compact:stats` event, or `null`. A model error answers JSON-RPC `-32603` with the same
`_meta` in `error.data`.

### `session/cancel` (notification)

`session.abort()`; the pending `session/prompt` resolves with `stopReason: "cancelled"`.

### Questions (agent → client requests)

| pi extension UI | client request | expected result |
|---|---|---|
| `select(title, options)` | `session/request_permission {sessionId, toolCall: {toolCallId, title}, options: [{optionId, name, kind: "allow_once"}…]}` | `{outcome: {outcome: "selected", optionId} \| {outcome: "cancelled"}}` |
| `confirm(title, message)` | same, options `yes` (`allow_once`) / `no` (`reject_once`) | same |
| `input` / `editor` | `_carrier/ask {sessionId, question}` | `{answer: string}` or `{cancelled: true}` |

Unknown methods answer `-32601`; failures `-32603` with the message.

---

## Runtime configuration

| Env var                          | Purpose |
| -------------------------------- | ------- |
| `ACP_PROXY_TOKEN`                | Bearer token acp-web-proxy accepts (required; stripped from the agent's env). |
| `PI_CARRIER_DEFAULT_CWD`         | Session `cwd` when `session/new` omits it. Default `/workspace`. |
| `ANTHROPIC_API_KEY`              | Anthropic provider credentials. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | OpenAI-compatible provider (OpenRouter etc.). |
| `META_LLM_PROVIDER`, `META_LLM_MODEL` | Model pi-post-compact uses for compaction summaries. |
| `GIT_TOKEN`, `GIT_TOKEN_<HOST>`  | Token for HTTPS git operations, read by the credential helper (see below). |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCS workspace persistence + `gcloud`/`kubectl`/`helm` access. |
| `PI_CODING_AGENT_DIR`            | pi agent home, a writable mount. Default `$HOME/.pi/agent`; the image bakes its extensions at `PI_BAKED_AGENT_DIR` (`/opt/pi/agent`) and the entrypoint seeds this directory from it. |

Normally all of these arrive per session in `session/new` (`credentials`, `env_vars`, tool `env`).
Tool credentials are **not** configured on the image — they arrive per run with
the tool that needs them (see [Per-run tool grants](#per-run-tool-grants)).

The image ships a general toolbox — `git`, `ripgrep`, `jq`, `gcloud`, `kubectl`,
`helm`, `uv`/`uvx` and a couple of code-search CLIs — but shipping a binary is
not the same as granting it: only the tools a run is granted are usable.

Workspaces are checkpointed to GCS after every prompt (`src/workspace.js`), together with the pi
session file, which is how a multi-step run — or `session/load` — resumes on a fresh pod.

---

## Per-run tool grants

The agent hardcodes no tool name, env var or alias. The caller decides what a
run may use and sends it in `agent_config`, with credentials already resolved:

```json
{
  "tools": [
    {
      "name": "tracker",
      "command": "tracker-cli",
      "env": { "TRACKER_URL": "https://tracker.example", "TRACKER_TOKEN": "…" },
      "bash_match": "tracker-cli",
      "cli_tools": {
        "tracker_get_item": {
          "args": ["show", "{item_id}"],
          "required": ["item_id"],
          "optional": { "format": ["--format", "{format}"] },
          "timeout_seconds": 60
        }
      },
      "workspace_hook": {
        "args": ["index", "."],
        "requires_files": ["tracker-cache/state.json"],
        "timeout_seconds": 120
      }
    }
  ],
  "blocked_commands": ["some-binary-this-run-may-not-use"]
}
```

A grant is an *allowance*; usability also depends on the image. The agent
registers the intersection of granted tools and binaries actually present on
`PATH`, and logs the rest as skipped, so a grant referring to a tool this image
does not ship degrades instead of failing the run.

* **`command`** — the binary to look for. Omit it for an env-only tool (one that
  just needs credentials exported); those are always usable.
* **`env`** — exported to `process.env` so bash and subprocesses inherit it.
  The keys installed by the previous run are removed first, so on a warm pod a
  revoked tool cannot reuse the credentials of the run before it.
* **`bash_match`** — regex marking which bash commands exercise this tool,
  reported as `_meta.carrier.tools` on the bash `tool_call` update.
* **`cli_tools`** — CLI invocations exposed as MCP tools by the local
  `carrier-cli-tools` stdio MCP server (`src/cli-tools-mcp.js`), for a tool with
  no MCP server of its own; the model reaches them through pi-mcp-adapter like
  any MCP tool (e.g. `carrier_cli_tools_<name>`). `{name}` placeholders are
  filled from the call arguments (`{name|fallback}` supplies a default) and
  define the input schema, `cwd` sets the working directory, and
  `requires_files` refuses the call unless those files exist.
* **`workspace_hook`** — a command run once per restored workspace repo before
  the agent starts, for a tool keeping a per-repo cache or index. It runs only
  in repos already containing every `requires_files` entry, so it refreshes an
  existing cache and never bootstraps one. It is timeout-bounded, and a failure
  is logged without failing the run.
* **`blocked_commands`** — binaries the image ships but this run may not use.
  Each is shadowed by an exit-127 stub on a `PATH` prefix.

Argv always comes from these descriptors as an array and is passed straight to
`execFile`/`spawn` — nothing is interpolated into a shell.

### MCP servers

MCP servers arrive as ACP `mcpServers` in `session/new`. A stdio server is
pre-started as a local streamable-HTTP server (`--transport streamable-http
--port N`, then the port is polled) so `pi-mcp-adapter` connects instantly
instead of racing a 15-30s subprocess boot — but only when carrier's own
`_meta.carrier.mcp_servers` entry of the same name exists and does not say
**`"prestart_http": false`** (a CLI with no `--transport`/`--port`); otherwise
it is wired as a plain stdio entry.

### Git credentials

`bin/git-credential-env` is installed as a git credential helper and answers
from the environment, per host: for `example.com` it reads
`GIT_TOKEN_EXAMPLE_COM` / `GIT_USERNAME_EXAMPLE_COM`, then falls back to
`GIT_TOKEN` / `GIT_USERNAME` (username defaults to `x-access-token`).

So a tool that grants code-host access just declares the matching variable in
its `env`. Nothing is written to disk, no token ever reaches a command line, no
forge is hardcoded, and when the tool is not granted the variable is absent and
the helper stays silent — which is what revokes the access.

---

## Build & run

```bash
# tests (Node 22+ required by the pi SDK; the tests themselves stub pi)
npm ci
npm test

# the agent alone, on stdio
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | npx pi-carrier-agent

# container: acp-web-proxy on :8000 (/acp, /health) spawning pi-carrier-agent
docker build -t pi-cloud-agent .
docker run --rm -p 8000:8000 -e ACP_PROXY_TOKEN=secret pi-cloud-agent
curl localhost:8000/health
```

The image installs acp-web-proxy from a git checkout and builds it there (`ACP_WEB_PROXY_REF`
build arg, default `main`): the proxy repo does not commit `dist/` and has no `prepare` script, so a
plain `npm i -g github:comtihon/acp-web-proxy` would install it without its `dist/cli.js`.
The proxy config is `docker/acp-web-proxy.yaml` → `/etc/acp-web-proxy/config.yaml`.

## Deploy

Published on every push to `main` (image and chart keep the `pi-cloud-agent` name):

- Docker image — `ghcr.io/comtihon/pi-cloud-agent:v<version>` (plus `:latest`)
- Helm chart — `oci://ghcr.io/comtihon/charts/pi-cloud-agent` version `<version>`

```bash
helm upgrade --install my-agent oci://ghcr.io/comtihon/charts/pi-cloud-agent \
  --set-string env.ACP_PROXY_TOKEN=$(openssl rand -hex 16) \
  --set healthchecks.enabled=true
```

### Wiring it into ai-agents-carrier

An agent definition with `protocol: acp` (carrier's ACP executor) and `default_runtime: k8s`
pointing at the chart. The runtime sets `env.ACP_PROXY_TOKEN` (fresh per pod); the executor
connects to `ws://<release>:8000/acp`, sends `initialize`, `session/new` with the agent_config in
`_meta.carrier`, then `session/prompt`, answering `session/request_permission` and `_carrier/ask`.
`.Values.env` is rendered as plain container env vars (`.Values.config` and `.Values.secrets` are
also supported for static config and existing k8s Secrets).

## Layout

```
bin/pi-carrier-agent   entry point (ACP on stdio)
src/main.js            wiring: stdout guard, connection, setup, session factory
src/acp/protocol.js    "\n" framing + JSON-RPC peer (requests both ways, id correlation)
src/acp/agent.js       ACP handlers: initialize, session/new|load|prompt|cancel, questions
src/acp/updates.js     pi events/messages → session/update payloads
src/config/env.js      agent_config → process env, tools, blocked commands
src/config/mcp.js      ACP mcpServers → mcp.json, settings.json, MCP pre-start
src/config/model.js    agent_config → pi model + auth
src/config/index.js    one session/new's setup, in order
src/pi-session.js      createAgentSession with the carrier system prompt and event bus
src/workspace.js       async GCS restore/upload, gcloud activation, workspace hooks
src/tools.js           tool registration, per-tool env, CLI templates, hook planning
src/cli-tools-mcp.js   carrier-cli-tools: stdio MCP server for tools[].cli_tools
docker/                acp-web-proxy config baked into the image
bin/                   also: git credential helper, agent-home seeder
vendor/                pi-post-compact, installed into the pi agent home as an extension
helm/                  Helm chart (published as an OCI artifact)
```

## License

MIT — same as upstream pi. See [LICENSE](LICENSE).
