# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Pre-expansion probe behaviour: does a narrow read get followed by another read
of the same file, and would a wider serve have covered it?

Corpus: real pi sessions under ~/.pi/agent/sessions, excluding any transcript that
already contains read-expansion chrome, so every observation is un-widened.
"""

import collections
import glob
import json
import os
import re
import statistics

SESSIONS = os.path.expanduser("~/.pi/agent/sessions")
CHROME = re.compile(r"\[widened (\d+)-(\d+) -> (\d+)-(\d+), ([^\]]+)\]")
ROWS = re.compile(r"^[A-Za-z0-9_-]{4}\u2502", re.M)
NEAR = 20


def calls_in(path):
    """Ordered tool calls with their arguments and result text."""
    pending = {}
    out = []
    for line in open(path, encoding="utf-8", errors="replace"):
        if '"toolCall"' not in line and '"toolResult"' not in line and '"toolName"' not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        if t == "message":
            m = e.get("message") or {}
            role = m.get("role")
            if role == "assistant":
                for b in m.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "toolCall":
                        cid = b.get("id")
                        pending[cid] = {"name": b.get("name"), "args": b.get("arguments") or {}, "text": ""}
                        out.append(pending[cid])
            elif role == "toolResult":
                cid = m.get("toolCallId")
                text = "".join(
                    c.get("text", "") for c in (m.get("content") or []) if isinstance(c, dict)
                )
                if cid in pending:
                    pending[cid]["text"] = text
                else:
                    out.append({"name": m.get("toolName"), "args": {}, "text": text})
        elif t in ("tool_execution_start", "tool_execution_end"):
            if t == "tool_execution_start":
                cid = e.get("toolCallId")
                pending[cid] = {"name": e.get("toolName"), "args": e.get("args") or {}, "text": ""}
                out.append(pending[cid])
            else:
                cid = e.get("toolCallId")
                text = ""
                r = e.get("result")
                if isinstance(r, dict):
                    text = "".join(
                        c.get("text", "") for c in (r.get("content") or []) if isinstance(c, dict)
                    )
                if cid in pending:
                    pending[cid]["text"] = text
    return [c for c in out if c["name"]]


def reads(calls):
    """Ordered read calls with the requested ranges and the served line count."""
    seq = []
    for idx, c in enumerate(calls):
        if c["name"] != "read":
            continue
        a = c["args"]
        req = []
        ws = a.get("windows")
        if isinstance(ws, list):
            for w in ws:
                if isinstance(w, dict) and isinstance(w.get("offset"), int) and isinstance(w.get("limit"), int):
                    req.append((w["offset"], w["offset"] + w["limit"] - 1))
        if isinstance(a.get("offset"), int) and isinstance(a.get("limit"), int):
            req.append((a["offset"], a["offset"] + a["limit"] - 1))
        served = [(int(m.group(3)), int(m.group(4))) for m in CHROME.finditer(c["text"])]
        seq.append(
            {
                "file": a.get("file") or a.get("path") or "",
                "req": req,
                "served": served,
                "lines": len(ROWS.findall(c["text"])),
                "widened": bool(served),
                "idx": idx,
            }
        )
    return seq


def classify(probe, later):
    """superset: the follow-up covers the probe. extends: it reaches past one side.
    contained: it sits inside what the probe already served. adjacent: near but apart.
    elsewhere: a different part of the file."""
    (a, b), (c, d) = probe, later
    if c <= a and b <= d:
        return "superset"
    if c <= b and a <= d:
        if c < a or d > b:
            return "extends"
        return "contained"
    if c - b <= NEAR and a - d <= NEAR:
        return "adjacent"
    return "elsewhere"


def main():
    files = sorted(glob.glob(SESSIONS + "/**/*.jsonl", recursive=True))
    usable, skipped = [], 0
    for p in files:
        try:
            body = open(p, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        if "[widened " in body:
            skipped += 1
            continue
        usable.append(p)

    probes = 0
    follow = collections.Counter()
    req_sizes, extra, dist, gap, contained_sizes, unions = [], [], [], [], [], []
    sessions = 0
    whole_file_reads = 0
    read_calls = 0

    for p in usable:
        rs = reads(calls_in(p))
        read_calls += len(rs)
        whole_file_reads += sum(1 for r in rs if not r["req"])
        if not any(r["req"] for r in rs):
            continue
        sessions += 1
        for i, s in enumerate(rs):
            if not s["req"]:
                continue
            probes += 1
            r = s["req"][0]
            req_sizes.append(r[1] - r[0] + 1)
            later = [t for t in rs[i + 1 :] if t["file"] == s["file"] and t["req"]]
            if not later:
                follow["none"] += 1
                continue
            nxt = later[0]
            nr = nxt["req"][0]
            k = classify(r, nr)
            follow[k] += 1
            gap.append(nxt["idx"] - s["idx"])
            if k in ("superset", "extends"):
                extra.append(nr[1] - nr[0] + 1 - (r[1] - r[0] + 1))
                union = max(r[1], nr[1]) - min(r[0], nr[0]) + 1
                unions.append(union)
            if k == "contained":
                contained_sizes.append(nr[1] - nr[0] + 1)
            if k == "elsewhere":
                dist.append(min(abs(nr[0] - r[1]), abs(r[0] - nr[1])))

    total = probes or 1
    more = follow["superset"] + follow["extends"]
    print(f"transcripts scanned          : {len(files)}")
    print(f"  excluded (post-expansion)  : {skipped}")
    print(f"  usable                     : {len(usable)}")
    print(f"read calls                   : {read_calls}")
    print(f"  whole-file reads           : {whole_file_reads} ({whole_file_reads/max(read_calls,1)*100:.0f}%)")
    print(f"sessions with a windowed read: {sessions}")
    print(f"windowed probes              : {probes}")
    print()
    print("the next read of the same file:")
    for k in ("none", "superset", "extends", "contained", "adjacent", "elsewhere"):
        n = follow[k]
        print(f"  {k:9} {n:6}  {n/total*100:5.1f}%")
    print()
    print(f"wanted MORE around the probe : {more} ({more/total*100:.1f}% of probes)")
    if req_sizes:
        print(f"median probe size            : {statistics.median(req_sizes):.0f} lines")
    if extra:
        print(f"median extra lines wanted    : {statistics.median(extra):.0f}")
    if dist:
        print(f"median distance, 'elsewhere' : {statistics.median(dist):.0f} lines")
    if gap:
        print(f"median calls until follow-up : {statistics.median(gap):.0f}")
    if unions:
        for cap in (40, 80, 160):
            n = sum(1 for u in unions if u <= cap)
            print(f"  union fits in a {cap:3}-line cap : {n:5}  ({n/total*100:4.1f}% of probes)")
        print(f"  median union of probe+follow-up   : {statistics.median(unions):.0f} lines")
    if contained_sizes:
        print(f"median size of a re-read     : {statistics.median(contained_sizes):.0f} lines")


if __name__ == "__main__":
    main()
