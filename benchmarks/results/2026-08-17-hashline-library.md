# Library battery results — 2026-08-17

Ran with `npm run eval:hashline` on macOS arm64. Target:
`@oh-my-pi/hashline@17.3.5` (latest at time of writing), executed with the
bun runtime installed into the scratch directory by
`benchmarks/hashline-compare.mjs`.

All 10 scenarios run the safety property that matters: a stale tag is either
recovered **with an explicit warning** or rejected — never silently applied.

## Correctness

| scenario | outcome | evidence |
| --- | :--: | --- |
| H1 valid PUT apply | success | `aaa\nBBB\nccc\n` |
| H2 stale tag + unchanged anchors recovery | success | drift preserved (`LINE4`), warning `Recovered from a stale file hash…` present |
| H3 stale tag + changed anchors mismatch | rejected | `MismatchError`, file untouched (`xxx\nyyy\nzzz\n`), anchored context in message |
| H4 head/tail insert with drift | success | `ZZZ` appended at tail, `HEADTAIL` drift warning present |
| H5 noop PUT | success | content unchanged (`aaa\nbbb\nccc\n`) |
| H6 empty-file insert | success | `PUT <1:` on an empty file yields `first` |
| H7 unseen-anchor blind edit reject + retry | success | first apply rejected with content reveal; straight retry with the same tag succeeds (`CCC` landed) |
| H8 multi-section all-or-nothing | rejected | `MismatchError` on the stale second section; first file untouched (`aaa\nbbb\n`) — preflight before any write |
| H9 cut/paste register round-trip | success | `CUT 2.=2` + `PUT >3:` yields `aaa\nccc\nbbb\n` |
| H10 missing snapshot tag rejected | rejected | `Missing hashline snapshot tag…`; file untouched |
| **correct** | **10/10** | |

## Aggregates

| version | scenarios | success | rejected | ops | chars |
|---|--:|--:|--:|--:|--:|
| @oh-my-pi/hashline@17.3.5 | 10 | 7 | 3 | 23 | 1,263 |

`ops` is the number of library calls the battery made per scenario (record,
apply, read); `chars` is the size of the scenario's captured output (applied
content or rejection message). These are transcript sizes, not a throughput
claim.

## What the scenarios assert

- **H2/H3 split the stale-tag policy**: when every anchored line still maps to
  unchanged live lines, hashline replays the edit onto the live content and
  surfaces a recovery banner (detected drift, explicit warning). When the
  anchors can no longer be proven, it fails closed with a `MismatchError`
  instead of guessing.
- **H4** covers the position-stable insert path: head/tail inserts apply with
  a warning even on a stale tag because their position cannot drift.
- **H7** is the blind-edit guard: an edit anchoring lines the snapshot never
  recorded as seen is rejected with the actual content revealed, and the
  reveal itself makes the retry pass — the same reject-and-serve loop this
  project's tools implement (`[E_UNSERVED_RANGE]` / `[E_UNSERVED_RANGE]`).
- **H8** gates batch atomicity: multi-section patches preflight every section
  before any write, so a stale section anywhere aborts the whole patch.
- **H10** gates the provenance requirement: every anchored section must carry
  a snapshot tag; a tag-less edit is rejected outright.

## Limitations

- Runs against `InMemoryFilesystem` (the disk-backed `NodeFilesystem` is
  Bun-only); the logic under test is the patcher, not the I/O adapter.
- `@latest` by default — the dated pin above is what the numbers were
  produced against; re-running unpinned may pick up a newer release.
- The battery only exercises the scenarios expressible in hashline's model;
  undo and tool-level served-state behaviors are not applicable to a library
  and are covered by the tool battery instead.
