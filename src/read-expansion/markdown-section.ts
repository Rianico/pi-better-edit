/**
 * Fence-aware ATX heading sections for Markdown reads.
 *
 * This is deliberately hand-written: a Markdown dependency would add a parser for one boundary
 * shape. The scan is conservative — an unclosed fence or any Setext heading refuses the whole file,
 * so the read stays exact instead of guessing a section boundary. Setext detection is intentionally
 * file-wide and may also refuse a list item or blockquote followed by `---`; that is safer than
 * guessing a paragraph boundary. A leading YAML `---` frontmatter block is skipped so its
 * closing delimiter is not mistaken for a Setext underline.
 */
interface MarkdownSection {
  /** 1-indexed heading line. */
  readonly start: number;
  /** 1-indexed last line before the next equal-or-higher heading, or EOF. */
  readonly end: number;
  /** Heading text, or `(untitled)` for an empty ATX heading. */
  readonly title: string;
}

interface Heading {
  readonly line: number;
  readonly level: number;
  readonly title: string;
}

interface Fence {
  readonly char: "`" | "~";
  readonly length: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Split into the reader's visible lines: a terminal newline is not an extra line. */
function splitMarkdownLines(text: string): string[] {
  // WHY: the read path strips the BOM before line counting; this scan must see the same line space.
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lf = normalized.replace(/\r\n?/g, "\n");
  if (lf === "") return [];
  const withoutSentinel = lf.endsWith("\n") ? lf.slice(0, -1) : lf;
  return withoutSentinel.split("\n");
}

function atxHeading(line: string): { level: number; title: string } | null {
  const match = ATX.exec(line);
  if (match === null) return null;
  const title = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: match[1]!.length, title: title === "" ? "(untitled)" : title };
}

function fenceOpen(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  if (match === null) return null;
  const marker = match[1]!;
  const char = marker[0] as "`" | "~";
  const info = match[2] ?? "";
  // WHY: a backtick info string cannot contain a backtick; such a line is not a fence.
  if (char === "`" && info.includes("`")) return null;
  return { char, length: marker.length };
}

function fenceCloses(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSE.exec(line);
  if (match === null) return false;
  const marker = match[1]!;
  return marker[0] === fence.char && marker.length >= fence.length;
}

function hasSetextHeading(lines: readonly string[], index: number): boolean {
  if (index === 0 || !SETEXT_UNDERLINE.test(lines[index]!)) return false;
  const previous = lines[index - 1]!;
  if (FENCE_OPEN.test(previous) || FENCE_CLOSE.test(previous)) return false;
  return (
    previous.trim() !== "" && atxHeading(previous) === null && !SETEXT_UNDERLINE.test(previous)
  );
}

/**
 * The deepest ATX section containing the requested 1-indexed window, or null when the file has no
 * usable section (no heading, Setext heading, unclosed fence, pre-heading probe, or a request that
 * spans sections).
 */
export function findMarkdownSection(
  text: string,
  requestedStart: number,
  requestedEnd: number,
): MarkdownSection | null {
  const lines = splitMarkdownLines(text);
  if (requestedStart < 1 || requestedEnd < requestedStart || requestedEnd > lines.length)
    return null;

  let scanStart = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close > 0) scanStart = close + 1;
  }

  const headings: Heading[] = [];
  let fence: Fence | null = null;
  for (let index = scanStart; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence !== null) {
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    const opening = fenceOpen(line);
    if (opening !== null) {
      fence = opening;
      continue;
    }
    if (hasSetextHeading(lines, index)) return null;
    const heading = atxHeading(line);
    if (heading !== null) headings.push({ line: index, ...heading });
  }
  // WHY: an unclosed fence makes every following boundary unknowable; fail closed for the file.
  if (fence !== null || headings.length === 0) return null;

  let best: MarkdownSection | null = null;
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    let end = lines.length;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next]!.level <= heading.level) {
        end = headings[next]!.line;
        break;
      }
    }
    const section = { start: heading.line + 1, end, title: heading.title };
    if (section.start > requestedStart || section.end < requestedEnd) continue;
    if (
      best === null ||
      section.end - section.start < best.end - best.start ||
      (section.end - section.start === best.end - best.start && section.start > best.start)
    ) {
      best = section;
    }
  }
  return best;
}
