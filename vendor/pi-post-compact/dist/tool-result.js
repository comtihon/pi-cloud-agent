import { truncateWithNotice } from "./collapse.js";
import { resolveDirective } from "./defaults.js";
/** Notice appended to a head-truncated result. Names the artifact so the model can `read` the rest. */
export function truncationNotice(shown, total, artifactPath) {
    return artifactPath
        ? `\n…[truncated: showing first ${shown} of ${total} chars — full output saved to ${artifactPath}; use the read tool on that path if you need the rest]`
        : `\n…[truncated: showing first ${shown} of ${total} chars]`;
}
export async function processToolResult(event, deps) {
    const unchanged = { truncated: false, compacted: false };
    const log = deps.log ?? (() => { });
    // Text-only results only: images and mixed content pass through untouched.
    if (event.content.length === 0)
        return unchanged;
    if (!event.content.every((part) => part.type === "text" && typeof part.text === "string"))
        return unchanged;
    const full = event.content.map((part) => part.text).join("\n");
    if (!full.trim())
        return unchanged;
    const { config } = deps;
    // (a) raw text to disk — the escape hatch for truncation and summarization.
    const artifactPath = config.artifactAllResults ? deps.artifacts?.write(event.toolCallId, full) : undefined;
    // (b) hard ceiling, head kept.
    const max = config.toolResultMaxChars;
    const truncated = max > 0 && full.length > max;
    let text = truncated ? truncateWithNotice(full, max, truncationNotice(max, full.length, artifactPath)) : full;
    if (truncated)
        log(`truncated ${event.toolName} result ${event.toolCallId}: ${full.length} -> ${max} chars`);
    // (c) directive.
    const directive = resolveDirective({
        explicit: deps.explicitDirective,
        toolName: event.toolName,
        input: event.input,
        requireDirective: config.requireDirective,
    });
    const outcome = (compacted) => ({
        content: text !== full ? [{ type: "text", text }] : undefined,
        artifactPath,
        truncated,
        directive,
        compacted,
    });
    if (!directive)
        return outcome(false);
    // (d) exact results are kept here and collapsed later, after one use.
    if (directive.exact) {
        deps.onExact?.(event.toolCallId, directive.reason);
        return outcome(false);
    }
    const result = await deps.compact(text, { ...directive, style: config.compactStyle });
    if (result.usage)
        deps.onUsage?.(result.usage);
    if (!result.changed)
        return outcome(false);
    text = artifactPath ? `${result.text}\n[full output: ${artifactPath}]` : result.text;
    return outcome(true);
}
