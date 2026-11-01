/**
 * Read-expansion round-trip replay — the measurement half of the acceptance gate.
 *
 * WHY this parses pi session JSONL directly: the transcripts already record every tool call and
 * result the model saw, so the replay needs no new log format and no runtime dependency. One pass
 * pairs assistant `toolCall` entries with their `toolResult`, then measures two external facts per
 * language: how often a served read is followed by another read of the same file, and how many
 * served lines a later anchor or edit never touches.
 *
 * WHY the numbers are corpus-level and not replayed through the extension: this ticket prepares the
 * gate, not a parser. A real acceptance run compares two transcript corpora — one recorded before
 * the candidate build and one after — through the same pure functions below.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";

export const REPLAY_SCHEMA_VERSION = 1;
export const DEFAULT_LIMIT_SESSIONS = 400;
export const MIN_SAMPLE_SIZE = 200;
export const RELATIVE_FALL_THRESHOLD = 0.2;
export const RE_READ_WINDOW = 3;

/** Extensions the gate understands. An unknown extension stays in `unknown` but never gates. */
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

/** The default corpus: pi's session directory under the agent root. */
export function sessionsRoot(env = process.env, home = homedir()) {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  return join(agentDir, "sessions");
}

export function languageForPath(filePath) {
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
export function listSessionFiles(root, limit = DEFAULT_LIMIT_SESSIONS) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
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
export function parseSessionTranscript(text, filePath) {
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

function readView(session, event) {
  if (event.name !== "read") return undefined;
  const target = readTarget(session, event.args);
  if (target === undefined || !isSuccessful(event)) return undefined;
  return target;
}

/**
 * Parse the anchored rows of one read result into 1-indexed line positions. The page header names
 * the first section; a multi-window section header resets the position before its rows.
 */
export function parseServedRows(text) {
  const rows = [];
  let startLine;
  let offset = 0;
  for (const line of text.split("\n")) {
    const section = /^\[Lines (\d+)-\d+ of \d+ total/.exec(line);
    if (section !== null) {
      startLine = Number(section[1]);
      offset = 0;
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const header = /^\[.*? \((.*?)\)\]$/.exec(line);
      if (header !== null) {
        const ranged = /lines (\d+)-\d+ of \d+ total/.exec(header[1]);
        if (ranged !== null) {
          startLine = Number(ranged[1]);
          offset = 0;
          continue;
        }
        if (/\d+ lines total/.test(header[1])) {
          startLine = 1;
          offset = 0;
          continue;
        }
      }
      continue;
    }
    const row = /^([A-Za-z0-9]{4})│(.*)$/.exec(line);
    if (row === null) continue;
    if (startLine === undefined) {
      startLine = 1;
      offset = 0;
    }
    rows.push({ anchor: row[1], line: startLine + offset });
    offset++;
  }
  return rows;
}

function anchorKey(file, anchor) {
  return `${file}\u0000${anchor}`;
}

function editItems(args) {
  const target =
    typeof args.file === "string"
      ? args.file
      : typeof args.path === "string"
        ? args.path
        : undefined;
  if (Array.isArray(args.edits)) {
    return args.edits.map((item) => ({
      item,
      file: typeof item?.file === "string" ? item.file : target,
    }));
  }
  return [{ item: args, file: target }];
}

function markTouched(servedByFile, file, fromLine, toLine, beforeEventIndex) {
  const records = servedByFile.get(file);
  if (records === undefined) return;
  const low = Math.min(fromLine, toLine);
  const high = Math.max(fromLine, toLine);
  for (const record of records) {
    if (record.touched || record.eventIndex >= beforeEventIndex) continue;
    if (record.line >= low && record.line <= high) record.touched = true;
  }
}

function markAnchor(servedByFile, anchorIndex, file, anchor, beforeEventIndex) {
  if (typeof anchor !== "string") return;
  const line = anchorIndex.get(anchorKey(file, anchor));
  if (line !== undefined) markTouched(servedByFile, file, line, line, beforeEventIndex);
}

/** Mark served rows touched by later edit anchors or a later `around_anchor` probe. */
function applyTouches(session, servedRecords) {
  const servedByFile = new Map();
  const anchorIndex = new Map();
  for (const record of servedRecords) {
    const records = servedByFile.get(record.file) ?? [];
    records.push(record);
    servedByFile.set(record.file, records);
    if (!anchorIndex.has(anchorKey(record.file, record.anchor))) {
      anchorIndex.set(anchorKey(record.file, record.anchor), record.line);
    }
  }

  for (const event of session.events) {
    if (event.name === "edit") {
      for (const { item, file } of editItems(event.args)) {
        if (item === null || typeof item !== "object") continue;
        const target = canonicalPath(session.cwd, file);
        if (target === undefined) continue;
        const from = item.anchor_from;
        const to = item.anchor_to;
        const fromLine =
          typeof from === "string" ? anchorIndex.get(anchorKey(target, from)) : undefined;
        const toLine = typeof to === "string" ? anchorIndex.get(anchorKey(target, to)) : undefined;
        if (fromLine !== undefined && toLine !== undefined) {
          markTouched(servedByFile, target, fromLine, toLine, event.index);
        } else {
          markAnchor(servedByFile, anchorIndex, target, from, event.index);
          markAnchor(servedByFile, anchorIndex, target, to, event.index);
        }
        const ref = item.text_ref;
        if (ref !== null && typeof ref === "object") {
          const refFile = canonicalPath(
            session.cwd,
            typeof ref.file === "string" ? ref.file : file,
          );
          if (refFile === undefined) continue;
          const refFrom = ref.anchor_from;
          const refTo = ref.anchor_to;
          const refFromLine =
            typeof refFrom === "string" ? anchorIndex.get(anchorKey(refFile, refFrom)) : undefined;
          const refToLine =
            typeof refTo === "string" ? anchorIndex.get(anchorKey(refFile, refTo)) : undefined;
          if (refFromLine !== undefined && refToLine !== undefined) {
            markTouched(servedByFile, refFile, refFromLine, refToLine, event.index);
          } else {
            markAnchor(servedByFile, anchorIndex, refFile, refFrom, event.index);
            markAnchor(servedByFile, anchorIndex, refFile, refTo, event.index);
          }
        }
      }
      continue;
    }
    if (event.name === "read") {
      const target = readTarget(session, event.args);
      const anchor = event.args.around_anchor;
      if (target !== undefined && typeof anchor === "string") {
        markAnchor(servedByFile, anchorIndex, target.file, anchor, event.index);
      }
    }
  }
}

function emptyMetrics() {
  return {
    reads: 0,
    reReads: 0,
    servedLines: 0,
    touchedLines: 0,
  };
}

function finishMetrics(metrics) {
  return {
    ...metrics,
    reReadShare: metrics.reads === 0 ? null : metrics.reReads / metrics.reads,
    wasteLines: metrics.servedLines - metrics.touchedLines,
    wasteShare:
      metrics.servedLines === 0
        ? null
        : (metrics.servedLines - metrics.touchedLines) / metrics.servedLines,
  };
}

/** One session's contribution: read events, same-file re-read flags, and served-row waste. */
function analyzeSession(session) {
  const byLanguage = new Map();
  const lane = (language) => {
    let metrics = byLanguage.get(language);
    if (metrics === undefined) {
      metrics = emptyMetrics();
      byLanguage.set(language, metrics);
    }
    return metrics;
  };

  const readEvents = session.events
    .map((event, index) => {
      const target = readView(session, event);
      return target === undefined ? undefined : { index, event, ...target };
    })
    .filter((entry) => entry !== undefined);

  for (const read of readEvents) {
    if (read.mode !== "served") continue;
    const language = languageForPath(read.file);
    const metrics = lane(language);
    metrics.reads++;
    const later = session.events.slice(read.index + 1, read.index + 1 + RE_READ_WINDOW);
    if (
      later.some((event) => {
        if (event.name !== "read" || !isSuccessful(event)) return false;
        const target = readTarget(session, event.args);
        return target !== undefined && target.file === read.file;
      })
    ) {
      metrics.reReads++;
    }
  }

  const servedRecords = [];
  for (const read of readEvents) {
    if (read.mode !== "served") continue;
    const language = languageForPath(read.file);
    const rows = parseServedRows(read.event.result.text);
    const metrics = lane(language);
    metrics.servedLines += rows.length;
    for (const row of rows) {
      servedRecords.push({
        eventIndex: read.index,
        file: read.file,
        line: row.line,
        anchor: row.anchor,
        language,
        touched: false,
      });
    }
  }
  applyTouches(session, servedRecords);
  for (const record of servedRecords) {
    if (record.touched) lane(record.language).touchedLines++;
  }

  return byLanguage;
}

function mergeLanguageMetrics(target, source) {
  for (const [language, metrics] of source) {
    let existing = target.get(language);
    if (existing === undefined) {
      existing = emptyMetrics();
      target.set(language, existing);
    }
    existing.reads += metrics.reads;
    existing.reReads += metrics.reReads;
    existing.servedLines += metrics.servedLines;
    existing.touchedLines += metrics.touchedLines;
  }
}

/** Aggregate one transcript corpus into per-language external metrics. */
export function computeCorpus(root, { limitSessions = DEFAULT_LIMIT_SESSIONS } = {}) {
  const files = listSessionFiles(root, limitSessions);
  const totals = emptyMetrics();
  const byLanguage = new Map();
  let parseErrors = 0;

  for (const file of files) {
    const parsed = parseSessionTranscript(readFileSync(file, "utf-8"), file);
    parseErrors += parsed.parseErrors;
    const sessionMetrics = analyzeSession({ ...parsed.session, events: parsed.events });
    mergeLanguageMetrics(byLanguage, sessionMetrics);
  }
  for (const metrics of byLanguage.values()) {
    totals.reads += metrics.reads;
    totals.reReads += metrics.reReads;
    totals.servedLines += metrics.servedLines;
    totals.touchedLines += metrics.touchedLines;
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
  };
}

function gateLanguage(baseline, candidate) {
  const sampleSize = candidate?.reads ?? 0;
  const baselineShare = baseline?.reReadShare ?? null;
  const candidateShare = candidate?.reReadShare ?? null;
  const relativeFall =
    baselineShare === null || baselineShare === 0 || candidateShare === null
      ? null
      : (baselineShare - candidateShare) / baselineShare;
  const baselineWaste = baseline?.wasteShare ?? null;
  const candidateWaste = candidate?.wasteShare ?? null;
  const wasteDelta =
    baselineWaste === null || candidateWaste === null ? null : candidateWaste - baselineWaste;
  const wasteVerdict = wasteDelta === null ? "unknown" : wasteDelta <= 1e-12 ? "pass" : "fail";

  if (sampleSize < MIN_SAMPLE_SIZE) {
    const accepted = wasteVerdict === "pass";
    return {
      sampleSize,
      baselineReads: baseline?.reads ?? 0,
      candidateReads: sampleSize,
      baselineReReadShare: baselineShare,
      candidateReReadShare: candidateShare,
      relativeFall,
      baselineWasteShare: baselineWaste,
      candidateWasteShare: candidateWaste,
      wasteDelta,
      wasteVerdict,
      verdict: "insufficient-sample",
      status: "insufficient sample",
      decision: accepted ? "accept-on-waste" : "reject-on-waste",
      accepted,
      reason:
        wasteVerdict === "unknown"
          ? `${sampleSize} < ${MIN_SAMPLE_SIZE} served reads and waste is unknown`
          : `${sampleSize} < ${MIN_SAMPLE_SIZE} served reads; waste ${wasteVerdict}`,
    };
  }

  const fallPass = relativeFall !== null && relativeFall >= RELATIVE_FALL_THRESHOLD;
  const accepted = fallPass && wasteVerdict === "pass";
  const reasons = [];
  if (relativeFall === null) reasons.push("baseline re-read share is unavailable");
  else if (!fallPass) {
    reasons.push(
      `relative fall ${(relativeFall * 100).toFixed(1)}% < ${(RELATIVE_FALL_THRESHOLD * 100).toFixed(0)}%`,
    );
  }
  if (wasteVerdict === "fail") reasons.push("waste rose");
  if (wasteVerdict === "unknown") reasons.push("waste is unavailable");
  return {
    sampleSize,
    baselineReads: baseline?.reads ?? 0,
    candidateReads: sampleSize,
    baselineReReadShare: baselineShare,
    candidateReReadShare: candidateShare,
    relativeFall,
    baselineWasteShare: baselineWaste,
    candidateWasteShare: candidateWaste,
    wasteDelta,
    wasteVerdict,
    verdict: accepted ? "accept" : "reject",
    status: accepted ? "accepted" : "rejected",
    decision: accepted ? "accept" : "reject",
    accepted,
    reason: accepted ? "relative fall and waste gate passed" : reasons.join("; "),
  };
}

/** Build the machine-readable report: both corpora, then the per-language gate. */
export function buildReplayReport({
  baselineRoot,
  candidateRoot,
  limitSessions = DEFAULT_LIMIT_SESSIONS,
  languages,
}) {
  if (typeof baselineRoot !== "string" || baselineRoot === "") {
    throw new Error("baseline corpus root is required");
  }
  if (typeof candidateRoot !== "string" || candidateRoot === "") {
    throw new Error("candidate corpus root is required");
  }
  const baseline = computeCorpus(baselineRoot, { limitSessions });
  const candidate = computeCorpus(candidateRoot, { limitSessions });
  const selected =
    languages === undefined || languages.length === 0
      ? undefined
      : new Set(languages.map((language) => language.toLowerCase()));

  const isSelected = (language) => selected === undefined || selected.has(language);
  const gateLanguages = {};
  const accepted = [];
  const rejected = [];
  const insufficient = [];
  const allLanguages = new Set([
    ...Object.keys(baseline.byLanguage),
    ...Object.keys(candidate.byLanguage),
    // WHY: a requested language with zero reads still needs a visible, honest verdict.
    ...(selected ?? []),
  ]);
  for (const language of [...allLanguages].sort()) {
    if (language === "unknown" || !isSelected(language)) continue;
    const entry = gateLanguage(baseline.byLanguage[language], candidate.byLanguage[language]);
    gateLanguages[language] = entry;
    if (entry.verdict === "accept") accepted.push(language);
    else if (entry.verdict === "insufficient-sample") insufficient.push(language);
    else rejected.push(language);
  }

  const filterMetrics = (corpus) => ({
    ...corpus,
    byLanguage:
      selected === undefined
        ? corpus.byLanguage
        : Object.fromEntries(
            Object.entries(corpus.byLanguage).filter(([language]) => selected.has(language)),
          ),
  });

  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    options: {
      baselineRoot,
      candidateRoot,
      limitSessions,
      languages: languages ?? null,
      minSampleSize: MIN_SAMPLE_SIZE,
      relativeFallThreshold: RELATIVE_FALL_THRESHOLD,
      reReadWindow: RE_READ_WINDOW,
    },
    baseline: filterMetrics(baseline),
    candidate: filterMetrics(candidate),
    gate: {
      minSampleSize: MIN_SAMPLE_SIZE,
      relativeFallThreshold: RELATIVE_FALL_THRESHOLD,
      rule:
        "accept only when the same-file re-read share falls by at least 20% on at least 200 " +
        "served-mode reads and served-line waste does not rise; below 200 reads decide on waste only",
      languages: gateLanguages,
      accepted,
      rejected,
      insufficientSample: insufficient,
    },
  };
}

export function formatSummary(report) {
  const lines = [];
  lines.push("Read-expansion round-trip replay");
  lines.push(
    `baseline:  ${report.baseline.source} (${report.baseline.sessions} sessions, ${report.baseline.totals.reads} served reads)`,
  );
  lines.push(
    `candidate: ${report.candidate.source} (${report.candidate.sessions} sessions, ${report.candidate.totals.reads} served reads)`,
  );
  lines.push("");
  lines.push(
    "language      sample  baseline  candidate  rel-fall  waste-base  waste-cand  verdict",
  );
  for (const [language, gate] of Object.entries(report.gate.languages)) {
    const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
    lines.push(
      [
        language.padEnd(12),
        String(gate.sampleSize).padStart(6),
        pct(gate.baselineReReadShare).padStart(9),
        pct(gate.candidateReReadShare).padStart(10),
        pct(gate.relativeFall).padStart(8),
        pct(gate.baselineWasteShare).padStart(10),
        pct(gate.candidateWasteShare).padStart(10),
        gate.verdict,
      ].join("  "),
    );
  }
  lines.push("");
  lines.push(
    `gate: >= ${MIN_SAMPLE_SIZE} reads and >= ${RELATIVE_FALL_THRESHOLD * 100}% relative fall; waste must not rise`,
  );
  return lines.join("\n");
}
