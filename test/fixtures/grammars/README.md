# Test grammar fixtures

These gzip-compressed web-tree-sitter grammars let the read-expansion tests parse real
TypeScript, TSX, Python, Go and Rust source offline. They are test-only: the published package's `files`
list excludes `test`, and `pnpm pack --dry-run` must stay `.wasm`-free.

| File | Source | Uncompressed SHA-256 |
| --- | --- | --- |
| `tree-sitter-typescript.wasm.gz` | `tree-sitter-typescript` v0.23.2 TypeScript release asset | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm.gz` | `tree-sitter-typescript` v0.23.2 TSX release asset | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |
| `tree-sitter-python.wasm.gz` | `tree-sitter-python` v0.25.0 release asset | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-go.wasm.gz` | `tree-sitter-go` v0.25.0 release asset | `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` |
| `tree-sitter-rust.wasm.gz` | `tree-sitter-rust` v0.24.2 release asset | `24c89bd9252255e4aebbcbd7d2d308bd92c86dd95a130fdc80efa49577b8d738` |

The digests match `src/read-expansion/grammar-manifest.ts`. Tests decompress the fixture and
inject it through the same fetch boundary as #204, so verify never touches the network.
