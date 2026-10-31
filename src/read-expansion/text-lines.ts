/** The read path's visible line space, shared by the text-shaped providers. */
export function splitVisibleLines(text: string): string[] {
  // WHY: the read path strips the BOM before line counting; providers must see the same line space.
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  // WHY: loader normalization turns CRLF and lone CR into LF, so line numbers stay identical.
  const lf = normalized.replace(/\r\n?/g, "\n");
  if (lf === "") return [];
  const withoutSentinel = lf.endsWith("\n") ? lf.slice(0, -1) : lf;
  return withoutSentinel.split("\n");
}
