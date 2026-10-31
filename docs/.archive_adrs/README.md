# Archived Architectural Decision Records (ADR-0001 through ADR-0050)

This directory preserves the historical, append-only record of architecture decision records (ADRs 0001 through 0050) from the initial development phases of `pi-better-edit`.

As the architecture matured into the production-grade (File, Content)-Addressed Line-Identity CAS MVCC system, these incremental, exploratory, and partially superseded records were synthesized and compacted into the canonical ADR suite located in [`docs/adr/`](../adr/).

## Historical Index

- **0001**: Served-State Range Verification for replace
- **0002**: Session-Keyed Served State; Global Undo and Snapshots
- **0003**: Two-signal line identity (superseded by 0005)
- **0004**: Anchor canon unchanged (superseded by 0005)
- **0005**: Whitespace-insensitive anchors (amended by 0029)
- **0006**: Compact JSON edit payload (superseded by 0007)
- **0007**: Merged edit payload with hoisted path (superseded by 0015, 0032)
- **0008**: Orphaned serves: eager heal (superseded by 0016)
- **0009**: Bounded served hash echo guard
- **0010**: User-facing drift signals
- **0013**: Pos-free roundtrip optimization (superseded by 0017)
- **0014**: User-model audience split
- **0015**: Named object edit payload (superseded by 0032)
- **0016**: Content-addressed line identity supersedes healing
- **0017**: LRU vacuum supersedes epoch concurrency
- **0018**: Region-scoped rejection serves
- **0019**: Malformed code rename (E_SERVED_ECHO -> E_SUSPICIOUS_TEXT)
- **0020**: Unverified range replaces unserved range boundary rule
- **0021**: Unified error and warning contract
- **0022**: File-scoped canons and fresh read stale range
- **0023**: Lease lineage is the span verification authority
- **0024**: Narrow P2 interior exposure cap removed diffs
- **0025**: Rename tombstone to blocked hashes
- **0026**: Retire library seam blocked hash verification signal
- **0027**: Prebuilt bundle is extension entry on both install surfaces
- **0028**: Correlated multifile cut transaction durability
- **0029**: Canon v3 frozen whitespace class
- **0030**: Widen anchors from 3 to 4 characters
- **0031**: File-scoped anchors residual and generation discipline
- **0032**: Flat wire item contract for edit tool
- **0033**: AST-guarded bash view interception
- **0034**: Message convergence on error formats
- **0035**: E_STALE_ANCHOR remedy status
- **0036**: Optional wire fields declared nullable
- **0037**: Store janitor lifecycle maintenance model
- **0038**: Interactive settings overlay
- **0039**: Compound bash view interception and sequential peeling
- **0040**: Read payload single shape (superseded by 0041)
- **0041**: Read payload flat single-file target with windows and mode
- **0042**: Retention runs only on fresh snapshot commits
- **0043**: Unchanged file adopts on stat identity
- **0044**: Pairing skips forced unchanged boundary
- **0045**: 7-day TTL ends lease resolution
- **0046**: Compaction runs after maintenance sweep
- **0047**: Remediation is refusal-scoped neutral Options list
- **0048**: Bash serve admission: display tails, context searches
- **0049**: Multi-file bash views
- **0050**: Two roots: settings in pi agent dir, state in XDG state dir

## Active Synthesized ADRs

See [`docs/adr/`](../adr/) for the active, compacted decision records:
- **ADR-0001**: Content-Addressed Line-Identity CAS MVCC & Dynamic Rebase
- **ADR-0002**: Tokenizer-Stable 4-Character Anchors, Canon v3 Whitespace Class, and File-Scoped Allocator
- **ADR-0003**: Model-Facing Payload Contracts for Read and Edit Tools
- **ADR-0004**: Model-Tool Boundary, Fail-Closed Verification, and Error/Warning Protocol
- **ADR-0005**: Store Janitor Lifecycle, 7-Day Hard TTL, Compaction, and Two-Root Storage Architecture
- **ADR-0006**: AST-Guarded Bash View Interception, Compound Peeling, and Multi-File Views
- **ADR-0007**: Prebuilt Bundle Extension Entry Across Install Surfaces
