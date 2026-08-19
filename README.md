# pi-cloud-agent

The [pi coding agent](https://github.com/earendil-works/pi) wrapped in an HTTP web server, so it
can be spawned as a container/pod, driven over REST, and torn down when the job is done.

It is a drop-in agent runtime for
[**ai-agents-carrier**](https://github.com/comtihon/ai-agents-carrier) — the carrier's
`langgraph-agent` / `claude-agent` workflow steps deploy this chart, `POST /start`, and poll for
output. Nothing here is carrier-specific though: the HTTP contract is small enough to drive from
anything.

On top of plain pi, this image ships **token-consumption optimizations** (see below) built around
[**pi-post-compact**](https://github.com/comtihon/pi-post-compact).

---

## What it is

`src/server.js` is an Express app holding one pi agent session. `src/runner.js` runs that session
in-process via the pi SDK (`createAgentSession`) — no pi CLI subprocess, no RPC layer. Progress and
the final result are buffered in memory and drained by the caller's polling.

```
carrier ──POST /start──▶ pi-cloud-agent ──▶ pi SDK session (tools, MCP, bash, git, kubectl…)
        ◀──GET /poll────  (progress → final)
```

### HTTP API

| Method | Path         | Purpose |
| ------ | ------------ | ------- |
| `GET`  | `/health`    | `{"status":"ok"}` — readiness/liveness. |
| `GET`  | `/status`    | Internal status: `idle` \| `running` \| `done` \| `failed`. |
| `GET`  | `/poll`      | Drains buffered outputs. Status is mapped to the carrier protocol (`idle`/`working`/`finished`/`failed`). Progress outputs are delivered once; `final` is re-sent on every poll so a dropped socket cannot lose the result. |
| `POST` | `/start`     | Starts a run. `202` with `started`, or `already_processed` for a repeat `run_id`, or `409` while busy. |
| `POST` | `/terminate` | Aborts the session and exits the process. |

`POST /start` body:

```json
{
  "run_id": "…",
  "task_id": "…",
  "input": { },
  "callback_url": "http://ai-agents-carrier.langgraph.svc.cluster.local:8000",
  "agent_config": { "system_prompt": "…", "model": "…", "tools": [], "env_vars": {} }
}
```

`callback_url` is used for the interactive path: the agent `POST`s a clarification question to
`{callback_url}/api/v1/runs/{run_id}/agent/question` and long-polls `…/agent/input` for the answer.

---

## Token consumption optimizations

A long agent run spends most of its tokens re-sending old tool output. This image cuts that down
without losing the information the model actually needs.

The policy itself — thresholds, prompts, collapse timing, artifact handling — lives in
[**pi-post-compact**](https://github.com/comtihon/pi-post-compact), which is both a pi extension and
a library. That split is deliberate, because this image reduces tokens along two paths that share
one implementation:

| Path | Used for | Driven by |
|---|---|---|
| pi extension (`tool_result` + `context` hooks) | native pi tool calls | pi's own agent loop |
| direct library calls | the `mcp` gateway loop below | `src/runner.js` |

The gateway loop drives its own provider requests and never passes through pi's agent loop, so the
extension's hooks never fire for it — hence the second consumer. Same code, same behavior.

### What it does

- **Tool-result compaction** — `mcp` and `bash` results are summarized by a cheap meta-LLM focused on
  a caller-declared `reason`, instead of being carried verbatim. Results marked `exact: true`, or
  shorter than the threshold, skip it; if the summary would not shrink the output, the raw text is
  kept. Meta-LLM cost is accumulated per run and reported separately from the agent's own usage.
- **Verbatim results collapse after first use** — a result the model needed verbatim is kept verbatim
  for exactly one round-trip, then replaced by a one-sentence *finding* ("what did I learn"), which
  compresses far harder than a description of the same output.
- **Tool-call argument collapse** — large arguments (a full file body in a `write`) are replaced by a
  lexical stub once the call has run. No LLM involved.
- **Assistant content collapse** — oversized assistant messages collapse on later round-trips.
- **Hard result ceiling** — anything still oversized is truncated.
- **Single `mcp` gateway tool** — every MCP server's tools are reached through one
  `mcp({tool, args, reason})` tool whose description is a flat name list (capped at 60), instead of
  injecting a full JSON schema per tool into every request. The usage example is generated from the
  tools actually configured for the run. This part is specific to this image.
- **Cache-frontier bookkeeping** — tracks the first message still subject to rewriting, so everything
  before it is stable and prompt-cacheable. Observability only; it does not attach `cache_control`.

Displaced originals are written to `/workspace/.tool_artifacts` and named in the stub that replaces
them, so nothing is unrecoverable — `read_artifact` inside the gateway loop, or an ordinary `read`
on the native path.

Note the tension: rewriting history invalidates a provider's cached prefix from the first rewritten
message onward. The collapse delay bounds it, but on a provider you rely on for prompt caching this
is worth measuring rather than assuming.

### Tunables

| Env var                        | Default | Effect |
| ------------------------------ | ------- | ------ |
| `MCP_COMPACT_MIN_CHARS`        | `800`   | Below this, a gateway-loop tool result is not summarized. |
| `MCP_ARG_COLLAPSE_MIN_CHARS`   | `800`   | Below this, tool-call arguments are left alone. |
| `MCP_TOOL_RESULT_MAX_CHARS`    | `20000` | Hard truncation ceiling for a tool result. |
| `MCP_RESOLVER_CALL_TIMEOUT_MS` | `120000` | Timeout for one chained call in the gateway loop. |
| `META_LLM_PROVIDER` / `META_LLM_MODEL` | — | Model used for summaries. Falls back to `anthropic/claude-haiku-4-5`. |

If `pi-post-compact` cannot summarize — no credentials, provider error, empty response — every path
falls back to the raw text rather than losing data.

---

## Runtime configuration

| Env var                          | Purpose |
| -------------------------------- | ------- |
| `AGENT_PORT`                     | Listen port. Default `8000`. |
| `ANTHROPIC_API_KEY`              | Anthropic provider credentials. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | OpenAI-compatible provider (OpenRouter etc.). |
| `META_LLM_PROVIDER`, `META_LLM_MODEL` | Model used for compaction summaries. |
| `GITHUB_TOKEN`                   | GitHub MCP / git operations. |
| `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN` | Jira MCP (stdio, via `uvx`). |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCS workspace persistence + `gcloud`/`kubectl`/`helm` access. |
| `PI_CODING_AGENT_DIR`            | pi agent home. Default `/root/.pi/agent`. |

The image ships `git`, `ripgrep`, `jq`, `gcloud`, `kubectl`, `helm`, `uv`/`uvx`,
`semble` (semantic code search) and `graphify` (codebase knowledge
graph), so the agent has a usable toolbox out of the box.

Workspaces can be checkpointed to GCS between steps of a workflow (`src/workspaceS3.js`), which is
how a multi-step run resumes on a fresh pod.

---

## Build & run

```bash
# tests (Node 22+ required)
npm ci
npm test

# container
docker build -t pi-cloud-agent .
docker run --rm -p 8000:8000 -e ANTHROPIC_API_KEY=… pi-cloud-agent
curl localhost:8000/health
```

## Deploy

Published on every push to `main`:

- Docker image — `ghcr.io/comtihon/pi-cloud-agent:v<version>` (plus `:latest`)
- Helm chart — `oci://ghcr.io/comtihon/charts/pi-cloud-agent` version `<version>`

```bash
helm upgrade --install my-agent oci://ghcr.io/comtihon/charts/pi-cloud-agent \
  --set-string env.ANTHROPIC_API_KEY=…
```

### Wiring it into ai-agents-carrier

Register an agent definition with `default_runtime: k8s` and point it at the chart:

```json
{
  "id": "researcher-fast",
  "default_runtime": "k8s",
  "helm_chart": "oci://ghcr.io/comtihon/charts/pi-cloud-agent",
  "helm_values": { "healthchecks.enabled": "true" },
  "agent_input": { "system_prompt": "…", "model": "…", "env_vars": { } }
}
```

The carrier's `K8sRuntime` runs `helm upgrade --install agent-<agent_id>-<run_id>` and injects
`env.AGENT_PORT`, `env.BACKEND_CALLBACK_URL`, `env.RUN_ID`, and one `env.<KEY>` per
`agent_input.env_vars` entry. The chart renders `.Values.env` as plain container env vars, so those
overrides reach the process (`.Values.config` and `.Values.secrets` are also supported for static
config and existing k8s Secrets).

## Layout

```
src/            HTTP server, pi SDK runner, backend client, GCS workspace helpers
test/           node:test suites
vendor/         pi-post-compact — installed twice by the Dockerfile: as this
                package's file: dependency (imported by src/runner.js) and into
                the pi agent home (loaded by pi as an extension)
helm/           Helm chart (published as an OCI artifact)
Dockerfile      Node 22 + gcloud/kubectl/helm/uv/semble/graphify toolbox
```

## License

MIT — same as upstream pi. See [LICENSE](LICENSE).
