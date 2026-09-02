/**
 * SAFETY: HealingPolicy — deep module owning the healing strategy chain.
 *
 * Minimal deepening for speculative C6: one interface, one chain.
 * Existing healers (single-canon, boundary, orphan) remain as internal
 * adapters; the policy owns ordering and is the sole seam that
 * ServedVerification depends on. This gives locality for healing bugs
 * and a graded surface (one method) while keeping typed boundaries and
 * immutable state.
 */

import type { OrphanContext, HealResult } from "./types.js";
import { healOrphanedSpan } from "./orphan.js";

export interface HealingPolicy {
 tryHeal(ctx: OrphanContext): HealResult;
}

/**
 * SAFETY: Default chain: orphan (which internally chains single-canon → boundary).
 * Explicit ordering orphan → single-canon → boundary is preserved via
 * OrphanHeal delegation; keeping the chain here would duplicate logic, so
 * we delegate to the tested OrphanHeal composite. The policy is the seam;
 * healers stay internal.
 */
export const healingPolicy: HealingPolicy = {
 tryHeal(ctx: OrphanContext): HealResult {
  return healOrphanedSpan(ctx);
 },
};

export function healWithPolicy(
 ctx: OrphanContext,
 policy: HealingPolicy = healingPolicy,
): HealResult {
 return policy.tryHeal(ctx);
}
