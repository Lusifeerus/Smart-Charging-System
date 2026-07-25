#!/usr/bin/env python3
"""check_flow_outputs.py — Node-RED function-node output-count guard

Node-RED function nodes declare a fixed number of outputs. A node's code can
`return [msgA, msgB, ...]` or call `node.send([...])` with more entries than
the node has outputs wired for — Node-RED silently discards anything past
the declared output count. No error, no warning, no log line. The dropped
message just never arrives anywhere.

This has bitten this project for real, twice:
  - Status Publisher was wired to Evaluator output 1; a correct per-car fix
    made that output conditionally null, silently starving Status Publisher
    on every cycle it went null (fixed by adding a genuine output 3).
  - The PV Eco Fast Tracker node was left at `outputs: 1` while its code
    returns `[ampMsg, frcMsg]` on two outputs — every frc command was
    silently dropped for the life of the node; only amp commands ever
    reached the go-e.

Both are invisible to function-level testing: the code is correct and a
harness that calls the function and inspects its return value proves it.
The bug lives in the gap between what the code returns and what the node is
configured to deliver — this script closes that gap by checking Node-RED
flow exports directly, the same artifact that's actually deployed.

Usage:
    ./check_flow_outputs.py --flow EV_Charging.json --flow PV_Eco.json
    ./check_flow_outputs.py --flow *.json --strict

  --strict   also fail (exit 1) on unwired declared outputs (an output the
             node could send to but nothing is listening on). Off by
             default because an intentionally-unused output (e.g. a debug
             tap left disconnected on purpose) is common and not a bug —
             it's reported as a note either way.

Exit 0 = no output-count mismatches found. Exit 1 = at least one node
returns more array entries than it has outputs (guaranteed silent drop), or
(with --strict) an unwired output.
"""

import argparse
import json
import re
import sys
from pathlib import Path


def _skip_string(code, i):
    """If code[i] starts a string/template literal, return index just past
    its close; otherwise return i unchanged."""
    quote = code[i]
    if quote not in ("'", '"', "`"):
        return i
    j = i + 1
    while j < len(code):
        if code[j] == "\\":
            j += 2
            continue
        if code[j] == quote:
            return j + 1
        j += 1
    return j  # unterminated — bail to end


def _skip_comment(code, i):
    """If code[i:] starts a // or /* */ comment, return index just past it;
    otherwise return i unchanged."""
    if code[i:i + 2] == "//":
        j = code.find("\n", i)
        return len(code) if j == -1 else j
    if code[i:i + 2] == "/*":
        j = code.find("*/", i + 2)
        return len(code) if j == -1 else j + 2
    return i


def _bracket_span(code, open_idx):
    """Given the index of an opening bracket, return (close_idx, top_level_
    comma_count) by scanning forward with depth tracking, skipping strings
    and comments so commas/brackets inside them don't confuse the count."""
    open_ch = code[open_idx]
    close_ch = {"[": "]", "(": ")", "{": "}"}[open_ch]
    depth = 0
    commas = 0
    i = open_idx
    n = len(code)
    while i < n:
        c = code[i]
        if c in ("'", '"', "`"):
            i = _skip_string(code, i)
            continue
        if c == "/" and code[i:i + 2] in ("//", "/*"):
            i = _skip_comment(code, i)
            continue
        if c in "[({":
            depth += 1
        elif c in "])}":
            depth -= 1
            if depth == 0:
                return i, commas
        elif c == "," and depth == 1:
            commas += 1
        i += 1
    return n, commas  # unterminated — bail


# Matches `return [` and `.send([` (the two ways a function node emits an
# array of per-output messages). Also tracks bare `return msg`-style single
# sends, which only ever target output 1 and never risk a silent drop.
RETURN_ARRAY_RE = re.compile(r"\breturn\s*\[")
SEND_ARRAY_RE = re.compile(r"\.send\s*\(\s*\[")


def _strip_comments_and_strings(code):
    """Replace the contents of comments and string/template literals with
    spaces (preserving length/positions and all newlines) so that a
    `return [` or `.send([` found by regex is never one that only exists
    inside a comment or a string, while keeping every other character's
    index unchanged for readability of any future position-based tooling."""
    out = []
    i, n = 0, len(code)
    while i < n:
        c = code[i]
        if c in ("'", '"', "`"):
            j = _skip_string(code, i)
            out.append(c + " " * (j - i - 1))  # blank out the body, keep length
            i = j
            continue
        if c == "/" and code[i:i + 2] in ("//", "/*"):
            j = _skip_comment(code, i)
            segment = code[i:j]
            out.append(re.sub(r"[^\n]", " ", segment))  # blank but keep newlines
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def max_outputs_used(code):
    """Best-effort static estimate of the largest per-output array a
    function node's code ever constructs via `return [...]` or
    `node.send([...])`. Returns 1 if no array-form send/return is found
    (single-output code path — output 1 only, never at risk).

    Searches are run against a comment/string-blanked copy of the code so a
    `return [...]` mentioned only in a comment, or a URL/string containing
    that literal text, is never mistaken for a live code path — the
    bracket-depth scan itself is comment/string-aware too, for arrays that
    start in real code but contain string/comment content."""
    scan_target = _strip_comments_and_strings(code)
    best = 1
    for pattern in (RETURN_ARRAY_RE, SEND_ARRAY_RE):
        for m in pattern.finditer(scan_target):
            open_idx = m.end() - 1  # index of the '[' — same position in `code`
            _, commas = _bracket_span(code, open_idx)
            best = max(best, commas + 1)
    return best


def analyse_node(n):
    """Return a dict describing one function node's output situation, or
    None if the node isn't a function node."""
    if n.get("type") != "function":
        return None
    declared = n.get("outputs", 1) or 1
    code = n.get("func", "")
    needed = max_outputs_used(code)
    wires = n.get("wires", [])
    # Pad/truncate wires to declared length for a fair per-slot check.
    wired_slots = [bool(ws) for ws in wires[:declared]]
    while len(wired_slots) < declared:
        wired_slots.append(False)
    unwired = [i + 1 for i, w in enumerate(wired_slots) if not w]
    return {
        "name": n.get("name") or n.get("id", "?"),
        "declared": declared,
        "needed": needed,
        "mismatch": needed > declared,
        "unwired": unwired,
    }


def check_flow(path, strict):
    errors = []
    notes = []
    try:
        nodes = json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as ex:
        return [f"{path}: not valid JSON ({ex})"], []
    except FileNotFoundError:
        return [f"MISSING FLOW EXPORT: {path}"], []

    checked = 0
    for n in nodes:
        info = analyse_node(n)
        if info is None:
            continue
        checked += 1
        label = f"{Path(path).name}::{info['name']}"
        if info["mismatch"]:
            errors.append(
                f"{label}: code sends up to {info['needed']} output(s) but "
                f"the node declares only {info['declared']} — "
                f"output {info['declared'] + 1}+ is SILENTLY DROPPED by "
                f"Node-RED (no error, no log). Increase the node's "
                f"'Outputs' count and wire the extra output(s)."
            )
        if info["unwired"]:
            msg = (f"{label}: output(s) {info['unwired']} declared but not "
                   f"wired to anything (dead output — harmless if "
                   f"intentional, e.g. a disconnected debug tap)")
            if strict:
                errors.append(msg)
            else:
                notes.append(msg)

    if checked == 0:
        notes.append(f"note: {Path(path).name}: no function nodes found")
    return errors, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flow", action="append", default=[], required=True,
                    help="Node-RED flow export JSON to check (repeatable)")
    ap.add_argument("--strict", action="store_true",
                    help="also fail on unwired declared outputs")
    args = ap.parse_args()

    all_errors = []
    all_notes = []
    total_checked_files = 0
    for flow_path in args.flow:
        errors, notes = check_flow(flow_path, args.strict)
        all_errors.extend(errors)
        all_notes.extend(notes)
        total_checked_files += 1

    for note in all_notes:
        print(note)

    if all_errors:
        print(f"\n✗ FLOW OUTPUT CHECK FAILED ({len(all_errors)} problem(s)):\n")
        for e in all_errors:
            print(f"  • {e}")
        return 1

    print(f"✓ flow outputs OK: {total_checked_files} flow export(s) checked, "
          f"no silent-drop mismatches"
          + (" (strict: no unwired outputs either)" if args.strict else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
