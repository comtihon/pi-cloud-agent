/**
 * Retroactive collapse for native pi sessions, driven by the `context` hook.
 *
 * `context` fires before every LLM call with a deep copy of the message list and
 * replaces whatever it returns. That makes it the right seam for this: the
 * session's own history — and therefore `/compact`, resume, and the transcript —
 * keeps full fidelity, while only the outgoing payload shrinks.
 *
 * The deep copy has one consequence that shapes everything below: mutations do
 * not persist, so every summary must be cached by a stable id or it would be
 * recomputed (and re-billed) on every single request.
 */
import { ASSISTANT_CONTENT_REASON, buildActionSummaryInstruction, compactOrKeep, DEFAULT_MIN_CHARS, } from "./compact.js";
import { collapseStub } from "./artifacts.js";
import { cacheFrontierIndex, summarizeToolCallArgs, truncateWithNotice } from "./collapse.js";
function isToolResult(msg) {
    return msg.role === "toolResult" && Array.isArray(msg.content);
}
function isAssistant(msg) {
    return msg.role === "assistant" && Array.isArray(msg.content);
}
function isTextBlock(block) {
    return block.type === "text" && typeof block.text === "string";
}
function isToolCallBlock(block) {
    return block.type === "toolCall" && typeof block.id === "string";
}
/**
 * Stable identity for an assistant message across `context` invocations.
 *
 * Unlike tool results, assistant messages carry no id of their own, so identity
 * is derived from the provider response id when present and the timestamp
 * otherwise. Both survive the deep copy; the index disambiguates the rare case
 * of two messages sharing a timestamp.
 */
function assistantKey(msg, index) {
    return `asst-${msg.responseId ?? msg.timestamp ?? "t"}-${index}`;
}
/**
 * Stateful collapse engine. One instance per session.
 *
 * Round-trips are counted per LLM call, and each candidate rides verbatim for a
 * bounded number of them before being replaced:
 *
 * - a tool result the model asked to keep verbatim (`post_compact.exact: true`)
 *   is collapsed to a one-sentence *finding* once a later round-trip begins;
 * - large tool-call arguments and large assistant text are collapsed one further
 *   round-trip out, because arguments created in round *r* only execute in
 *   *r+1*, so rewriting them any earlier would change what runs.
 */
export class ContextCollapseEngine {
    options;
    roundTrip = 0;
    /** id → round-trip it was first seen in. */
    firstSeen = new Map();
    /** id → cached replacement text, so a summary is paid for exactly once. */
    summaries = new Map();
    /** toolCallId → focus string, captured from an `exact: true` directive. */
    exactReasons = new Map();
    /** ids still inside their verbatim window, for the cache-frontier report. */
    pendingIds = new Set();
    /** ids awaiting collapse as of the last transform, exposed for diagnostics. */
    getPendingIds() {
        return [...this.pendingIds];
    }
    stats = {
        roundTrip: 0,
        collapsedToolResults: 0,
        collapsedToolCallArgs: 0,
        collapsedAssistantContent: 0,
        truncatedToolResults: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cacheFrontier: 0,
    };
    constructor(options = {}) {
        this.options = options;
    }
    /** Record that a tool result was produced under an `exact: true` directive. */
    noteExactResult(toolCallId, reason) {
        this.exactReasons.set(toolCallId, reason);
    }
    /** Reset per-run counters. Call on `agent_start`. */
    startRun() {
        this.roundTrip = 0;
    }
    getStats() {
        return { ...this.stats, usage: { ...this.stats.usage } };
    }
    log(message) {
        this.options.log?.(message);
    }
    addUsage(usage) {
        if (!usage)
            return;
        this.stats.usage.prompt_tokens += usage.prompt_tokens || 0;
        this.stats.usage.completion_tokens += usage.completion_tokens || 0;
        this.stats.usage.total_tokens += usage.total_tokens || 0;
    }
    /** True once `id`'s verbatim window has closed. */
    isDue(id, delay) {
        const created = this.firstSeen.get(id);
        return created !== undefined && this.roundTrip > created + delay;
    }
    seen(id) {
        if (!this.firstSeen.has(id))
            this.firstSeen.set(id, this.roundTrip);
    }
    /**
     * Summarize once, then serve from cache forever.
     *
     * A cache miss costs an LLM call inside the request path, which is the same
     * price paid by compaction at `tool_result`; a cache hit costs nothing, which
     * is what makes per-request rewriting affordable at all.
     */
    async summarize(id, text, compactOpts, deps) {
        const cached = this.summaries.get(id);
        if (cached !== undefined)
            return cached;
        const result = await compactOrKeep(text, { exact: false, reason: compactOpts.reason, prompt: compactOpts.prompt, style: "caveman-one-sentence" }, deps);
        this.addUsage(result.usage);
        if (!result.changed)
            return undefined;
        this.summaries.set(id, result.text);
        return result.text;
    }
    /**
     * Rewrite `messages` for the outgoing request. Returns the same array,
     * mutated in place — safe because the `context` hook hands over a deep copy.
     *
     * Never throws: `transformContext`'s contract requires a usable message list,
     * so a failure here must degrade to the uncollapsed input rather than abort
     * the turn.
     */
    async transform(messages, deps) {
        this.roundTrip++;
        this.stats.roundTrip = this.roundTrip;
        const minChars = this.options.minChars ?? DEFAULT_MIN_CHARS;
        const maxChars = this.options.maxToolResultChars ?? 0;
        const artifacts = this.options.artifacts;
        const pending = new Set();
        try {
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                if (isToolResult(msg)) {
                    await this.collapseToolResult(msg, { minChars, maxChars, artifacts, deps, pending });
                    continue;
                }
                if (isAssistant(msg)) {
                    const key = assistantKey(msg, i);
                    await this.collapseAssistantContent(msg, key, { minChars, artifacts, deps, pending });
                    await this.collapseToolCallArgs(msg, { minChars, artifacts, deps, pending });
                }
            }
        }
        catch (err) {
            this.log(`collapse aborted, sending context unchanged: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.pendingIds = pending;
        this.stats.cacheFrontier = cacheFrontierIndex(messages, (m, i) => messageIsPending(m, i, pending));
        return messages;
    }
    async collapseToolResult(msg, ctx) {
        // Only results the model explicitly kept verbatim are candidates; results
        // it let be summarized were already handled destructively at `tool_result`.
        const reason = this.exactReasons.get(msg.toolCallId);
        if (reason === undefined)
            return;
        if (msg.content.some((block) => block.type === "image"))
            return;
        const textBlocks = msg.content.filter(isTextBlock);
        if (textBlocks.length === 0 || textBlocks.length !== msg.content.length)
            return;
        const full = textBlocks.map((b) => b.text).join("\n");
        if (!full.trim() || full.length < ctx.minChars)
            return;
        const id = `tr-${msg.toolCallId}`;
        this.seen(id);
        if (!this.isDue(id, 0)) {
            ctx.pending.add(msg.toolCallId);
            // Still inside the verbatim window; only the hard ceiling applies.
            this.applyCeiling(msg, textBlocks, full, ctx.maxChars);
            return;
        }
        const summary = await this.summarize(id, full, { reason, prompt: buildActionSummaryInstruction(reason) }, ctx.deps);
        if (summary === undefined) {
            this.applyCeiling(msg, textBlocks, full, ctx.maxChars);
            return;
        }
        const path = ctx.artifacts?.write(`${msg.toolCallId}-result`, full);
        msg.content = [{ type: "text", text: collapseStub(summary, path) }];
        this.stats.collapsedToolResults++;
        this.log(`collapsed tool result ${msg.toolCallId} to action summary (reason: "${reason}")`);
    }
    applyCeiling(msg, textBlocks, full, maxChars) {
        if (maxChars <= 0 || full.length <= maxChars)
            return;
        msg.content = [{ type: "text", text: truncateWithNotice(full, maxChars) }];
        this.stats.truncatedToolResults++;
    }
    async collapseAssistantContent(msg, key, ctx) {
        const textBlocks = msg.content.filter(isTextBlock);
        if (textBlocks.length === 0)
            return;
        const full = textBlocks.map((b) => b.text).join("\n");
        if (full.length <= ctx.minChars)
            return;
        this.seen(key);
        if (!this.isDue(key, 1)) {
            ctx.pending.add(key);
            return;
        }
        const summary = await this.summarize(key, full, { reason: ASSISTANT_CONTENT_REASON }, ctx.deps);
        if (summary === undefined)
            return;
        const path = ctx.artifacts?.write(`${key}-content`, full);
        const stub = collapseStub(summary, path);
        // Replace only the text blocks; thinking and toolCall blocks must survive
        // intact or the provider rejects the message as an orphaned tool call.
        const first = msg.content.findIndex(isTextBlock);
        msg.content = msg.content.filter((b) => !isTextBlock(b));
        msg.content.splice(Math.max(first, 0), 0, { type: "text", text: stub });
        this.stats.collapsedAssistantContent++;
        this.log(`collapsed assistant content ${key} (${full.length} -> ${stub.length} chars)`);
    }
    async collapseToolCallArgs(msg, ctx) {
        for (const block of msg.content) {
            if (!isToolCallBlock(block))
                continue;
            const serialized = JSON.stringify(block.arguments ?? {});
            if (serialized.length <= ctx.minChars)
                continue;
            const id = `args-${block.id}`;
            this.seen(id);
            if (!this.isDue(id, 1)) {
                ctx.pending.add(block.id);
                continue;
            }
            if (this.summaries.has(id) && block.arguments?.collapsed === true)
                continue;
            const summary = summarizeToolCallArgs(block.name, serialized);
            const path = ctx.artifacts?.write(`${block.id}-args`, serialized);
            this.summaries.set(id, summary);
            block.arguments = path
                ? { collapsed: true, summary, artifact_path: path }
                : { collapsed: true, summary };
            this.stats.collapsedToolCallArgs++;
            this.log(`collapsed tool-call args ${block.id}: ${summary}`);
        }
    }
}
/**
 * Whether `msg` still holds content awaiting collapse, and therefore may still
 * be rewritten on a later request.
 */
function messageIsPending(msg, index, pending) {
    if (isToolResult(msg))
        return pending.has(msg.toolCallId);
    if (isAssistant(msg)) {
        if (pending.has(assistantKey(msg, index)))
            return true;
        for (const block of msg.content) {
            if (isToolCallBlock(block) && pending.has(block.id))
                return true;
        }
    }
    return false;
}
