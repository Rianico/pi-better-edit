# Test grammar fixtures

These gzip-compressed web-tree-sitter grammars let the read-expansion tests parse real
TypeScript and TSX source offline. They are test-only: the published package's `files`
list excludes `test`, and `pnpm pack --dry-run` must stay `.wasm`-free.

| File | Source | Uncompressed SHA-256 |
| --- | --- | --- |
| `tree-sitter-typescript.wasm.gz` | `tree-sitter-typescript` v0.23.2 TypeScript release asset | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm.gz` | `tree-sitter-typescript` v0.23.2 TSX release asset | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |

The digests match `src/read-expansion/grammar-manifest.ts`. Tests decompress the fixture and
inject it through the same fetch boundary as #204, so verify never touches the network.
