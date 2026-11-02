/**
 * The provider contract — every interface a boundary provider must satisfy.
 *
 * WHY its own module: the providers outlive the expansion decision layer. The decision module is
 * due for deletion, and a provider that imported its shapes from there would stop compiling the
 * day it goes. This module is the one definition site for the enclosing-span answer, the decline,
 * the window, and the line range, so it survives that removal unchanged.
 *
 * A provider answers "what encloses this window" and nothing else. It does not render chrome, and
 * it does not know what the answer is used for.
 */
import type { SpanKind } from "./span-kind.js";

/** Where a boundary came from. `lsp` is optional enrichment; it never widens on its own. */
export type SpanSource = "ast" | "md" | "text" | "lsp";

/** A structural block the provider answered, in 1-indexed inclusive line terms. */
interface EnclosingSpan {
  start: number;
  end: number;
  kind: SpanKind;
  name: string;
  source: SpanSource;
}

/** An admitted offset window, in the reader's 1-indexed terms. */
export interface OffsetWindow {
  offset: number;
  limit: number;
}

/** An admitted anchor window. `read` resolves it through admission before widening. */
interface AnchorWindow {
  around_anchor: string;
  radius: number;
}

/** The window shape the seam accepts; `read` delegates anchor resolution to admission. */
export type SpanWindow = OffsetWindow | AnchorWindow;

/**
 * The boundary provider seam. A provider may answer synchronously now and asynchronously once a
 * grammar has to be fetched, so the read path always awaits it. `around_anchor` windows reach the
 * provider already resolved to an offset window by `read` admission; the union documents the shape
 * both sides share.
 */
export interface SpanProvider {
  enclosingSpan(file: string, window: SpanWindow): SpanAnswer | Promise<SpanAnswer>;
  /** Set once an AST attempt found the optional wasm runtime unavailable. */
  readonly runtimeAbsent?: boolean;
  /** Start grammar fetches off the read path; session_start calls this without awaiting. */
  prefetch?: (cwd?: string) => void | Promise<void>;
}

/** One 1-indexed inclusive line range. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export const REFUSAL_REASONS = [
  "above_trigger",
  "past_eof",
  "not_text",
  "toggle_off",
  "no_provider",
  "boundary_crossing",
  "grammar_unavailable",
  "cold_grammar",
  "runtime_absent",
  "provider_declined",
  "provider_error",
  "invalid_answer",
  "not_superset",
  "over_cap",
] as const;

/** Why an expansion attempt did not widen. */
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** A typed provider refusal: the cause is carried, not inferred from a bare null. */
export interface SpanDecline {
  readonly refusal: RefusalReason;
  /** Grammar language, when the refusal is about one. */
  readonly language?: string;
  /** The full block size for an over-cap refusal. */
  readonly blockSize?: number;
}

/** Every answer a provider may give the seam. */
export type SpanAnswer = EnclosingSpan | SpanDecline | null;
