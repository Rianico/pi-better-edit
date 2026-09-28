# Same-session write serves dense, bash documented as drift-correct

> **Archived from pre-migration issue #70.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-04T15:18:39Z · state CLOSED · labels: ready-for-agent

## Body

## What to build

A file written via the built-in write tool carries dense serves for the new content so the next edit does not report it as drift. Bash and other out-of-band writers stay drift-correct by design and this is documented, not sniffed.

## Acceptance criteria

- [ ] write success records dense serves under (sessionKey, absolutePath) matching edit/read keying
- [ ] write then edit same file in one session is drift-free
- [ ] Bash/out-of-band modification still drifts (test) and docs state bash bypasses serve
- [ ] `npm test` and `tsc --noEmit` green

## Blocked by

Blocked by: #68 (shares drift semantics: canon-equality decides what counts after write-serve lands)

Part of drift-single-session work

## Comments

### @Rianico — 2026-09-05T06:42:53Z

Opened PR #73 (fix/write-serve → fix/drift-canon, stacked on #71).

### @Rianico — 2026-09-05T06:49:21Z

Shipped to main via local merge of fix/write-serve (dense write-serve, file_path, docs). PR #73 closed as superseded.
