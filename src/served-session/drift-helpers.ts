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
  // WHY: ADR-0023 position-fallback — no served anchor survived to pin a current coordinate,
  // WHY: so the position degrades to line-number arithmetic (`servedIndex + delta`). The
  // WHY: tiers above are themselves anchor-spelling heuristics ("nearest surviving hash in
  // WHY: served order") — judgment aids for the drift notice's window, not identity claims;
  // WHY: the episode key derived from the result (`driftEpisodeKey`) inherits this floor.
  return servedIndex + delta;
}
