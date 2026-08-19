import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Directory name, relative to cwd, holding full text displaced by a collapse. */
export const DEFAULT_ARTIFACT_DIRNAME = ".tool_artifacts";
/** Strip anything that could escape the artifact directory or confuse a shell. */
export function sanitizeArtifactId(id) {
    return String(id).replace(/[^A-Za-z0-9_-]/g, "_");
}
export function createArtifactStore(dir, onError) {
    const report = onError ?? (() => { });
    const pathFor = (id) => join(dir, `${sanitizeArtifactId(id)}.txt`);
    return {
        pathFor,
        write(id, text) {
            const path = pathFor(id);
            try {
                mkdirSync(dir, { recursive: true });
                writeFileSync(path, text);
                return path;
            }
            catch (err) {
                report(`artifact write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
                return undefined;
            }
        },
        read(id) {
            try {
                return readFileSync(pathFor(id), "utf-8");
            }
            catch {
                return undefined;
            }
        },
    };
}
/**
 * Render the replacement text for collapsed content.
 *
 * The path is included verbatim so recovery needs no special tool — but only
 * when the artifact was actually written, since naming a file that does not
 * exist would send the model chasing it.
 */
export function collapseStub(summary, artifactPath) {
    return artifactPath
        ? `[collapsed: ${summary} — full text: ${artifactPath}]`
        : `[collapsed: ${summary}]`;
}
