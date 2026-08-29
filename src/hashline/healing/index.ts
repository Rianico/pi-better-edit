export type { HealingContext, SingleCanonContext, BoundaryCanonContext, OrphanContext, HealResult, HealingStrategy } from "./types.js";
export { SingleCanonHeal, healSingleCanon } from "./single-canon.js";
export { BoundaryHeal, healBoundaryCanon } from "./boundary.js";
export { OrphanHeal, healOrphanedSpan } from "./orphan.js";
export { findCanonMatches, isUniqueSection, isLengthHealedViaCanon } from "./helpers.js";
