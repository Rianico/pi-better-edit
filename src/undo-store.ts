
export interface UndoEntry {
  content: string;
  bom: string;
  originalEnding: "\r\n" | "\n";
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
