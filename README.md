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
without losing the information the model actually needs:

- **Post-hoc tool-result compaction** — `mcp` and `bash` results are summarized by a cheap meta-LLM
  via [pi-post-compact](https://github.com/comtihon/pi-post-compact) instead of being carried
  verbatim. Results marked `exact: true`, or shorter than the threshold, skip compaction; if the
  summary would not shrink the output, the raw text is kept. Meta-LLM cost is accumulated per run
  and reported.
- **Exact-result collapse after first use** — a result the model needed verbatim is kept verbatim
  for exactly one turn, then collapsed in place to a short action summary.
- **Tool-call argument collapse** — large assistant tool-call arguments (a full file body in a
  `write`, for instance) are replaced by a one-sentence stub once the call has been answered.
- **Assistant content collapse** — oversized assistant messages collapse in place on later turns.
- **Hard result ceiling** — anything still oversized after the above is truncated.
- **Cache-frontier bookkeeping** — tracks the first message still subject to in-place mutation, so
  everything before it is stable and prompt-cacheable. Currently observability only; it does not
  attach `cache_control` yet.
- **Single `mcp` gateway tool** — every MCP server's tools are reached through one
  `mcp({tool, args, reason})` tool whose description is a flat name list (capped at 60), instead of
  injecting a full JSON schema per tool into every request. The usage example is generated from the
  tools actually configured for the run.

Tunables (all optional, defaults shown):

| Env var                        | Default | Effect |
| ------------------------------ | ------- | ------ |
| `MCP_COMPACT_MIN_CHARS`        | `800`   | Below this, a tool result is not sent to the compactor. |
| `MCP_ARG_COLLAPSE_MIN_CHARS`   | `800`   | Below this, tool-call arguments are left alone. |
| `MCP_TOOL_RESULT_MAX_CHARS`    | `20000` | Hard truncation ceiling for a tool result. |
| `MCP_RESOLVER_CALL_TIMEOUT_MS` | —       | Timeout for a resolver call. |

If `pi-post-compact` cannot be loaded, compaction is disabled and the run falls back to
raw/truncated output rather than failing.

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
vendor/         pi-post-compact, installed into the pi agent home by the Dockerfile
helm/           Helm chart (published as an OCI artifact)
Dockerfile      Node 22 + gcloud/kubectl/helm/uv/semble/graphify toolbox
```

## License

MIT — same as upstream pi. See [LICENSE](LICENSE).
