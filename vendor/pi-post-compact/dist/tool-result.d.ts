/**
 * The `tool_result` pipeline, applied to every text-only tool result:
 *
 *   (a) persist the raw text to `.tool_artifacts/<toolCallId>.txt`
 *   (b) head-truncate at the hard ceiling, naming the artifact path
 *   (c) resolve the directive: explicit `post_compact` → default table
 *   (d) exact → keep (and hand to the collapse engine); otherwise summarize
 *
 * Kept free of the extension API so it can be unit-tested with a fake
 * compactor; index.ts wires it to pi's hooks.
 */
import type { CompactOrKeepResult, CompactToolResultOptions, CompactUsage, PostCompactDirective } from "./compact.js";
import type { ArtifactStore } from "./artifacts.js";
import { type RuntimeConfig } from "./defaults.js";
export interface ToolResultContentPart {
    type: string;
    text?: string;
}
export interface ToolResultInput {
    toolCallId: string;
    toolName: string;
    input?: Record<string, unknown>;
    content: readonly ToolResultContentPart[];
}
export interface ProcessToolResultDeps {
    config: RuntimeConfig;
    artifacts?: ArtifactStore;
    /** Directive the model supplied via `post_compact`, if any. */
    explicitDirective?: PostCompactDirective;
    /** Summarizer — `compactOrKeep` bound to the meta-LLM in production. */
    compact: (text: string, opts: CompactToolResultOptions) => Promise<CompactOrKeepResult>;
    /** Called for results kept verbatim under an exact directive. */
    onExact?: (toolCallId: string, reason: string) => void;
    /** Called with meta-LLM usage spent on this result. */
    onUsage?: (usage: CompactUsage) => void;
    log?: (message: string) => void;
}
export interface ProcessToolResultOutcome {
    /** Replacement content, or `undefined` when the result should pass through unchanged. */
    content?: Array<{
        type: "text";
        text: string;
    }>;
    artifactPath?: string;
    truncated: boolean;
    directive?: PostCompactDirective;
    compacted: boolean;
}
/** Notice appended to a head-truncated result. Names the artifact so the model can `read` the rest. */
export declare function truncationNotice(shown: number, total: number, artifactPath?: string): string;
export declare function processToolResult(event: ToolResultInput, deps: ProcessToolResultDeps): Promise<ProcessToolResultOutcome>;
