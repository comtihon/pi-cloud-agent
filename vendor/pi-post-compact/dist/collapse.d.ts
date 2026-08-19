/**
 * Retroactive-collapse primitives.
 *
 * Compaction (see compact.ts) shrinks a tool result *before* the model ever
 * sees it. Collapse is the complement: content the model genuinely needed
 * verbatim is kept verbatim for the turn or two it is actually reasoned over,
 * then replaced by a stub for the rest of the run. Nothing here knows what a
 * message looks like — hosts supply the targets and do the mutation, so the same
 * timing rules serve pi's own `AgentMessage[]` and any provider wire format.
 */
/** Default number of extra round-trips a tracked target rides verbatim. */
export declare const DEFAULT_COLLAPSE_DELAY = 1;
export interface CollapseEntry<TTarget, TMeta = undefined> {
    target: TTarget;
    /** Round-trip index the target was created in. */
    roundTripCreated: number;
    meta: TMeta;
}
/**
 * Tracks targets awaiting collapse and decides when each becomes due.
 *
 * `delay` is how many *additional* round-trips a target rides verbatim after
 * the one it was created in:
 *
 * - `delay: 0` — collapse as soon as a later round-trip begins. Correct for tool
 *   results, which the model reasons over in the round-trip right after creation.
 * - `delay: 1` — collapse one round-trip later still. Correct for assistant
 *   tool-call arguments and assistant message content: arguments created in
 *   round *r* are executed in *r+1*, so collapsing at *r+1* would rewrite them
 *   before they run; the model has only reasoned over the outcome by *r+2*.
 */
export declare class CollapseTracker<TTarget, TMeta = undefined> {
    private readonly delay;
    private readonly entries;
    constructor(delay?: number);
    get size(): number;
    has(id: string): boolean;
    /** Register a target. Re-tracking an existing id is a no-op, preserving its original round-trip. */
    track(id: string, target: TTarget, meta: TMeta, roundTrip: number): void;
    /** True when some tracked entry already points at `target`. */
    tracksTarget(target: TTarget): boolean;
    /**
     * Entries whose verbatim window has closed by `roundTrip`. Snapshotted, so a
     * caller may `delete()` while iterating.
     */
    due(roundTrip: number): Array<[string, CollapseEntry<TTarget, TMeta>]>;
    delete(id: string): void;
    ids(): string[];
    targets(): TTarget[];
    clear(): void;
}
/**
 * Index of the first message still subject to in-place collapse.
 *
 * Everything strictly before it is stable and therefore cacheable by the
 * provider; that message and everything after it may still be rewritten.
 * Returns `messages.length` when nothing is pending.
 *
 * Observability only — it attaches no `cache_control` and alters no request.
 * Retroactive collapse and prompt caching pull against each other: rewriting a
 * message invalidates the provider's cached prefix from that point on, so the
 * collapse delay is what limits the damage. Measure before assuming collapse is
 * a net win on a cache-friendly provider.
 */
export declare function cacheFrontierIndex<TMessage>(messages: readonly TMessage[], isPending: (message: TMessage, index: number) => boolean): number;
/** Truncate `text` to `maxChars`, appending a visible notice when it was cut. */
export declare function truncateWithNotice(text: string, maxChars: number, notice?: string): string;
/**
 * One-line description of an assistant tool call's arguments, used as the stub
 * that replaces them once the call has run.
 *
 * Purely lexical — no LLM — because the interesting part of a large argument
 * blob is almost always the target and the size, not the payload: a `write` is
 * identified by its path, a `bash` by its first line plus any redirect target.
 */
export declare function summarizeToolCallArgs(fnName: string, argsString: unknown): string;
