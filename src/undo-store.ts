/**
 * In-memory undo store for the last_replace_undo tool.
 *
 * Before each successful replace, the pre-edit file state (normalized content,
 * BOM, original line ending, and hashes) is saved keyed by absolute path.
 * The undo tool reads this entry, restores the file, and clears the entry.
 *
 * Only the most recent replace per file is tracked — calling undo twice
 * without an intervening replace will produce "no undo history".
 */

export interface UndoEntry {
  /** Normalized (LF) content before the edit */
  content: string;
  /** BOM prefix that was stripped from the original file */
  bom: string;
  /** Original line ending detected before the edit */
  originalEnding: "\r\n" | "\n";
  /** Hash array for the pre-edit content */
  hashes: string[];
}

const undoMap = new Map<string, UndoEntry>();

export function saveUndo(path: string, entry: UndoEntry): void {
  undoMap.set(path, entry);
}

export function getUndo(path: string): UndoEntry | undefined {
  return undoMap.get(path);
}

export function clearUndo(path: string): void {
  undoMap.delete(path);
}
