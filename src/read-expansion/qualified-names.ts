/**
 * Optional qualified-name enrichment. This is the whole server seam: it consumes a resolver only
 * when one is injected; it never discovers, starts, installs or proposes a server.
 */
import type { SpanProvider } from "./provider-contract.js";

interface QualifiedNameRequest {
  readonly file: string;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** The already-attached surface a caller may inject; undefined is the normal no-server case. */
export type QualifiedNameResolver = (
  request: QualifiedNameRequest,
) => string | undefined | Promise<string | undefined>;

export const DEFAULT_QUALIFIED_NAME_TIMEOUT_MS = 50;

const TIMED_OUT = Symbol("timed-out");

function timeout<T>(task: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, timeoutMs));
  });
  return Promise.race([task, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Wrap a provider so an optional resolver may replace the parser name on every chain level.
 * Each level is copied unchanged; a missing, throwing, empty or slow answer keeps the parser name.
 */
export function withQualifiedNames(
  provider: SpanProvider,
  resolver: QualifiedNameResolver | undefined,
  timeoutMs: number = DEFAULT_QUALIFIED_NAME_TIMEOUT_MS,
): SpanProvider {
  if (resolver === undefined) return provider;
  let disabled = false;
  return {
    get runtimeAbsent() {
      return provider.runtimeAbsent === true;
    },
    prefetch(cwd?: string) {
      return provider.prefetch?.(cwd);
    },
    async enclosingChain(file, window) {
      const chain = await provider.enclosingChain(file, window);
      if (chain === null || "refusal" in chain) return chain;
      if (disabled || chain.spans.length === 0) return chain;
      const spans = [...chain.spans];
      for (let index = 0; index < spans.length; index++) {
        const span = spans[index]!;
        if (span.source !== "ast" || disabled) continue;
        try {
          const qualified = await timeout(
            Promise.resolve(
              resolver({ file, name: span.name, startLine: span.start, endLine: span.end }),
            ),
            timeoutMs,
          );
          if (qualified === TIMED_OUT) {
            // WHY: one hanging read must not spend the timeout again for every folded group.
            disabled = true;
            break;
          }
          if (typeof qualified === "string") {
            const name = qualified
              .replace(/\p{Cc}/gu, " ")
              .replace(/\s+/g, " ")
              .trim();
            if (name !== "" && !name.includes("[") && !name.includes("]")) {
              spans[index] = { ...span, name: name.slice(0, 120) };
            }
          }
        } catch {
          // SAFETY: enrichment is advisory; any resolver failure leaves the parser label intact.
        }
      }
      return { spans };
    },
  };
}
