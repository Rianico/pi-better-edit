# Explicit Edit Benchmark results for pi-better-edit

> **Archived from pre-migration issue #123.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @alexshpunt on 2026-09-15T15:29:33Z · state CLOSED · labels: (none)

## Body

Hi! I’m maintaining the [Explicit Edit Benchmark](https://github.com/alexshpunt/explicit-edit-benchmark), a small public benchmark for measuring how much agent tooling and harness design affect a model’s ability to make precise text edits.

Text editing is one of the most common operations in coding-agent workflows. In my experience, it is also one of the operations agents struggle with the most. Encodings, text blocks, line endings, invisible characters, unicode, and file formats with strict formatting or structural requirements create a huge number of variations. I have seen an agent fail to edit a single line because it could not reproduce an invisible character in that line. There are many cases like this.

The benchmark currently contains 226 deterministic tasks across different file formats and edit types: replacements, insertions, deletions, moves, copies, unicode cases, large files, and other edge cases. The tasks are intentionally simple, so they can be run even with low reasoning and keep the focus on the model and tooling combination rather than deep problem solving.

I’ve been running as many agents, models, configurations, and Pi editing extensions as I can and publishing every accepted observation in the public dataset. There are too many combinations for one person to cover, and model behavior is stochastic, so a single run cannot give us a reliable picture. The benchmark was designed from the start as a public, community-driven dataset that anyone interested and able to run it can contribute to. We can get reliable information only by collecting enough observations across different setups.

I searched for Pi extensions that focus on text editing, and your package, `pi-better-edit`, was one of them. Since it tackles the same problem as the benchmark, I included it in the initial sample.

You can inspect the current data here:

Explorer: https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Api-better-edit%40latest

Dataset / raw observations:  
https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark

Benchmark source:  
https://github.com/alexshpunt/explicit-edit-benchmark

If you’re interested, you’re very welcome to verify the configuration, run the benchmark for your own configuration, model, agent, or other setup, contribute observations, or point out anything that is represented incorrectly.

The benchmark also provides a live badge for participating projects. If you find the benchmark useful, you can add this badge to your repository:

```md
[![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/pi-better-edit.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Api-better-edit%40latest)
```

It links directly to the filtered Explorer and updates when new accepted runs are published.

No action required. I wanted to share the data because your project is part of the same effort to make text editing by coding agents more reliable.







## Comments

### @Rianico — 2026-09-16T09:26:34Z

Hi Alex, thanks for reaching out and for sharing the results — the benchmark looks genuinely interesting, and it targets a problem we care about as well.

Unfortunately I can't engage properly right now: we're in the middle of a major version iteration and still have a number of unresolved bugs to work through. Once those are fixed, I'd be glad to run pi-better-edit through the benchmark and contribute the observations.

I'll keep this issue in mind and follow up when things settle down. Thanks again for the invitation.

### @Rianico — 2026-09-23T11:40:20Z

Already submit a pr for latest version, badge added, done.
