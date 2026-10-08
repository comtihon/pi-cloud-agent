/**
 * Advertise the `post_compact` directive in every tool's JSON schema on the
 * outgoing provider payload (`before_provider_request`).
 *
 * The system prompt alone is a weak signal; a schema property is where models
 * actually look when filling tool arguments. The property is optional — the
 * default directive table covers calls that omit it — and is wire-only: pi's
 * own TypeBox tool definitions are never touched, and the argument is stripped
 * again at `message_end`, before pi validates the call (see index.ts).
 *
 * Provider payloads share the tool's `parameters` object by reference
 * (openai-completions / openai-responses pass `tool.parameters` straight
 * through), so every schema is cloned before it is changed — mutating it in
 * place would leak the property into pi's own validator.
 */
export declare const POST_COMPACT_PROPERTY = "post_compact";
/** JSON schema for the optional `post_compact` argument. */
export declare const POST_COMPACT_SCHEMA: {
    readonly type: "object";
    readonly description: string;
    readonly properties: {
        readonly exact: {
            readonly type: "boolean";
            readonly description: "true = keep output verbatim; false = summarize it";
        };
        readonly reason: {
            readonly type: "string";
            readonly description: "What you are looking for in this tool's output";
        };
    };
    readonly required: readonly ["exact", "reason"];
};
type JsonObject = Record<string, unknown>;
/**
 * Return `schema` with `post_compact` added to its properties, or `undefined`
 * when nothing should change (not an object schema, or the property exists).
 * Never adds to `required`; never mutates the input.
 */
export declare function withPostCompactProperty(schema: unknown): JsonObject | undefined;
/**
 * Add `post_compact` to every tool schema in a provider payload. Handles:
 *
 * - openai-completions: `tools[].function.parameters`
 * - openai-responses:   `tools[].parameters` (with `type: "function"`)
 * - anthropic:          `tools[].input_schema`
 *
 * Tools in strict mode are skipped (strict schemas must list every property in
 * `required`, so an optional one would be rejected). Idempotent. Returns the
 * number of schemas changed; the payload is updated in place (only fresh,
 * per-request tool wrapper objects are touched — schemas are replaced, not
 * mutated).
 */
export declare function injectPostCompactSchema(payload: unknown): number;
export {};
