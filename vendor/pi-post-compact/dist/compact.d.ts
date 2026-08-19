export declare const DEFAULT_META_LLM = "anthropic/claude-haiku-4-5";
/** Default floor below which summarizing is not worth an extra LLM round-trip. */
export declare const DEFAULT_MIN_CHARS = 800;
export interface PostCompactDirective {
    exact: boolean;
    reason: string;
}
export interface PostCompactConfig {
    meta_llm?: string;
}
/**
 * Output-shape constraints appended to the summarization instruction.
 *
 * These exist because the caller previously had no way to influence the
 * summary's *form* — only its focus, via `reason`. Callers worked around that
 * by concatenating style directives onto `reason`, which mixed "what to look
 * for" with "how to write it" in a single field.
 */
export type CompactStyle = "plain" | "caveman" | "one-sentence" | "caveman-one-sentence";
export declare const STYLE_GUIDES: Record<CompactStyle, string>;
export interface CompactUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}
export interface CompactToolResultOptions extends PostCompactDirective {
    /**
     * Replaces the default "Summarize the following tool output…" instruction
     * outright. `reason` is then ignored for prompt construction (it stays
     * meaningful for logging). Use for summaries that answer a question about
     * the output rather than describing it — see `buildActionSummaryInstruction`.
     */
    prompt?: string;
    /** Output-shape constraint appended to the instruction. Defaults to "plain". */
    style?: CompactStyle;
}
/**
 * Instruction for collapsing a result the model already read verbatim.
 *
 * Distinct from the default summarize-this-output prompt: it answers "what did
 * I learn" rather than "what does this contain", which compresses far harder
 * because the answer is one fact instead of a description.
 */
export declare function buildActionSummaryInstruction(reason: string): string;
/** Focus string for collapsing a verbose assistant reasoning turn. */
export declare const ASSISTANT_CONTENT_REASON = "assistant reasoning turn \u2014 preserve decisions, findings, chosen approach, and any file paths or values";
export declare function loadConfig(cwd: string): PostCompactConfig;
export declare function parseMetaLlm(metaLlm: string): {
    provider: string;
    model: string;
} | undefined;
export interface ResolveMetaLlmOptions {
    /** Explicit value (e.g. a CLI flag) — wins over everything else. */
    flag?: string | boolean | undefined;
    /** cwd used to find `.pi/post-compact.json`. */
    cwd?: string;
    /** Env to read `META_LLM_PROVIDER` / `META_LLM_MODEL` from. Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
}
/**
 * Resolve the meta-LLM id, in precedence order: explicit flag →
 * `META_LLM_PROVIDER`/`META_LLM_MODEL` env pair → post-compact.json →
 * `DEFAULT_META_LLM`.
 *
 * Hosts that spawn the agent from a container pass the model through env;
 * interactive pi passes it as a flag. Both need the same fallback chain, so it
 * lives here rather than being duplicated per host.
 */
export declare function resolveMetaLlm(opts?: ResolveMetaLlmOptions): string;
export interface ModelRegistryLike {
    getApiKeyAndHeaders(model: unknown): Promise<{
        ok: boolean;
        apiKey?: string;
        headers?: unknown;
    }>;
}
/**
 * Summarize `text` via the configured meta-LLM, focused on `opts.reason`.
 * Returns `undefined` on any failure or empty summary — never throws
 * ("never break the agent"), matching the original inline tool_result hook
 * behavior this was extracted from.
 */
export declare function compactToolResult(text: string, opts: CompactToolResultOptions, metaLlm: string, modelRegistry: ModelRegistryLike): Promise<{
    text: string;
    usage?: CompactUsage;
} | undefined>;
export type CompactSkipReason = "exact" | "below-threshold" | "unavailable" | "no-shrink" | "empty-or-error";
export interface CompactOrKeepResult {
    /** The compacted text, or the original when compaction was skipped or failed. */
    text: string;
    /** True only when `text` differs from the input. */
    changed: boolean;
    /** Meta-LLM tokens spent. The caller must account for these — see note below. */
    usage?: CompactUsage;
    /** Set when the original text was kept, explaining why. */
    skipped?: CompactSkipReason;
}
export interface CompactOrKeepDeps {
    metaLlm: string;
    modelRegistry: ModelRegistryLike | undefined;
    /** Floor below which text is returned unchanged. Defaults to `DEFAULT_MIN_CHARS`. */
    minChars?: number;
    /** Optional trace sink; receives one line per decision. */
    log?: (message: string) => void;
}
/**
 * Gate + compact + guard, in one call: the full "should this be summarized, and
 * is the summary actually an improvement" policy.
 *
 * Never throws and never loses data — every failure path returns the original
 * text with a `skipped` reason. A summary that is not shorter than the input is
 * discarded (`no-shrink`), which happens routinely on already-terse output such
 * as a short `ls` listing.
 *
 * `usage` is returned rather than reported because the pi SDK exposes no way for
 * an extension to add supplementary tokens to session accounting — hosts that
 * can account for it (e.g. one intercepting provider HTTP itself) should.
 */
export declare function compactOrKeep(text: string, opts: CompactToolResultOptions, deps: CompactOrKeepDeps): Promise<CompactOrKeepResult>;
