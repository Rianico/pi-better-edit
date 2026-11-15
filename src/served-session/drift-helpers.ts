function nearestSurvivingPosition(
  served: (string | null)[],
  surviving: Set<string>,
  from: number,
  direction: "below" | "above",
): number | undefined {
  if (direction === "below") {
    for (let q = from - 1; q >= 0; q--) {
      const hash = served[q];
      if (hash !== null && surviving.has(hash)) return q;
    }
    return undefined;
  }
  for (let q = from + 1; q < served.length; q++) {
    const hash = served[q];
    if (hash !== null && surviving.has(hash)) return q;
  }
  return undefined;
}

export function currentPositionOfDrifted(
  served: (string | null)[],
  currentPositions: Map<string, number>,
  surviving: Set<string>,
  servedIndex: number,
  delta: number,
): number {
  const below = nearestSurvivingPosition(served, surviving, servedIndex, "below");
  if (below !== undefined) return currentPositions.get(served[below]!)! + 1;
  const above = nearestSurvivingPosition(served, surviving, servedIndex, "above");
  if (above !== undefined) return currentPositions.get(served[above]!)! - 1;
  // WHY: position-fallback — no served anchor survived to pin a current coordinate, so the position
  // WHY: is line-number arithmetic. The tiers above are anchor spellings, not identities: judgment
  // WHY: aids for the drift window, whose episode key inherits this floor.
  // Ref: docs/.archive_adrs/0023-lease-lineage-is-the-span-verification-authority-served-canons-retire.md
  return servedIndex + delta;
}
