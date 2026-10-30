# SVG Banner Design System & Architectural Reference

This document records the visual design system, mathematical proportions, and candidate evolutions for [`assets/banner.svg`](banner.svg).

---

## 1. Active Banner Architecture (960×360)

The active banner follows the **Golden Ratio ($\phi \approx 1.618$)** and UpSlide UI/UX design practices to minimize cognitive load while highlighting the fundamental architectural North Star of `pi-better-edit`.

```text
+-----------------------------------------------------------------------------------------------+
|  LEFT ZONE: 38.2% Golden Section           |  RIGHT ZONE: 61.8% Golden Section                |
|  [Attention Radar & Radiant π Vault]       |  [(FILE, CONTENT)-ADDRESSED LINE-IDENTITY MVCC]  |
|                                            |  pi-better-edit  [Free your model's Attention]   |
|         (szJx)                             |                                                  |
|           |                                |  +--------------------------------------------+  |
|   (c3dX)-[ π ]-(kQmx)                      |  | "Context space is scarce; host compute free"|  |
|           |                                |  +--------------------------------------------+  |
|         (a1bX)                             |                                                  |
|                                            |  [ 4-Char Base62 ] [ Context Model ] [ 0T Rebase]|
|                                            |  ( 14.7M anchors ) ( -58% tokens   ) ( LIS shift)|
+-----------------------------------------------------------------------------------------------+
|  BOTTOM STRIP:  ● MVCC SQLite WAL             |             ● Multi-Session Leases            |
+-----------------------------------------------------------------------------------------------+
```

### Proportional Geometry
- **Canvas Aspect Ratio**: $960 \times 360$ ($2.67 : 1$), providing airy vertical breathing room.
- **Horizontal Golden Section ($\phi = 1.618$)**:
  - **Left Section (38.2%)**: $340\text{px}$ dedicated to the attention scope and radiant $\pi$ vault.
  - **Right Section (61.8%)**: $554\text{px}$ housing brand identity, North Star axiom, and 3-pillar cards.
  - $\frac{554}{340} \approx 1.62 \approx \phi$.
- **Concentric Radar Radii**: Golden scaling $r = 50 \to 72 \to 92$.
- **3-Pillar Cards**: $174 \times 74\text{px}$ each, with titles and subtitles centered horizontally and vertically.
- **Dual Telemetry Strip**: Symmetrically balanced at $888 \times 38\text{px}$ with a central divider at $x = 444$.

---

## 2. Core Visual Elements

1. **Radiant π Neon Vault**:
   - Two-layer rendering: deep Gaussian neon aura (`#pi-glow`, stdDev 8 & 3) behind a razor-sharp foreground vector glyph in radiant gradient (`#2DD4BF` $\to$ `#38BDF8` $\to$ `#818CF8`).
2. **Glowing North Star Axiom**:
   - Ambient neon halo (`#north-star-glow`) surrounding the quote box, preceded by a luminous 4-point sparkle beacon ($\varstar$).
3. **Hero Lockup with Attention Pill Badge**:
   - `Free your model's Attention` is placed immediately to the right of `pi-better-edit`, uniting brand identity with the core mission.
4. **100% Vector Geometry (Infinite High-DPI Sharpness)**:
   - All browser-blurring rasterization filters removed from card containers. Typography remains 100% vector-sharp on Retina, 4K, and 8K screens.

---

## 3. Exploratory Candidates Archive

The initial candidate designs are preserved in [`assets/candidates/`](candidates/):

- [`candidates/banner-option-1-token-economy.svg`](candidates/banner-option-1-token-economy.svg): *Token Economy & Context Horizon* — Focuses on the North Star axiom, attention budget radar, and live $O(R)$ token-reduction demonstration.
- [`candidates/banner-option-2-anchor-matrix.svg`](candidates/banner-option-2-anchor-matrix.svg): *4-Char Anchor Matrix* — Cybernetic hexagon vault with perimeter anchor pins (`szJx`, `kQmx`, `a1bX`, `c3dX`) and immutable lineage traces.
- [`candidates/banner-option-3-blueprint-engine.svg`](candidates/banner-option-3-blueprint-engine.svg): *Architecture Blueprint* — Engineering schematic illustrating the two-chamber divide: *Scarce Context Budget* vs. *Free Host Compute Engine*.
- [`candidates/banner-option-4-terminal-flow.svg`](candidates/banner-option-4-terminal-flow.svg): *Next-Gen Terminal Flow* — Modern macOS developer IDE/terminal showing interactive `pi` tool execution with glowing anchor gutters and token accounting.
