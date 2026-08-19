/** Directory name, relative to cwd, holding full text displaced by a collapse. */
export declare const DEFAULT_ARTIFACT_DIRNAME = ".tool_artifacts";
/**
 * On-disk escape hatch for collapsed content.
 *
 * Collapse trades fidelity for tokens, so the original has to remain reachable
 * or the run can strand itself: the model summarizes a file, then needs an exact
 * line from it two turns later. Writing the original to disk first means the
 * stub can name a path the model reads back with its ordinary read/bash tools —
 * no extra tool surface required.
 */
export interface ArtifactStore {
    /** Absolute path an artifact id maps to, whether or not it exists yet. */
    pathFor(id: string): string;
    /** Persist `text`. Returns the path, or `undefined` when the write failed. */
    write(id: string, text: string): string | undefined;
    /** Read an artifact back, or `undefined` when missing/unreadable. */
    read(id: string): string | undefined;
}
/** Strip anything that could escape the artifact directory or confuse a shell. */
export declare function sanitizeArtifactId(id: string): string;
export declare function createArtifactStore(dir: string, onError?: (message: string) => void): ArtifactStore;
/**
 * Render the replacement text for collapsed content.
 *
 * The path is included verbatim so recovery needs no special tool — but only
 * when the artifact was actually written, since naming a file that does not
 * exist would send the model chasing it.
 */
export declare function collapseStub(summary: string, artifactPath?: string): string;
