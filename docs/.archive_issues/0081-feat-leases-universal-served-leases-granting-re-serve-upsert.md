# feat(leases): universal served_leases granting & re-serve upsert contract (T3)

> **Archived from pre-migration issue #81.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-12T07:37:59Z · state CLOSED · labels: ready-for-agent

## Body

## Parent\n#78\n\n## What to build\nBacks  with  and  (drift notice  dedup). Wires universal lease granting across all read and diff serve hooks with atomic upsert on re-serve (). Introduces the authoritative  writer in read-path materialization.\n\n## Acceptance criteria\n- [ ] Implement  access and lease storage in \n- [ ] Retain drift notice deduplication via  ( set)\n- [ ] Wire atomic upsert on re-serve (), breaking fail-closed retry loops\n- [ ] Wire authoritative  writer in read-path materialization ()\n- [ ] Modernize  (lines 27, 85) to assert  upsert and  lifecycle\n- [ ] Modernize  to test against  / \n- [ ] 
  ! eslint(no-unreachable): Unreachable code.
     ,-[src/hashline/resolve.ts:284:3]
 283 |   }
 284 |   return { ...edit, content_lines: contentLines };
     :   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 285 | }
     `----
  help: Remove the unreachable code or fix the control flow to make it reachable.

  ! eslint(no-unreachable): Unreachable code.
     ,-[src/hashline/resolve.ts:307:3]
 306 |   );
 307 |   return { ...edit, content_lines: contentLines };
     :   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 308 | }
     `----
  help: Remove the unreachable code or fix the control flow to make it reachable.

  ! unicorn(no-new-array): Do not use `new Array(singleArgument)`.
     ,-[src/hashline/hash-identity.ts:180:20]
 179 |     const lines = splitLines(content);
 180 |     const hashes = new Array<string>(lines.length);
     :                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 181 |     const used = new Uint32Array(BITSET_WORDS);
     `----
  help: It's not clear whether the argument is meant to be the length of the array or the only element. If the argument is the array's length, consider using `Array.from({ length: n })`. If the argument is the only element, use `[element]`.

  ! unicorn(no-new-array): Do not use `new Array(singleArgument)`.
     ,-[src/hashline/hash-identity.ts:319:23]
 318 |     const canonCache = new Map<string, string>();
 319 |     const newHashes = new Array<string>(newLines.length);
     :                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 320 |     const used = new Uint32Array(BITSET_WORDS);
     `----
  help: It's not clear whether the argument is meant to be the length of the array or the only element. If the argument is the array's length, consider using `Array.from({ length: n })`. If the argument is the only element, use `[element]`.

Found 4 warnings and 0 errors.
Finished in 131ms on 194 files with 97 rules using 10 threads.

^[[1m^[[30m^[[46m RUN ^[[49m^[[39m^[[22m ^[[36mv4.1.11 ^[[39m^[[90m/Users/zhengxk/development/ai/pi-better-edit^[[39m

 ^[[32m✓^[[39m test/core/hash-store-open-errors.test.ts ^[[2m(^[[22m^[[2m8 tests^[[22m^[[2m)^[[22m^[[33m 819^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m does not quarantine the store on a busy open error ^[[33m 341^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m propagates a persistent busy error after exhausting retries ^[[33m 304^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit-tool-seam.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[33m 1421^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m exposes deep EditTool module with execute/preview interface ^[[33m 1372^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.multi.test.ts ^[[2m(^[[22m^[[2m16 tests^[[22m^[[2m)^[[22m^[[33m 668^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/replace-end-to-end.test.ts ^[[2m(^[[22m^[[2m14 tests^[[22m^[[2m)^[[22m^[[33m 745^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/served-store.test.ts ^[[2m(^[[22m^[[2m46 tests^[[22m^[[2m)^[[22m^[[33m 885^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/drift-notice.test.ts ^[[2m(^[[22m^[[2m8 tests^[[22m^[[2m)^[[22m^[[33m 472^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.preview.test.ts ^[[2m(^[[22m^[[2m29 tests^[[22m^[[2m)^[[22m^[[33m 1113^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-stress.test.ts ^[[2m(^[[22m^[[2m17 tests^[[22m^[[2m)^[[22m^[[33m 1321^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-fuzz-autofix.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[33m 603^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m applies 1500 random edits and keeps mapping invariants ^[[33m 480^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/replace-undo.test.ts ^[[2m(^[[22m^[[2m22 tests^[[22m^[[2m)^[[22m^[[33m 1397^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.noop-loop.test.ts ^[[2m(^[[22m^[[2m7 tests^[[22m^[[2m)^[[22m^[[33m 319^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/fs-write-edge-cases.test.ts ^[[2m(^[[22m^[[2m20 tests^[[22m^[[2m)^[[22m^[[33m 354^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-limit.test.ts ^[[2m(^[[22m^[[2m6 tests^[[22m^[[2m)^[[22m^[[33m 2215^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m hashes exactly MAX_HASH_LINES lines with unique anchors ^[[33m 554^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m preserves unique hashes at the boundary through the store path ^[[33m 493^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m reads a file at the limit without hashing errors ^[[33m 814^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/served-range-verification.test.ts ^[[2m(^[[22m^[[2m8 tests^[[22m^[[2m)^[[22m^[[33m 536^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/replace-tool.test.ts ^[[2m(^[[22m^[[2m10 tests^[[22m^[[2m)^[[22m^[[33m 467^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/snapshot-store.test.ts ^[[2m(^[[22m^[[2m13 tests^[[22m^[[2m)^[[22m^[[33m 438^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/fs-write.test.ts ^[[2m(^[[22m^[[2m16 tests^[[22m^[[2m)^[[22m^[[33m 308^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.test.ts ^[[2m(^[[22m^[[2m12 tests^[[22m^[[2m)^[[22m^[[33m 510^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/serve-recording.test.ts ^[[2m(^[[22m^[[2m16 tests^[[22m^[[2m)^[[22m^[[32m 271^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/p0-external-change-identity.test.ts ^[[2m(^[[22m^[[2m15 tests^[[22m^[[2m)^[[22m^[[33m 1163^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m probe L: large file 30k lines with exterior insert auto-rebases via scaled budget ^[[33m 348^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/strict-hashline-loop.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[33m 355^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/chained-edit-anchors.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[33m 421^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-property.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[33m 401^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/served-edge-cases.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[32m 264^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/noop-hash-stability.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[32m 220^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.queue.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[33m 308^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.text-shape.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[32m 231^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/preview-no-persist.test.ts ^[[2m(^[[22m^[[2m6 tests^[[22m^[[2m)^[[22m^[[32m 288^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-stable-duplicate.test.ts ^[[2m(^[[22m^[[2m6 tests^[[22m^[[2m)^[[22m^[[32m 259^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/file-kind.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[32m 206^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/metrics.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[32m 224^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/mutation-engine.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[33m 366^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/whitespace-insensitive-tool-seam.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[33m 321^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/boundary-dup-correction.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[33m 317^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hash-store.test.ts ^[[2m(^[[22m^[[2m20 tests^[[22m^[[2m)^[[22m^[[33m 450^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/served-truncation-chained.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[33m 357^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/read.test.ts ^[[2m(^[[22m^[[2m10 tests^[[22m^[[2m)^[[22m^[[32m 141^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/stale-position-compound.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[32m 255^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/diff-serve-chained.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[33m 317^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.handler.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[32m 217^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/file-reader.test.ts ^[[2m(^[[22m^[[2m12 tests^[[22m^[[2m)^[[22m^[[32m 295^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/hash-heal-tdd.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[32m 220^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/auto-read-after-write.test.ts ^[[2m(^[[22m^[[2m13 tests^[[22m^[[2m)^[[22m^[[32m 215^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/file-content.test.ts ^[[2m(^[[22m^[[2m6 tests^[[22m^[[2m)^[[22m^[[32m 201^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/served-state.test.ts ^[[2m(^[[22m^[[2m18 tests^[[22m^[[2m)^[[22m^[[32m 226^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/disjoint-batch-drift.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[32m 232^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/file-kind.test.ts ^[[2m(^[[22m^[[2m14 tests^[[22m^[[2m)^[[22m^[[32m 205^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/write-hook.hash-echo.test.ts ^[[2m(^[[22m^[[2m7 tests^[[22m^[[2m)^[[22m^[[32m 172^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/fs-write.test.ts ^[[2m(^[[22m^[[2m8 tests^[[22m^[[2m)^[[22m^[[32m 225^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/snapshot.test.ts ^[[2m(^[[22m^[[2m7 tests^[[22m^[[2m)^[[22m^[[32m 249^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.noop-warning.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[32m 167^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/fs-write.newfile.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[32m 84^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.multi-undo.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[33m 433^[[2mms^[[22m^[[39m
     ^[[33m^[[2m✓^[[22m^[[39m creates one undo record and undo restores the pre-call content ^[[33m 431^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.missing-path.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[32m 90^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/auto-read-handler.test.ts ^[[2m(^[[22m^[[2m16 tests^[[22m^[[2m)^[[22m^[[33m 554^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/image-handling.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[32m 251^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/served-rows-handler.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[33m 453^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit.format-tolerance.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[32m 89^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/snapshot-id.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[33m 458^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/integration/served-truncation-external-shrink.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[32m 38^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/served-session.test.ts ^[[2m(^[[22m^[[2m7 tests^[[22m^[[2m)^[[22m^[[32m 68^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/edit-diff.preview.test.ts ^[[2m(^[[22m^[[2m7 tests^[[22m^[[2m)^[[22m^[[32m 113^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/payload-file-path.test.ts ^[[2m(^[[22m^[[2m9 tests^[[22m^[[2m)^[[22m^[[32m 99^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/read-skill.test.ts ^[[2m(^[[22m^[[2m6 tests^[[22m^[[2m)^[[22m^[[32m 171^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/permission-errors.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[32m 44^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/edit-presentation.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[32m 19^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/extension/lifecycle.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[32m 64^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/edit-contract.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[32m 55^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/reject-and-serve-seam.test.ts ^[[2m(^[[22m^[[2m7 tests^[[22m^[[2m)^[[22m^[[32m 31^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/read-preview.test.ts ^[[2m(^[[22m^[[2m20 tests^[[22m^[[2m)^[[22m^[[32m 34^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/validation.test.ts ^[[2m(^[[22m^[[2m11 tests^[[22m^[[2m)^[[22m^[[32m 51^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/store-memory.test.ts ^[[2m(^[[22m^[[2m9 tests^[[22m^[[2m)^[[22m^[[32m 83^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/replace-response.test.ts ^[[2m(^[[22m^[[2m15 tests^[[22m^[[2m)^[[22m^[[32m 45^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/hashline/healing.test.ts ^[[2m(^[[22m^[[2m8 tests^[[22m^[[2m)^[[22m^[[32m 5^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/indent-dup.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[32m 25^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-stride.test.ts ^[[2m(^[[22m^[[2m7 tests^[[22m^[[2m)^[[22m^[[32m 39^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/fs-write.cleanup.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[32m 44^[[2mms^[[22m^[[39m
^[[90mstdout^[[2m | fmt-probe.test.ts^[[2m > ^[[22m^[[2mformat-tolerance probe^[[2m > ^[[22m^[[2mfresh recompute after whitespace-only reformat
^[[22m^[[39mH0 (clean before): [ ^[[32m'CTt'^[[39m, ^[[32m'nVR'^[[39m, ^[[32m'7Zr'^[[39m, ^[[32m'AU6'^[[39m ]

^[[90mstdout^[[2m | fmt-probe.test.ts^[[2m > ^[[22m^[[2mformat-tolerance probe^[[2m > ^[[22m^[[2mfresh recompute after whitespace-only reformat
^[[22m^[[39mnextHashes (messy, stable map): [
  ^[[32m'CTt'^[[39m, ^[[32m'nVR'^[[39m,
  ^[[32m'7Zr'^[[39m, ^[[32m'8as'^[[39m,
  ^[[32m'UfM'^[[39m, ^[[32m'81o'^[[39m,
  ^[[32m'92p'^[[39m
]

^[[90mstdout^[[2m | fmt-probe.test.ts^[[2m > ^[[22m^[[2mformat-tolerance probe^[[2m > ^[[22m^[[2mfresh recompute after whitespace-only reformat
^[[22m^[[39mH2 (clean after, fresh pure): [
  ^[[32m'CTt'^[[39m, ^[[32m'nVR'^[[39m,
  ^[[32m'7Zr'^[[39m, ^[[32m'AU6'^[[39m,
  ^[[32m'UfM'^[[39m, ^[[32m'81o'^[[39m,
  ^[[32m'92p'^[[39m
]
nextHashes anchors surviving fresh recompute: [ ^[[32m'CTt'^[[39m, ^[[32m'nVR'^[[39m, ^[[32m'7Zr'^[[39m, ^[[32m'UfM'^[[39m, ^[[32m'81o'^[[39m, ^[[32m'92p'^[[39m ]
ALL survive? ^[[33mfalse^[[39m

 ^[[32m✓^[[39m fmt-probe.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[32m 4^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/fs-write-cleanup-on-error.test.ts ^[[2m(^[[22m^[[2m4 tests^[[22m^[[2m)^[[22m^[[32m 41^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/arch/c3-served-session-deepening.test.ts ^[[2m(^[[22m^[[2m6 tests^[[22m^[[2m)^[[22m^[[32m 47^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/fs-write.permissions.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[32m 22^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/undo-store.test.ts ^[[2m(^[[22m^[[2m14 tests^[[22m^[[2m)^[[22m^[[32m 31^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-stable-mapping.test.ts ^[[2m(^[[22m^[[2m33 tests^[[22m^[[2m)^[[22m^[[32m 50^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/validation-access.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[32m 14^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/utils.test.ts ^[[2m(^[[22m^[[2m50 tests^[[22m^[[2m)^[[22m^[[32m 8^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline.hash.test.ts ^[[2m(^[[22m^[[2m12 tests^[[22m^[[2m)^[[22m^[[32m 25^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/whitespace-insensitive-canon.test.ts ^[[2m(^[[22m^[[2m8 tests^[[22m^[[2m)^[[22m^[[32m 100^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/preview-controller.test.ts ^[[2m(^[[22m^[[2m10 tests^[[22m^[[2m)^[[22m^[[32m 16^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/served-verification.test.ts ^[[2m(^[[22m^[[2m10 tests^[[22m^[[2m)^[[22m^[[32m 9^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline.apply.test.ts ^[[2m(^[[22m^[[2m51 tests^[[22m^[[2m)^[[22m^[[32m 32^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-apply-internals.test.ts ^[[2m(^[[22m^[[2m27 tests^[[22m^[[2m)^[[22m^[[32m 24^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/edit-hash-echo.test.ts ^[[2m(^[[22m^[[2m13 tests^[[22m^[[2m)^[[22m^[[32m 6^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline-strict-input.test.ts ^[[2m(^[[22m^[[2m22 tests^[[22m^[[2m)^[[22m^[[32m 27^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline.changed-range.test.ts ^[[2m(^[[22m^[[2m10 tests^[[22m^[[2m)^[[22m^[[32m 3^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline.parse.test.ts ^[[2m(^[[22m^[[2m24 tests^[[22m^[[2m)^[[22m^[[32m 5^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/replace-normalize.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[32m 5^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/edit-diff.utils.test.ts ^[[2m(^[[22m^[[2m28 tests^[[22m^[[2m)^[[22m^[[32m 7^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline.recovery.test.ts ^[[2m(^[[22m^[[2m24 tests^[[22m^[[2m)^[[22m^[[32m 22^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/drift.test.ts ^[[2m(^[[22m^[[2m18 tests^[[22m^[[2m)^[[22m^[[32m 5^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/hashline.resolve.test.ts ^[[2m(^[[22m^[[2m14 tests^[[22m^[[2m)^[[22m^[[32m 4^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/lifecycle-hooks.test.ts ^[[2m(^[[22m^[[2m10 tests^[[22m^[[2m)^[[22m^[[32m 20^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/replace-render.test.ts ^[[2m(^[[22m^[[2m31 tests^[[22m^[[2m)^[[22m^[[32m 24^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/edit-payload-legacy-fold.test.ts ^[[2m(^[[22m^[[2m8 tests^[[22m^[[2m)^[[22m^[[32m 6^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/hashline/healing-policy.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[32m 4^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/path-utils.test.ts ^[[2m(^[[22m^[[2m7 tests^[[22m^[[2m)^[[22m^[[32m 3^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/prompts.test.ts ^[[2m(^[[22m^[[2m8 tests^[[22m^[[2m)^[[22m^[[32m 5^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/paths.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[32m 2^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/arch/c4-drift-intervals.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[32m 4^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/runtime.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[32m 4^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/error-codes.test.ts ^[[2m(^[[22m^[[2m2 tests^[[22m^[[2m)^[[22m^[[32m 3^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/constants.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[32m 2^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/tools/replace-validation.test.ts ^[[2m(^[[22m^[[2m9 tests^[[22m^[[2m)^[[22m^[[32m 10^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/core/gemma-tool-calling.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[32m 4^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/extension/prompts.test.ts ^[[2m(^[[22m^[[2m16 tests^[[22m^[[2m)^[[22m^[[32m 15^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/extension/register.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[32m 4^[[2mms^[[22m^[[39m
 ^[[32m✓^[[39m test/arch/payload-contract-seam.test.ts ^[[2m(^[[22m^[[2m5 tests^[[22m^[[2m)^[[22m^[[32m 2^[[2mms^[[22m^[[39m
 ^[[2m^[[90m↓^[[39m^[[22m test/eval/comparison-battery.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m | ^[[22m^[[33m1 skipped^[[39m^[[2m)^[[22m

^[[2m Test Files ^[[22m ^[[1m^[[32m116 passed^[[39m^[[22m^[[2m | ^[[22m^[[33m1 skipped^[[39m^[[90m (117)^[[39m
^[[2m      Tests ^[[22m ^[[1m^[[32m1147 passed^[[39m^[[22m^[[2m | ^[[22m^[[36m6 expected fail^[[39m^[[2m | ^[[22m^[[33m1 skipped^[[39m^[[90m (1154)^[[39m
^[[2m   Start at ^[[22m 15:37:39
^[[2m   Duration ^[[22m 16.52s^[[2m (transform 3.88s, setup 0ms, import 100.36s, tests 28.41s, environment 8ms)^[[22m pass 100% green\n\n## Blocked by\n- #80

## Comments

### @Rianico — 2026-09-15T07:38:58Z

Implemented and shipped.

These landed on `dev/mvcc-line-identity` and are now part of `main` @ `bd3a8f2 feat(edit): adopt line-identity MVCC with leases` (with `bb049dc chore: refresh scaffold to current generation (#122)` on top).

Verified at delivery: the Stage-0 harness was green 15/15 (12 canonical probes A–N + 3 contract deliverables), with the four fail-closed probes (A, E, J, K) asserting **both** the rejection code and byte-identical file content.

Four post-implementation review rounds then found and fixed further issues (#88–#121); all of those findings are in the same `main` state. Closing — reopen if you want any part re-examined.
