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
import { type CompactOrKeepDeps, type CompactUsage } from "./compact.js";
import { type ArtifactStore } from "./artifacts.js";
type MessageLike = {
    role?: string;
} & Record<string, unknown>;
export interface ContextCollapseOptions {
    /** Text shorter than this is left alone. Defaults to `DEFAULT_MIN_CHARS`. */
    minChars?: number;
    /** Hard ceiling applied to any tool-result text that survives collapse. 0 disables. */
    maxToolResultChars?: number;
    /** Where displaced originals are written so the model can read them back. */
    artifacts?: ArtifactStore;
    log?: (message: string) => void;
}
export interface ContextCollapseStats {
    roundTrip: number;
    collapsedToolResults: number;
    collapsedToolCallArgs: number;
    collapsedAssistantContent: number;
    truncatedToolResults: number;
    /** Meta-LLM tokens spent this run. Never reaches session accounting — see compactOrKeep. */
    usage: CompactUsage;
    /** First message index still subject to collapse; everything before it is cacheable. */
    cacheFrontier: number;
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
export declare class ContextCollapseEngine {
    private readonly options;
    private roundTrip;
    /** id → round-trip it was first seen in. */
    private readonly firstSeen;
    /** id → cached replacement text, so a summary is paid for exactly once. */
    private readonly summaries;
    /** toolCallId → focus string, captured from an `exact: true` directive. */
    private readonly exactReasons;
    /** ids still inside their verbatim window, for the cache-frontier report. */
    private pendingIds;
    /** ids awaiting collapse as of the last transform, exposed for diagnostics. */
    getPendingIds(): string[];
    private readonly stats;
    constructor(options?: ContextCollapseOptions);
    /** Record that a tool result was produced under an `exact: true` directive. */
    noteExactResult(toolCallId: string, reason: string): void;
    /** Reset per-run counters. Call on `agent_start`. */
    startRun(): void;
    getStats(): ContextCollapseStats;
    private log;
    private addUsage;
    /** True once `id`'s verbatim window has closed. */
    private isDue;
    private seen;
    /**
     * Summarize once, then serve from cache forever.
     *
     * A cache miss costs an LLM call inside the request path, which is the same
     * price paid by compaction at `tool_result`; a cache hit costs nothing, which
     * is what makes per-request rewriting affordable at all.
     */
    private summarize;
    /**
     * Rewrite `messages` for the outgoing request. Returns the same array,
     * mutated in place — safe because the `context` hook hands over a deep copy.
     *
     * Never throws: `transformContext`'s contract requires a usable message list,
     * so a failure here must degrade to the uncollapsed input rather than abort
     * the turn.
     */
    transform(messages: MessageLike[], deps: CompactOrKeepDeps): Promise<MessageLike[]>;
    private collapseToolResult;
    private applyCeiling;
    private collapseAssistantContent;
    private collapseToolCallArgs;
}
export {};
