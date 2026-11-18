// The editor capabilities the MCP tools need, as the harness sees them. Kept free of contract and
// vscode imports: the extension's real implementation is adapted to this shape by a thin mapping layer.

export interface TextSnapshot {
  /** Current text, dirty editor buffer first, else disk. */
  text: string;
  /** sha256 hex of `text` (utf-8). */
  sha256: string;
}

export interface ApplyTextRequest {
  /** Workspace-relative POSIX path (already validated). */
  path: string;
  /** sha256 the file must still have; null means the file must not exist yet. */
  expectedSha256: string | null;
  newText: string;
}

export type ApplyTextResult =
  | { ok: true; preSha256: string | null; postSha256: string }
  | { ok: false; code: 'STALE_BASE' | 'OUTSIDE_WORKSPACE' | 'WRITE_FAILED'; message: string };

export interface ListFilesOptions {
  /** Only paths starting with this workspace-relative prefix. */
  prefix?: string;
  limit?: number;
}

export interface EditorPort {
  /** null when the file does not exist. */
  readText(path: string): Promise<TextSnapshot | null>;
  /** Workspace-relative POSIX paths of text-searchable files, ignoring .git, node_modules and .gitignore'd files. */
  listFiles(options?: ListFilesOptions): Promise<string[]>;
  /** Writes `newText` only if the file still has `expectedSha256`. Must be undoable on the editor side. */
  applyText(request: ApplyTextRequest): Promise<ApplyTextResult>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
