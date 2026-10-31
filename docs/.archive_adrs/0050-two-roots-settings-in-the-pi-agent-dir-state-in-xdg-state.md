# ADR-0050 — Two roots: settings in the pi agent dir, state in the XDG state dir

Date: 2026-10-28

## Status

accepted — the settled design for [#190](https://github.com/Rianico/pi-better-edit/issues/190),
implemented in the same tranche. It supersedes the store-directory paragraph of
[ADR-0037](0037-store-janitor-lifecycle-maintenance-model.md) and the
`~/.config/pi-better-edit/pi-better-edit.json` default named in its §8; that record is pointed at,
not rewritten. [ADR-0017](0017-lru-vacuum-supersedes-epoch-concurrency.md)'s vacuum,
[ADR-0038](0038-settings-overlay.md)'s overlay and every tool payload contract are untouched. It
ships as a **MINOR** release: no accepted payload, environment variable, error code or configuration
key changes — only where the files live, plus a one-time adoption of the old ones.

## Context

### One directory held configuration and data

Before this record, one directory held everything. It resolved as
`PI_BETTER_EDIT_CONFIG_DIR` (verbatim, empty counting as unset) over
`$XDG_CONFIG_HOME/pi-better-edit` (off Windows only) over `$HOME/.config/pi-better-edit`, and inside
it lived every artifact the extension persists:

- `pi-better-edit.json` — the settings file a user edits by hand;
- `hash-store.sqlite` and its `-wal`/`-shm` — the live store;
- `hash-store.json` — the pre-SQLite legacy store that `src/snapshot-store/migrate.ts` still reads;
- `diagnostics.log` and its `.1` rotation — the internal-failure log;
- `.corrupt-<ts>` dumps — forensic copies taken when a store failed its health check.

Three independent costs came out of that arrangement.

**The directory answered two different questions.** Configuration is portable, hand-edited and worth
backing up; state is machine-local, disposable and rebuilt from the files on disk. XDG separates them
for exactly that reason. Here they shared a directory, so mounting config read-only disabled the
store, and wiping the store sat one `rm` away from the settings.

**The directory was the extension's own invention.** pi already scopes extension data to its agent
dir (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). `~/.config/pi-better-edit` was a second
convention, and `~/.pi/agents/pi-better-edit.json` was a third: the project had already moved away
from it once (#164), leaving a retired source every read still had to consult.

**The same variable meant different things per platform.** `XDG_CONFIG_HOME` was honored off Windows
only, and the store directory doubled as the settings directory, so "where are my settings" and
"where is my data" could not be answered separately.

### The move cannot be silent

Existing users have hand-edited settings at up to three retired locations, a legacy `hash-store.json`
the migration path still reads, and diagnostics logs worth keeping. An un-restarted older version of
this extension may still own the old SQLite file, WAL and all. So nothing is copied out of a live
database, nothing is deleted that another process may own, and settings are carried across rather
than expected to be rewritten by hand.

## Decision

### D1. Two roots, one ladder, one module

`src/config-dir.ts` is the only module that names any of the new or retired paths;
`test/arch/config-ladder-single-owner.test.ts` keeps it that way, with the retired literals living
in that one seam module. Both roots resolve from one ladder:

- `home` = `$HOME` when non-empty, else `os.homedir()`.
- `agentHome` = the `~`-expanded `$PI_CODING_AGENT_DIR` **when that expansion is absolute**;
  otherwise `<home>/.pi/agent`.
- `override` = `$PI_BETTER_EDIT_CONFIG_DIR`, read verbatim, empty counting as unset (§D2).
- **settings root** = `override` when set, else `<agentHome>/extensions/pi-better-edit`;
  **settings file** = `<settings root>/settings.json`.
- `stateHome` = `$XDG_STATE_HOME` when set, non-empty **and absolute**, else `<home>/.local/state`.
- **state root** = `<override>/state` when the override is set, else `<stateHome>/pi-better-edit`.
- **project settings file** = `<cwd>/.pi/agents/pi-better-edit/settings.json`.
- `XDG_CONFIG_HOME` no longer participates in resolution. It is read in exactly one place — the
  retired-source list that the one-time adoption consults (§D5) — so changing it can never move a
  file this version writes.

| artifact | location |
|---|---|
| global settings | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-better-edit/settings.json` |
| state root (store, legacy json, logs) | `${XDG_STATE_HOME:-~/.local/state}/pi-better-edit/` |
| project settings | `<cwd>/.pi/agents/pi-better-edit/settings.json` |
| with the override set | `<override>/settings.json` and `<override>/state/` |

`hash-store.sqlite`, the pre-SQLite `hash-store.json` and `diagnostics.log`/`.1` sit directly in the
state root — no further nesting, because the root already names this extension.

A relative `XDG_STATE_HOME` is ignored: a relative XDG base resolves against whichever working
directory happens to be current, which is not a place machine-local state can live. Unlike the
retired `XDG_CONFIG_HOME` read, the state variable is honored on every platform, Windows included —
one rule everywhere instead of a platform split.

Only `PI_CODING_AGENT_DIR` is `~`-expanded, and only into an absolute result. It is a pi-owned
variable that pi itself documents in `~` form; the override stays verbatim (§D2), because the two
variables answer different questions and the override's verbatim contract is load-bearing for test
isolation.

### D2. The override keeps its meaning and gains state

`PI_BETTER_EDIT_CONFIG_DIR` still names the extension's own root **verbatim**: nothing is appended
to it, nothing is sanitised, and the reader creates nothing. Empty counts as unset. It is still the
**only** thing that can move the store — a config-file key cannot, which ADR-0037's rule keeps in
force.

What changes is what the root contains: with the override set the layout is `<override>/settings.json`
and `<override>/state/`, and the store, the legacy json and the logs all live under `state/`. The
override therefore moves settings and state together: the root is still taken verbatim and nothing is
appended to it, but state now lives inside it instead of the store living elsewhere.

One variable rather than two, because a single variable that names "the extension's own root" cannot
disagree with itself, and every existing isolation harness (per-worker temp directories,
`test/support/isolate-store.ts`) keeps working by pointing one directory. The price is that settings
and state cannot be moved independently — accepted, and stated in the consequences.

### D3. The store starts fresh; the old one is abandoned in place

`<old config dir>` below is the ordered list of retired directories: `PI_BETTER_EDIT_CONFIG_DIR`
when it is set, then `$XDG_CONFIG_HOME/pi-better-edit` (off Windows in the old ladder, honoured here
on every platform because the directory existed wherever it existed), then
`$HOME/.config/pi-better-edit`, deduped. Every artifact below is looked for in that order.

- The old `<old config dir>/hash-store.sqlite` (with `-wal` and `-shm`) is never copied, renamed,
  moved or deleted. An un-restarted older version may still own the file, and a copy would diverge
  from the file that session keeps writing.
- Its path is logged **once per session** through `diagnostics.log`, deduped by a marker file in the
  state root, so the pointer is neither lost nor repeated on every start.
- There is no import, backup, or `VACUUM`, and no schema-compatibility shim for the old file. The
  store is a disposable cache: snapshots re-materialize from the files on disk, which is the
  invariant ADR-0017 already relies on.
- The visible cost: anchors leased before the upgrade do not resolve afterwards. A pre-upgrade
  anchor fails closed (`[E_UNKNOWN_ANCHOR]`, or the range family) until a fresh read. That is loud,
  not silent, and it is the designed behaviour of a lease whose store is gone.

### D4. What moves, what is deleted, what stays

| artifact | where it was | what happens |
|---|---|---|
| global settings, override directory | `<override>/pi-better-edit.json` | adopted (§D5) |
| global settings, XDG config directory | `$XDG_CONFIG_HOME/pi-better-edit/pi-better-edit.json` | adopted (§D5) |
| global settings, old home default | `~/.config/pi-better-edit/pi-better-edit.json` | adopted (§D5) |
| global settings, agents dir | `~/.pi/agents/pi-better-edit.json` | adopted (§D5) |
| project settings, flat | `<cwd>/.pi/agents/pi-better-edit.json` | adopted (§D5) |
| `hash-store.sqlite` + `-wal` + `-shm` | old config dir | **left in place**, path logged once per session |
| `hash-store.json` (pre-SQLite) | old config dir | moved into the state root when the destination is absent |
| `diagnostics.log`, `diagnostics.log.1` | old config dir | moved into the state root when the destination is absent |
| `.corrupt-<ts>` dumps | old config dir | **deleted** |

The pass is idempotent (marker file `.migration-v1` in the state root), best-effort, never throws,
never fails a tool call, and runs before the first store open and the first diagnostics write, so no
reader can observe a half-moved layout.

The marker records "nothing is left to move", not "the pass ran": a move that cannot be completed
— and a `rename` that cannot cross a device boundary falls back to copy-then-unlink first — leaves it
unwritten, so the next session tries again. A failed DELETION is only reported, because it is retried
by nothing and withholding the marker would re-walk the retired directories on every session forever.

The asymmetry is deliberate. `hash-store.json` is inert data — read only by the migration path of a
store that has no SQLite file yet. The logs are append-only diagnostics where the loss of the newest
line is acceptable. The SQLite trio is a live database with a WAL and a lock, so it is the one
artifact whose copy or deletion could corrupt another process's session. The `.corrupt-<ts>` dumps
are our own forensic copies of a store we are abandoning, so they are the only thing this pass
deletes.

### D5. Adoption: write, verify, then rename every retired source

Precedence per scope, first match wins:

- global: `<settings root>/settings.json` → `<override>/pi-better-edit.json` (only when the override
  is set) → `$XDG_CONFIG_HOME/pi-better-edit/pi-better-edit.json` →
  `~/.config/pi-better-edit/pi-better-edit.json` → `~/.pi/agents/pi-better-edit.json`;
- project: `<cwd>/.pi/agents/pi-better-edit/settings.json` →
  `<cwd>/.pi/agents/pi-better-edit.json`.

Adopt means: write the bytes through the existing atomic writer (`updateConfigFile` in
`src/json-config.ts`, which writes a sibling temporary file and renames it over the target), verify
that the written file parses, and only then rename **every** existing retired source — not merely the
one that won — to `<path>.bak`.

- The read side never depends on the write side. A failed adoption still serves the keys it read,
  logs one warning, and retires nothing.
- Project adoption is skipped entirely — old keys served, nothing renamed — when the project tree is
  not writable, so a read-only checkout does not pay a failed write per session.
- Once the new file exists it always wins; a retired file is never re-adopted.
- `.bak` files produced by adoption are ours: never warned about, never deleted.

Why write-then-rename rather than a move: a move breaks a concurrently running older version and can
lose the settings outright on a partial failure. Why rename every retired source rather than the
winner alone: the retired copies must stop being live configuration, or deleting the new file would
silently resurrect stale settings, and "retired" would describe only one of them.

Retired sources are read from the override, the XDG config root and `~/.config`, in that order,
plus the older flat `~/.pi/agents/pi-better-edit.json`; new paths never consult `XDG_CONFIG_HOME`.
That is the whole ladder: a user who set the override kept `pi-better-edit.json` in it, a user who
relocated with `XDG_CONFIG_HOME` kept it under that base, and everyone else kept it under
`~/.config`. Adoption looks where the old ladder looked, while nothing this version WRITES depends
on that variable — so moving it moves no new file, and the ceiling is a source nobody had.

### D6. Fail-fast when the state root cannot be created

If the state root cannot be created (EACCES, EROFS, EPERM and the like), a store-dependent call
fails closed with the existing `[E_ACCESS]`, carrying `{ path: <state root>, kind: "denied",
access: "write" }` from `src/domain-errors.ts`. No new error code and no widening of the registry: an
unwritable state directory is a permission failure, and the model already knows how to read one.

There is no fallback directory. A silent second state root is a fork, and a store that forks is worse
than one that fails: two histories, two vacuums, two sets of leases that cannot see each other.
Diagnostics logging stays best-effort, and must never throw or recurse into itself while reporting
the failure that made it relevant.

### D7. The status surface names both roots

`/pi-better-edit` prints the settings file path, the state root, the override (its variable name plus
its value, or `unset`) and the project settings path. The published sentence "the store path is set
by `PI_BETTER_EDIT_CONFIG_DIR` alone" stays true; what changes is that the same variable also owns
the state root's parent.

### D8. Release classification: MINOR

MINOR, because nothing a user's tooling depends on changes shape. The variables keep their names and
their meanings, the schema keeps its `$id` and its validation shape (only prose naming a location
changes), no error code is added or removed, and no tool accepts a different payload. A user who
never set the override keeps their settings through adoption; a user who did keeps their isolation
lever. A MAJOR would require removing or renaming one of those surfaces, and none is touched.

## Consequences

- Nothing reads an old config directory after the one-time adoption, and `XDG_CONFIG_HOME` leaves
  resolution entirely: it names retired sources only. Retired settings and state are therefore read
  from the override, the XDG config root and `~/.config`, in that order, and a user who had relocated
  the old directory with `XDG_CONFIG_HOME` is adopted like everyone else — their file is found where
  the old ladder left it, and their artifacts move with it.
- An un-restarted older session keeps its own store and is untouched by the move; the two layouts
  cannot contend for a lock because they are different files. If that older session reads its settings
  after the adoption it finds its file renamed `.bak` and falls back to the ladder's defaults — a
  settings-only effect, bounded to that one session.
- A crash between the atomic write and the renames leaves the new file in place and a retired file
  live. The new file still wins, so nothing is served from the stale copy.
- An unusable state root now fails loudly on the first store-dependent call instead of silently
  writing somewhere else. The status surface and diagnostics logging stay best-effort; only
  store-dependent calls fail.
- The override can no longer move the store without moving settings. Operators who need them apart
  must leave the override unset and use the defaults, or accept both under one root.
- Anchors from a pre-upgrade session do not survive; the store is fresh. That is the price of not
  forking the store, and it is the disposable-cache invariant being used as designed rather than an
  accident of the move.
- The published schema keeps its id and shape, so validators, editor completion and generated
  documentation do not break.

## Alternatives considered

- **Copy or rename the old SQLite store into the state root.** Rejected: an un-restarted older
  session may still hold the file (WAL, lock). A copy diverges from the file it keeps writing; a
  move breaks that session outright. The store is re-derivable, so the copy buys nothing.
- **A second environment variable for the state root.** Rejected: two variables can disagree about
  "the extension's own root", the override already answers that question, and every isolation
  harness would have to learn both, and #190 makes a new variable a non-goal.
- **Keep settings in `~/.config/pi-better-edit` and move only state.** Rejected: it leaves the
  hand-edited file in a directory pi does not own and keeps two roots to explain, when the agent dir
  already exists for exactly this purpose.
- **Delete the retired SQLite store.** Rejected: not ours to delete while another version may own
  it, and a deletion is unrecoverable where an abandoned file is merely dead weight.
- **Migrate settings by moving the file.** Rejected: a move breaks a concurrently running older
  version and can lose the file on a partial failure. Adoption writes and verifies before it
  renames anything aside.
- **Fall back to `~/.config` when the state root is unusable.** Rejected (D6): a silent second state
  root is a fork, and a fork is worse than a refusal.
- **MAJOR with a deprecation window for the old paths.** Rejected: no accepted payload, key, variable
  or error code changes, and the override keeps both its name and its verbatim meaning.

## Links

- [ADR-0037 — The store janitor: lifecycle-triggered, throttled, batched GC with one deep check and one checkpoint](0037-store-janitor-lifecycle-maintenance-model.md) — its store-directory paragraph and its
  `~/.config/pi-better-edit/pi-better-edit.json` default are superseded here; the record itself is
  left as written.
- [ADR-0017 — Retired epoch concurrency and the bounded LRU snapshot vacuum](0017-lru-vacuum-supersedes-epoch-concurrency.md) — the disposable-cache invariant that makes a fresh
  store safe.
- [ADR-0038 — Interactive settings overlay for the slash command surface](0038-settings-overlay.md) —
  the `/pi-better-edit` surface D7 extends.
- Tracking: #190.
