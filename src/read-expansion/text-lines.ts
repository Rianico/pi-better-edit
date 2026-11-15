/** The read path's visible line space, shared by the text-shaped providers. */
export function splitVisibleLines(text: string): string[] {
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lf = normalized.replace(/\r\n?/g, "\n");
  if (lf === "") return [];
  const withoutSentinel = lf.endsWith("\n") ? lf.slice(0, -1) : lf;
  return withoutSentinel.split("\n");
}
