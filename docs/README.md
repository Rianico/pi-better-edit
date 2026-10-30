# pi-better-edit Documentation

Welcome to the internal engineering documentation for `pi-better-edit`.

---

## Directory Roadmap

```text
docs/
├── reference/       # Authoritative daily-driver references for developers and agents
│   ├── error-and-warning-contract.md  # Closed registry of domain errors ([E_*]) & warnings ([W_*])
│   └── benchmarks.md                  # Explicit Edit Benchmark data, methodology, and matrices
├── spec/            # Formal architecture and component specifications
│   ├── README.md                      # Specification roadmap and status catalog
│   ├── content-addressed-line-identity-mvcc.md # Definitive MVCC v2 architecture specification
│   └── ...                            # Component & historical milestone specifications
├── articles/        # Primary empirical research & design reviews
│   ├── formatter-whitespace-churn-js-ts.md
│   ├── formatter-whitespace-churn-python-bash.md
│   ├── formatter-whitespace-churn-rust-go-java.md
│   ├── hash-anchors-myers-single-token-review.md
│   ├── tool-contracts-for-llm.md
│   └── absorption-plan.md
├── analysis/        # Focused technical analyses
│   └── bash-interception-gaps.md
├── adr/             # Architectural Decision Records (ADR-0001 through ADR-0050)
├── agents/          # Agent harness conventions, toolchain snapshot, and issue tracking
└── .archive_issues/ # Archive of resolved GitHub issues and historical reviews
```

---

## Reading Order

1. **System Overview**: Start with the [Root README](../README.md) for core philosophy, token economics, tools, and high-level architecture.
2. **Architecture**: Read [`spec/content-addressed-line-identity-mvcc.md`](spec/content-addressed-line-identity-mvcc.md) for the formal MVCC specification (CAS snapshots, line lineage, Patience LIS alignment).
3. **Decisions**: Explore [`adr/`](adr/) for the sequence of architectural decision records governing design choices.
4. **Reference Contracts**:
   - [`reference/error-and-warning-contract.md`](reference/error-and-warning-contract.md) for machine-actionable error diagnostics.
   - [`reference/benchmarks.md`](reference/benchmarks.md) for independent benchmark results and comparison matrices.
5. **Empirical Research**: Explore [`articles/`](articles/) for whitespace formatter churn across languages and tokenizer stability analyses.
