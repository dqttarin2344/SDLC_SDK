export interface CopyReport {
    written: string[];
    skipped: string[];
}
/** Copy a directory tree. Existing files are kept unless `force`. */
export declare function copyTree(src: string, dst: string, force?: boolean, report?: CopyReport, root?: string): CopyReport;
export declare function writeFile(path: string, content: string): void;
/** Append a marked section to a file once (idempotent). */
export declare function appendSection(path: string, marker: string, content: string): "appended" | "present" | "created";
/**
 * Drop a minimal starter sdlc.config.json into a repo if it has none.
 * It deliberately does NOT copy the defaults (models, stages): repo config overrides the defaults,
 * so copying them would freeze today's defaults (and any pinned model) into your repository.
 */
export declare function ensureRepoConfig(repoRoot: string): boolean;
