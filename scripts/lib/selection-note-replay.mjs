/**
 * Selection-range note replay — the measurement half of the note's acceptance gate.
 *
 * WHY this parses pi session JSONL directly: the transcripts already record every tool call and
 * result the model saw, so the replay needs no new log format and no runtime dependency. One pass
 * pairs assistant `toolCall` entries with their `toolResult`, then measures two external facts:
 * how often a served read carried a selection-range note (and from which provider source), and how
 * often a served read is followed by another read of the same file.
 *
 * WHY the note is read back out of the served header instead of re-running the seam: the gate must
 * measure what the model actually saw, not a second implementation of the decision that could
 * drift from it. A transcript recorded without the note therefore exposes no treatment, and this
 * module reports that absence rather than inventing one.
 *
 * WHY the re-read share is unchanged from the retired widening gate: it is the external fact the
 * gate exists to move, it is blind to what the read contained, and keeping it is what makes a
 * before/after pair comparable. What changed is the question: the note claims not a fall, but a
 * measurable movement, and the report states when a movement is inside noise instead of gating on
 * an arbitrary target.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";

const REPLAY_SCHEMA_VERSION = 2;
export const DEFAULT_LIMIT_SESSIONS = 400;
const RE_READ_WINDOW = 3;

/**
 * Two-proportion test at 95%: a movement smaller than 1.96 standard errors of the difference is a
 * movement the corpus cannot distinguish from run-to-run churn, so the report names it noise.
 */
const NOISE_Z = 1.96;

/** Extensions the gate understands. An unknown extension is reported as `unknown`, never gated. */
const LANGUAGE_BY_EXTENSION = new Map([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".txt", "text"],
  [".json", "json"],
  [".jsonl", "json"],
  [".ndjson", "json"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".sh", "shell"],
  [".bash", "shell"],
  [".zsh", "shell"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".rb", "ruby"],
  [".php", "php"],
  [".c", "c"],
  [".h", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".cs", "csharp"],
  [".swift", "swift"],
  [".lua", "lua"],
  [".sql", "sql"],
  [".html", "html"],
  [".htm", "html"],
  [".css", "css"],
  [".scss", "css"],
]);

/** The sources a clause can name, in report order; the rendered note carries no source field. */
const NOTE_SOURCES = ["ast", "md", "text"];

/** The report lists a bounded sample of correctness failures; the count above it is the authority. */
const MAX_REPORTED_VIOLATIONS = 20;

/** An unreadable or absent corpus: a structural error, never a measurement. */
class CorpusError extends Error {}

/** The clause the note seam closes a header with: `; in <label>, lines <start>-<end>`. */
const NOTE_CLAUSE = /; in (.*), lines (\d+)-(\d+)$/;
/** A page header's body: a served range, or a whole-file count. */
const PAGE_WINDOW = / \((?:verbatim, )?(?:lines (\d+)-(\d+) of (\d+) total|(\d+) lines total)/;
/** A multi-window section header names its own range. */
const SECTION_WINDOW = /^\[Lines (\d+)-(\d+) of (\d+) total/;

/** The default corpus: pi's session directory under the agent root. */
export function sessionsRoot(env = process.env, home = homedir()) {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  return join(agentDir, "sessions");
}

function languageForPath(filePath) {
  return LANGUAGE_BY_EXTENSION.get(extname(filePath).toLowerCase()) ?? "unknown";
}

function canonicalPath(cwd, filePath) {
  if (typeof filePath !== "string" || filePath === "") return undefined;
  const base = typeof cwd === "string" && cwd !== "" ? resolve(cwd) : process.cwd();
  return normalize(isAbsolute(filePath) ? filePath : resolve(base, filePath));
}

function walkJsonl(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(path, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

/** Newest session files first; the limit keeps a replay bounded to the measured sample. */
function listSessionFiles(root, limit = DEFAULT_LIMIT_SESSIONS) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new CorpusError("limit must be a positive integer");
  const files = walkJsonl(root).map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }));
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return files.slice(0, limit).map((file) => file.path);
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part !== null && typeof part === "object" && part.type === "text")
    .map((part) => part.text)
    .filter((text) => typeof text === "string")
    .join("\n");
}

/**
 * Parse one session file into ordered tool-call events. Events are indexed in file order; a result
 * attaches to its call by `toolCallId`. Malformed lines are counted, never fatal.
 */
function parseSessionTranscript(text, filePath) {
  const events = [];
  const byCallId = new Map();
  const session = { id: filePath, cwd: undefined };
  let parseErrors = 0;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }
    if (record === null || typeof record !== "object") continue;
    if (record.type === "session") {
      if (typeof record.id === "string") session.id = record.id;
      if (typeof record.cwd === "string") session.cwd = record.cwd;
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message;
    if (message === null || typeof message !== "object") continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part === null || typeof part !== "object" || part.type !== "toolCall") continue;
        const event = {
          index: events.length,
          id: typeof part.id === "string" ? part.id : `call-${events.length}`,
          name: typeof part.name === "string" ? part.name : "unknown",
          args: part.arguments !== null && typeof part.arguments === "object" ? part.arguments : {},
          result: undefined,
        };
        events.push(event);
        byCallId.set(event.id, event);
      }
      continue;
    }
    if (message.role === "toolResult") {
      const callId = message.toolCallId;
      if (typeof callId !== "string") continue;
      const event = byCallId.get(callId);
      if (event === undefined) continue;
      event.result = {
        isError: message.isError === true,
        text: textOfContent(message.content),
      };
    }
  }
  return { session, events, parseErrors };
}

function readTarget(session, args) {
  const direct =
    typeof args.file === "string"
      ? args.file
      : typeof args.path === "string"
        ? args.path
        : Array.isArray(args.files) && typeof args.files[0]?.file === "string"
          ? args.files[0].file
          : undefined;
  const file = canonicalPath(session.cwd, direct);
  if (file === undefined) return undefined;
  return { file, mode: args.mode === "verbatim" ? "verbatim" : "served" };
}

function isSuccessful(event) {
  return event.result !== undefined && event.result.isError === false;
}

/**
 * A range a header names, or `undefined` when the line carries no complete range. A whole-file
 * body is normalised to the range it covers, so the correctness rule has one comparison to make.
 */
function rangeOf(line) {
  const section = SECTION_WINDOW.exec(line);
  if (section !== null) {
    return admitRange(Number(section[1]), Number(section[2]), Number(section[3]));
  }
  const page = PAGE_WINDOW.exec(line);
  if (page === null) return undefined;
  if (page[1] !== undefined) {
    return admitRange(Number(page[1]), Number(page[2]), Number(page[3]));
  }
  const totalLines = Number(page[4]);
  return admitRange(1, totalLines, totalLines);
}

function admitRange(start, end, totalLines) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(totalLines)) {
    return undefined;
  }
  if (start < 1 || totalLines < 1 || end < start) return undefined;
  return { start, end, totalLines };
}

/**
 * The clause a served header carries, or `undefined` when it carries none.
 *
 * The clause closes the header, so the trailing punctuation belongs to the bracket grammar rather
 * than to the span name: one closing bracket is stripped before the label is read, and the label
 * match is greedy so a name containing a comma still parses.
 */
function clauseOf(line) {
  const body = line.endsWith(")]") ? line.slice(0, -2) : line.slice(0, -1);
  const match = NOTE_CLAUSE.exec(body);
  if (match === null) return undefined;
  const label = match[1];
  return {
    label,
    start: Number(match[2]),
    end: Number(match[3]),
    source: sourceOfLabel(label),
  };
}

/**
 * The provider source a label implies: the note prints a kind, not a source, and only the two prose
 * sources have a dedicated kind. Shell answers travel the AST provider, so they land in `ast`.
 */
function sourceOfLabel(label) {
  if (label === "paragraph") return "text";
  if (label.startsWith('section "')) return "md";
  return NOTE_SOURCES[0];
}

/**
 * Every note a served page carries, with the window its own header names. Only header lines are
 * scanned: a quoted clause inside an assistant message, and a note-shaped content row behind an
 * anchor, are both rejected by the leading and trailing bracket.
 */
function notesInPage(text) {
  const notes = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("[") || !line.endsWith("]")) continue;
    const window = rangeOf(line);
    if (window === undefined) continue;
    const note = clauseOf(line);
    if (note === undefined) continue;
    notes.push({ note, window: { start: window.start, end: window.end } });
  }
  return notes;
}

/** The correctness rule the note owes a reader: the named span covers the window and exceeds it. */
function isStrictlyLarger(note, window) {
  const covers = note.start <= window.start && note.end >= window.end;
  const exceeds = note.start < window.start || note.end > window.end;
  return covers && exceeds;
}

function emptyMetrics() {
  return { reads: 0, reReads: 0 };
}

function finishMetrics(metrics) {
  return {
    ...metrics,
    reReadShare: metrics.reads === 0 ? null : metrics.reReads / metrics.reads,
  };
}

function lane(byLanguage, language) {
  let metrics = byLanguage.get(language);
  if (metrics === undefined) {
    metrics = emptyMetrics();
    byLanguage.set(language, metrics);
  }
  return metrics;
}

function emptyNotes() {
  return {
    fires: 0,
    readsWithNote: 0,
    bySource: { ast: 0, md: 0, text: 0 },
    violations: [],
  };
}

/** One session's contribution: served reads, same-file re-read flags, and the notes they carried. */
function analyzeSession(session, sessionFile) {
  const byLanguage = new Map();
  const notes = emptyNotes();

  for (const [index, event] of session.events.entries()) {
    if (event.name !== "read" || !isSuccessful(event)) continue;
    const target = readTarget(session, event.args);
    if (target === undefined || target.mode !== "served") continue;

    const metrics = lane(byLanguage, languageForPath(target.file));
    metrics.reads++;

    const later = session.events.slice(index + 1, index + 1 + RE_READ_WINDOW);
    const repeated = later.some((candidate) => {
      if (candidate.name !== "read" || !isSuccessful(candidate)) return false;
      const next = readTarget(session, candidate.args);
      return next !== undefined && next.file === target.file;
    });
    if (repeated) metrics.reReads++;

    const found = notesInPage(event.result.text);
    if (found.length > 0) notes.readsWithNote++;
    for (const { note, window } of found) {
      notes.fires++;
      if (note.source in notes.bySource) notes.bySource[note.source]++;
      if (!isStrictlyLarger(note, window)) {
        notes.violations.push({ session: sessionFile, file: target.file, window, note });
      }
    }
  }

  return { byLanguage, notes };
}

function mergeLanguageMetrics(target, source) {
  for (const [language, metrics] of source) {
    const existing = lane(target, language);
    existing.reads += metrics.reads;
    existing.reReads += metrics.reReads;
  }
}

function mergeNotes(target, source) {
  target.fires += source.fires;
  target.readsWithNote += source.readsWithNote;
  for (const name of NOTE_SOURCES) {
    target.bySource[name] += source.bySource[name];
  }
  target.violations.push(...source.violations);
}

/** Fail loudly on an absent or session-less corpus: an empty sample is not a passing measurement. */
function assertCorpus(root, label) {
  let entry;
  try {
    entry = statSync(root);
  } catch {
    throw new CorpusError(`${label} corpus not found: ${root} (pass --${label} <dir>)`);
  }
  if (!entry.isDirectory()) throw new CorpusError(`${label} corpus is not a directory: ${root}`);
}

/** Aggregate one transcript corpus: re-read facts per language, plus the notes its headers carried. */
function computeCorpus(root, { limitSessions = DEFAULT_LIMIT_SESSIONS, label = "candidate" } = {}) {
  assertCorpus(root, label);
  const files = listSessionFiles(root, limitSessions);
  if (files.length === 0) {
    throw new CorpusError(`${label} corpus contains no .jsonl sessions: ${root}`);
  }

  const totals = emptyMetrics();
  const byLanguage = new Map();
  const notes = emptyNotes();
  let parseErrors = 0;

  for (const file of files) {
    const parsed = parseSessionTranscript(readFileSync(file, "utf-8"), file);
    parseErrors += parsed.parseErrors;
    const session = analyzeSession({ ...parsed.session, events: parsed.events }, file);
    mergeLanguageMetrics(byLanguage, session.byLanguage);
    mergeNotes(notes, session.notes);
  }

  for (const metrics of byLanguage.values()) {
    totals.reads += metrics.reads;
    totals.reReads += metrics.reReads;
  }

  const languages = {};
  for (const language of [...byLanguage.keys()].sort()) {
    languages[language] = finishMetrics(byLanguage.get(language));
  }

  return {
    source: root,
    sessions: files.length,
    parseErrors,
    totals: finishMetrics(totals),
    byLanguage: languages,
    notes: {
      fires: notes.fires,
      readsWithNote: notes.readsWithNote,
      fireShare: totals.reads === 0 ? null : notes.fires / totals.reads,
      bySource: notes.bySource,
      violationCount: notes.violations.length,
      violations: notes.violations.slice(0, MAX_REPORTED_VIOLATIONS),
    },
  };
}

/**
 * Whether the note can explain a movement: a corpus with no clause exposes no treatment, and a
 * pair where both corpora carry one cannot attribute the delta to the note alone.
 */
function attributionOf(baseline, candidate) {
  if (candidate.notes.fires === 0) return "none";
  if (baseline.notes.fires === 0) return "note";
  return "mixed";
}

const UNMEASURED = Object.freeze({
  delta: null,
  relativeChange: null,
  pooledShare: null,
  standardError: null,
  noiseBand: null,
  z: null,
  withinNoise: null,
  attribution: "unknown",
  verdict: "unmeasured",
});

function unmeasured(baseline, candidate, reason) {
  return {
    baselineReads: baseline?.totals.reads ?? 0,
    candidateReads: candidate.totals.reads,
    baselineShare: baseline?.totals.reReadShare ?? null,
    candidateShare: candidate.totals.reReadShare,
    ...UNMEASURED,
    reason,
  };
}

/**
 * The before/after comparison, with its own noise test. Every unmeasurable shape returns
 * `unmeasured` with a reason: a delta of zero from a corpus compared with itself would read as a
 * result, and that is exactly the vacuous pass this gate must never print.
 */
function computeMovement(baseline, candidate) {
  if (baseline === null) {
    return unmeasured(
      baseline,
      candidate,
      "no baseline corpus named; pass --baseline <dir> recorded before the note was installed",
    );
  }
  if (resolve(baseline.source) === resolve(candidate.source)) {
    return unmeasured(
      baseline,
      candidate,
      "baseline and candidate are the same corpus, so any delta is zero by construction",
    );
  }
  const baselineReads = baseline.totals.reads;
  const candidateReads = candidate.totals.reads;
  if (baselineReads === 0 || candidateReads === 0) {
    return unmeasured(
      baseline,
      candidate,
      `${baselineReads === 0 ? "baseline" : "candidate"} corpus has no served-mode reads`,
    );
  }

  const baselineShare = baseline.totals.reReadShare;
  const candidateShare = candidate.totals.reReadShare;
  const delta = candidateShare - baselineShare;
  const pooledShare =
    (baseline.totals.reReads + candidate.totals.reReads) / (baselineReads + candidateReads);
  const standardError = Math.sqrt(
    pooledShare * (1 - pooledShare) * (1 / baselineReads + 1 / candidateReads),
  );
  const noiseBand = NOISE_Z * standardError;
  const z = standardError === 0 ? null : delta / standardError;
  const withinNoise = standardError === 0 ? delta === 0 : Math.abs(delta) < noiseBand;
  const points = (value) => `${(value * 100).toFixed(1)} pp`;

  const reason = withinNoise
    ? `${points(delta)} over ${baselineReads} -> ${candidateReads} served reads is inside the 95% band of +-${points(noiseBand)}`
    : `${points(delta)} over ${baselineReads} -> ${candidateReads} served reads is outside the 95% band of +-${points(noiseBand)}`;

  return {
    baselineReads,
    candidateReads,
    baselineShare,
    candidateShare,
    delta,
    relativeChange: baselineShare === 0 ? null : delta / baselineShare,
    pooledShare,
    standardError,
    noiseBand,
    z,
    withinNoise,
    attribution: attributionOf(baseline, candidate),
    verdict: withinNoise ? "inside-noise" : delta < 0 ? "candidate-lower" : "candidate-higher",
    reason,
  };
}

/** Build the machine-readable report: both corpora, then the note evidence and the comparison. */
export function buildReplayReport({
  baselineRoot,
  candidateRoot,
  limitSessions = DEFAULT_LIMIT_SESSIONS,
}) {
  if (typeof candidateRoot !== "string" || candidateRoot === "") {
    throw new CorpusError("candidate corpus root is required");
  }
  const candidate = computeCorpus(candidateRoot, { limitSessions, label: "candidate" });
  const baseline =
    typeof baselineRoot === "string" && baselineRoot !== ""
      ? computeCorpus(baselineRoot, { limitSessions, label: "baseline" })
      : null;

  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    options: { baselineRoot: baselineRoot ?? null, candidateRoot, limitSessions, noiseZ: NOISE_Z },
    baseline,
    candidate,
    reRead: computeMovement(baseline, candidate),
  };
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function formatSummary(report) {
  const lines = [];
  const corpusLine = (label, corpus) =>
    `${label}: ${corpus.source} (${corpus.sessions} sessions, ${corpus.totals.reads} served reads)`;

  lines.push("Selection-range note replay");
  lines.push(corpusLine("candidate", report.candidate));
  lines.push(
    report.baseline === null ? "baseline:  none" : corpusLine("baseline ", report.baseline),
  );
  lines.push("");

  const notes = report.candidate.notes;
  lines.push(
    `notes: ${notes.fires} clause(s) on ${notes.readsWithNote} read(s) of ${report.candidate.totals.reads} served reads (${percent(notes.fireShare)})`,
  );
  lines.push(
    `  ast ${notes.bySource.ast}  md ${notes.bySource.md}  text ${notes.bySource.text}  violations ${notes.violationCount}`,
  );

  const reRead = report.reRead;
  lines.push(
    `re-read: ${percent(reRead.baselineShare)} (${reRead.baselineReads} reads) -> ${percent(reRead.candidateShare)} (${reRead.candidateReads} reads)`,
  );
  lines.push(`  ${reRead.verdict} (attribution: ${reRead.attribution}) — ${reRead.reason}`);

  return lines.join("\n");
}
