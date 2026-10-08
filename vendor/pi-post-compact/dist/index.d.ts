import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CompactUsage } from "./compact.js";
import { type ContextCollapseStats } from "./context-collapse.js";
export { ASSISTANT_CONTENT_REASON, buildActionSummaryInstruction, compactOrKeep, compactToolResult, DEFAULT_META_LLM, DEFAULT_MIN_CHARS, loadConfig, parseMetaLlm, resolveMetaLlm, STYLE_GUIDES, } from "./compact.js";
export type { CompactOrKeepDeps, CompactOrKeepResult, CompactSkipReason, CompactStyle, CompactToolResultOptions, CompactUsage, ModelRegistryLike, PostCompactConfig, PostCompactDirective, } from "./compact.js";
export { cacheFrontierIndex, CollapseTracker, DEFAULT_COLLAPSE_DELAY, summarizeToolCallArgs, truncateWithNotice, } from "./collapse.js";
export type { CollapseEntry } from "./collapse.js";
export { collapseStub, createArtifactStore, DEFAULT_ARTIFACT_DIRNAME, sanitizeArtifactId, } from "./artifacts.js";
export type { ArtifactStore } from "./artifacts.js";
export { ContextCollapseEngine } from "./context-collapse.js";
export type { ContextCollapseOptions, ContextCollapseStats } from "./context-collapse.js";
export { DEFAULT_ARG_COLLAPSE_MIN_CHARS, DEFAULT_COMPACT_STYLE, DEFAULT_TOOL_RESULT_MAX_CHARS, defaultDirective, EXACT_BY_DEFAULT_TOOLS, parseDirective, readRuntimeConfig, resolveDirective, } from "./defaults.js";
export type { ResolveDirectiveOptions, RuntimeConfig } from "./defaults.js";
export { injectPostCompactSchema, POST_COMPACT_PROPERTY, POST_COMPACT_SCHEMA, withPostCompactProperty, } from "./schema-hint.js";
export { processToolResult, truncationNotice } from "./tool-result.js";
export type { ProcessToolResultDeps, ProcessToolResultOutcome, ToolResultInput, } from "./tool-result.js";
/** Event-bus channel carrying per-run stats, emitted at `agent_end`. */
export declare const STATS_EVENT = "post-compact:stats";
export interface PostCompactStatsEvent {
    /** Collapse-engine stats (session-cumulative counters), or undefined before session_start. */
    collapseStats: ContextCollapseStats | undefined;
    /**
     * Meta-LLM tokens spent during this agent run, on tool-result compaction and
     * context collapse combined. Not reflected in pi's session stats — no
     * extension API exists to add usage there.
     */
    metaUsage: CompactUsage;
}
export default function postCompactExtension(pi: ExtensionAPI): void;
