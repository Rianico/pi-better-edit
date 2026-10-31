# 0005. Store Janitor Lifecycle, 7-Day Hard TTL, Compaction, and Two-Root Storage Architecture

Date: 2026-10-30

## Status

Accepted

## Context

The SQLite Content-Addressed Store (CAS) retains snapshots, line lineages, and session leases across sessions to power zero-token rebasing and undo functionality. Without automated lifecycle management, disk usage grows unbounded.

Early implementations suffered from several architectural issues:
1. **Unbounded Storage Growth**: Retaining all historical leases and snapshots without compaction led to multi-gigabyte SQLite databases on active development machines.
2. **Soft TTL Ineffectiveness**: An early soft TTL policy ([`docs/.archive_adrs/0017-lru-vacuum-supersedes-epoch-concurrency.md`](../.archive_adrs/0017-lru-vacuum-supersedes-epoch-concurrency.md)) expired pin authority after 7 days but left physical lease rows in the database, preventing SQLite from reclaiming free pages.
3. **Hot-Path GC Latency**: Performing synchronous cleanup passes during edit executions introduced latency spikes into interactive agent loops.
4. **Directory Layout Non-Compliance**: Placing configuration and state under a combined `~/.config/pi-better-edit/` directory ([`docs/.archive_adrs/0037-store-janitor-lifecycle-maintenance-model.md`](../.archive_adrs/0037-store-janitor-lifecycle-maintenance-model.md)) violated the XDG Base Directory specification and diverged from the pi agent ecosystem conventions.

## Decision

We will isolate configuration from persistent state using a two-root storage architecture and automate maintenance via an off-path Store Janitor.

1. **Two-Root Directory Architecture**:
   - **Configuration Root**: `settingsRoot()/settings.json` where `settingsRoot()` resolves to `<agentHome>/extensions/pi-better-edit` (under `~/.pi/agent/` or `$PI_CODING_AGENT_DIR`), manageable via the interactive slash command overlay (`/pi-better-edit settings`, [`docs/.archive_adrs/0038-settings-overlay.md`](../.archive_adrs/0038-settings-overlay.md)). Legacy flat `pi-better-edit.json` is read once for migration adoption only ([`docs/.archive_adrs/0050-two-roots-settings-in-the-pi-agent-dir-state-in-xdg-state.md`](../.archive_adrs/0050-two-roots-settings-in-the-pi-agent-dir-state-in-xdg-state.md)).
   - **State Root**: `stateRoot()` = `~/.local/state/pi-better-edit/` (or `$XDG_STATE_HOME/pi-better-edit/`) hosts the SQLite database (`hash-store.sqlite`), `-wal` journals, and diagnostic logs.
2. **Off-Path Store Janitor**:
   - Maintenance runs asynchronously off the critical path, wired to lifecycle hooks `JANITOR_EVENTS = ["session_start", "session_shutdown"]` (the host extension API exposes no idle timer or deactivate event).
   - **Commit-Triggered Retention**: Snapshot retention sweeps run strictly upon fresh snapshot commits; read adoption of unchanged files never triggers a retention sweep ([`docs/.archive_adrs/0042-retention-runs-only-on-fresh-snapshot-commits.md`](../.archive_adrs/0042-retention-runs-only-on-fresh-snapshot-commits.md)).
   - **7-Day Hard TTL Expiry**: Leases older than `SERVED_TTL_MS = 7 * 24 * 60 * 60 * 1000` undergo hard deletion, clearing stale session records completely ([`docs/.archive_adrs/0045-ttl-ends-lease-resolution.md`](../.archive_adrs/0045-ttl-ends-lease-resolution.md)).
   - **Post-Sweep Compaction**: A full SQLite `VACUUM` in autocommit executes following maintenance sweeps when free pages are at least **25% of the file** and at least **1 MB** ([`docs/.archive_adrs/0046-compaction-runs-after-maintenance-sweep.md`](../.archive_adrs/0046-compaction-runs-after-maintenance-sweep.md)), returning storage to the filesystem without blocking tool calls.

### Considered Options

- **Single configuration/state root (`~/.config/pi-better-edit`)** — rejected: mixes configuration with runtime state; violates XDG standards and pi agent directory layout (superseded by [`docs/.archive_adrs/0050-two-roots-settings-in-the-pi-agent-dir-state-in-xdg-state.md`](../.archive_adrs/0050-two-roots-settings-in-the-pi-agent-dir-state-in-xdg-state.md)).
- **Synchronous garbage collection on tool execution** — rejected: adds latency jitter to the critical interactive editing path.
- **Soft TTL policy (retention without row deletion)** — rejected: accumulated millions of zombie lease rows and prevented database compaction (superseded by [`docs/.archive_adrs/0045-ttl-ends-lease-resolution.md`](../.archive_adrs/0045-ttl-ends-lease-resolution.md)).

## Consequences

- Conforms to standard Unix and XDG directory specifications.
- Interactive tool execution remains fast and predictable with zero garbage collection overhead.
- Database size is strictly bounded, with automatic disk space reclamation via gated `VACUUM`.
