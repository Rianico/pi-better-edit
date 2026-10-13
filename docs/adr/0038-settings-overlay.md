# ADR-0038 — Interactive settings overlay for the slash command surface

Date: 2026-10-13

## Status

accepted — implements the headed form of `/pi-better-edit settings` (and bare
`/pi-better-edit`) beside the existing per-setting pickers.

## Context

The `lens` and `bash-view` routes each answer one setting through a picker or a
status print. Reviewing every setting takes one invocation per setting with no
shared view of the write scope, so a single overlay carries the rows operators
review together: the target scope switch, the lens bridge, bash view
interception and the store janitor sweep.

## Decision

- Bare `/pi-better-edit` and `/pi-better-edit settings` open the overlay where a
  UI exists and print the unchanged combined status text where none does.
- The overlay is a `Container` holding a title `Text` and a `SettingsList`; the
  theme is a local function returning the `SettingsListTheme` interface, and
  borders are omitted — pi-tui 0.85.1 ships no border helper, box characters or
  theme factory, so hand-rolled box art would be invented surface.
- Every diagnostic line derives from the existing resolvers, readers and env
  consts; the module keeps no I/O of its own, so the overlay cannot drift from
  the status text it mirrors.
- The Target Scope row cycles `project`/`global` and persists nothing; later
  saves use it, and every row refreshes through `updateValue` plus in-place
  description mutation plus `invalidate`, which the list's by-reference item
  array turns into a refresh rather than a rebuild.
- Setting rows save through their matching saver with `(value, scope, cwd)`.

## Consequences

- Headed hosts gain one review point for all four rows; headless output keeps
  the shape the other routes taught the reader.
- Removing the overlay is one module plus its routing branch; the resolvers,
  savers and status text stand alone.
