import type { LineEnding, LineEndingCounts } from "../edit-diff.js";

export interface NormText {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
  hadUtf8DecodeErrors: boolean;
  /**
   * Terminator counts over the RAW bytes (BOM stripped), so an `AUTO` EOL decision takes the
   * dominant kind from the decode that produced `normalized` instead of re-decoding the file.
   */
  endingCounts: LineEndingCounts;
}

export interface NormFile extends NormText {
  fileHashes: string[];
}
