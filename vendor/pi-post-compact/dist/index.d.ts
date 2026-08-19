import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
interface PostCompactConfig {
    meta_llm?: string;
}
export declare function loadConfig(cwd: string): PostCompactConfig;
export declare function parseMetaLlm(metaLlm: string): {
    provider: string;
    model: string;
} | undefined;
interface ModelRegistryLike {
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
export declare function compactToolResult(text: string, opts: {
    exact: boolean;
    reason: string;
}, metaLlm: string, modelRegistry: ModelRegistryLike): Promise<{
    text: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
} | undefined>;
export default function postCompactExtension(pi: ExtensionAPI): void;
export {};
