/**
 * Default directive table and env-driven runtime configuration.
 *
 * The directive table is what makes `post_compact` optional: a tool call that
 * carries no directive still gets a sensible policy, chosen by tool name. File
 * tools are kept verbatim because their output is usually about to be edited
 * against (and the collapse engine replaces them with a one-line finding after
 * one use); everything else is summarized, since shell/search/MCP output is
 * where the bulk of wasted context comes from.
 */
import { type CompactStyle, type PostCompactDirective } from "./compact.js";
/** Tools whose output is kept verbatim (then collapsed after one use) by default. */
export declare const EXACT_BY_DEFAULT_TOOLS: ReadonlySet<string>;
/** Default hard ceiling on tool-result text that enters context. */
export declare const DEFAULT_TOOL_RESULT_MAX_CHARS = 20000;
/** Default floor for collapsing large assistant tool-call arguments (strict `>`). */
export declare const DEFAULT_ARG_COLLAPSE_MIN_CHARS = 800;
/** Default summary style for tool-result compaction. */
export declare const DEFAULT_COMPACT_STYLE: CompactStyle;
/**
 * The directive applied when the model supplied none.
 *
 * `reason` doubles as the summarizer's focus string, so it names the tool (and
 * the file, for file tools — the collapse engine later asks "what did reading
 * <path> show").
 */
export declare function defaultDirective(toolName: string, input?: Record<string, unknown>): PostCompactDirective;
export interface ResolveDirectiveOptions {
    /** Directive the model supplied via `post_compact`, if any. Always wins. */
    explicit?: PostCompactDirective;
    toolName: string;
    input?: Record<string, unknown>;
    /** `PI_REQUIRE_DIRECTIVE=1`: no explicit directive → no compaction at all. */
    requireDirective?: boolean;
}
/** Explicit directive → default table (unless directives are required) → none. */
export declare function resolveDirective(opts: ResolveDirectiveOptions): PostCompactDirective | undefined;
/**
 * Parse a raw `post_compact` value into a directive, or `undefined` when it is
 * malformed. Accepts the JSON-string form some models emit for nested objects.
 */
export declare function parseDirective(raw: unknown): PostCompactDirective | undefined;
/** All env-driven settings. Read on demand so a host can change env between runs. */
export interface RuntimeConfig {
    /** `PI_ARTIFACT_ALL_RESULTS` — write every text tool result to `.tool_artifacts/`. */
    artifactAllResults: boolean;
    /** `PI_TOOL_RESULT_MAX_CHARS` — hard head-truncation ceiling. 0 disables. */
    toolResultMaxChars: number;
    /** `PI_REQUIRE_DIRECTIVE` — only compact when the model supplied `post_compact`. */
    requireDirective: boolean;
    /** `PI_COMPACT_STYLE` — summary style for tool-result compaction. */
    compactStyle: CompactStyle;
    /** `PI_COMPACT_MIN_CHARS` — floor below which a result is not summarized. */
    compactMinChars: number;
    /** `PI_COLLAPSE_MIN_CHARS` — floor for collapsing verbatim results / assistant text. */
    collapseMinChars: number;
    /** `PI_ARG_COLLAPSE_MIN_CHARS` — floor (strict `>`) for collapsing tool-call arguments. */
    argCollapseMinChars: number;
    /** `PI_SCHEMA_DIRECTIVE` — add the optional `post_compact` property to outgoing tool schemas. */
    schemaDirective: boolean;
    /** `PI_POST_COMPACT_DEBUG` — emit debug lines (e.g. the cache frontier) to stderr. */
    debug: boolean;
}
type Env = Record<string, string | undefined>;
export declare function readRuntimeConfig(env?: Env): RuntimeConfig;
export {};
