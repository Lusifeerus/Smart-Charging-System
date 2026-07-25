#!/usr/bin/env python3
"""check_resolver_sync.py — mapping-resolver divergence guard

The car↔charger mapping resolver is deliberately duplicated (byte-identical)
across five Node-RED function scripts, with semantic twins in pyscript and
the Lovelace card. Runtime centralization was evaluated and rejected (it
would make the fast flow's mapping depend on pyscript liveness); this
script is the maintenance-time control instead: it fails loudly the moment
any copy diverges.

Usage:
    ./check_resolver_sync.py [--root <repo-root>] [--flow <export.json> ...]

  --flow  also extracts function-node code from Node-RED flow exports and
          checks any resolver blocks found there against the repo copies —
          catches repo-vs-production drift (the exact drift found during
          the Phase 1 archaeology).

Exit 0 = all in sync. Exit 1 = divergence / missing block / version skew.
"""

import argparse
import json
import re
import sys
from pathlib import Path

BEGIN_RE = re.compile(r"═══ MAPPING RESOLVER v(\d+) ")
END_RE = re.compile(r"═══ END MAPPING RESOLVER v(\d+) ")

# Files that must carry the byte-identical block (paths relative to root)
BLOCK_FILES = [
    "NodeRed/Scripts/coordinator.js",
    "NodeRed/Scripts/evaluator.js",
    "NodeRed/Scripts/planner_car1.js",
    "NodeRed/Scripts/planner_car2.js",
    "NodeRed/Scripts/ev_status_publisher.js",
    "NodeRed/Scripts/fast_csv_logger.js",
]

# Semantic twins: can't be byte-identical (other languages) — must carry a
# version marker matching the block version.
TWIN_FILES = [
    ("HomeAssistant/pyscript/ev_strategy.py", re.compile(r"MAPPING RESOLVER TWIN v(\d+)")),
    ("HomeAssistant/www/ev-charging-cards.js", re.compile(r"MAPPING RESOLVER TWIN v(\d+)")),
    # PV Eco tracker: reads assigned-car strategy per-charger (two-go-e
    # readiness). H-bulk-read variant of the same resolver rules.
    ("NodeRed/Scripts/fast_tracker.js", re.compile(r"MAPPING RESOLVER TWIN v(\d+)")),
]


def extract_block(text, label):
    """Return (version, block_text) or (None, reason)."""
    b = BEGIN_RE.search(text)
    e = END_RE.search(text)
    if not b or not e:
        return None, f"{label}: no resolver block markers found"
    if b.group(1) != e.group(1):
        return None, f"{label}: BEGIN v{b.group(1)} but END v{e.group(1)}"
    start = text.rfind("\n", 0, b.start()) + 1   # from start of BEGIN line
    end = text.find("\n", e.end())               # to end of END line
    end = len(text) if end == -1 else end
    return b.group(1), text[start:end].rstrip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="repo root")
    ap.add_argument("--flow", action="append", default=[],
                    help="Node-RED flow export JSON to cross-check")
    args = ap.parse_args()
    root = Path(args.root)

    errors = []
    blocks = {}      # label → (version, block)

    # ── 1. Extract from repo files ──
    for rel in BLOCK_FILES:
        p = root / rel
        if not p.exists():
            errors.append(f"MISSING FILE: {rel}")
            continue
        ver, block = extract_block(p.read_text(encoding="utf-8"), rel)
        if ver is None:
            errors.append(block)
        else:
            blocks[rel] = (ver, block)

    # ── 2. Compare byte-identical ──
    if blocks:
        ref_label, (ref_ver, ref_block) = next(iter(blocks.items()))
        for label, (ver, block) in blocks.items():
            if ver != ref_ver:
                errors.append(f"VERSION SKEW: {label} v{ver} vs {ref_label} v{ref_ver}")
            elif block != ref_block:
                # show first differing line for a usable error message
                for i, (a, b) in enumerate(zip(ref_block.splitlines(),
                                               block.splitlines())):
                    if a != b:
                        errors.append(
                            f"DIVERGED: {label} differs from {ref_label} "
                            f"at block line {i + 1}:\n  ref: {a}\n  got: {b}")
                        break
                else:
                    errors.append(
                        f"DIVERGED: {label} block length differs from {ref_label}")

    # ── 3. Twin version markers ──
    ref_ver = next(iter(blocks.values()))[0] if blocks else None
    for rel, marker_re in TWIN_FILES:
        p = root / rel
        if not p.exists():
            errors.append(f"MISSING TWIN FILE: {rel}")
            continue
        m = marker_re.search(p.read_text(encoding="utf-8"))
        if not m:
            errors.append(f"{rel}: no 'MAPPING RESOLVER TWIN vN' marker")
        elif ref_ver and m.group(1) != ref_ver:
            errors.append(f"TWIN VERSION SKEW: {rel} v{m.group(1)} vs blocks v{ref_ver}")

    # ── 4. Optional: flow exports (repo-vs-production drift) ──
    for flow_path in args.flow:
        fp = Path(flow_path)
        if not fp.exists():
            errors.append(f"MISSING FLOW EXPORT: {flow_path}")
            continue
        try:
            nodes = json.loads(fp.read_text(encoding="utf-8"))
        except json.JSONDecodeError as ex:
            errors.append(f"{flow_path}: not valid JSON ({ex})")
            continue
        found = 0
        for n in nodes:
            if n.get("type") != "function":
                continue
            func = n.get("func", "")
            if not BEGIN_RE.search(func):
                continue
            found += 1
            label = f"{fp.name}::{n.get('name', n.get('id'))}"
            ver, block = extract_block(func, label)
            if ver is None:
                errors.append(block)
                continue
            if blocks:
                ref_label, (ref_ver2, ref_block2) = next(iter(blocks.items()))
                if ver != ref_ver2:
                    errors.append(f"FLOW VERSION SKEW: {label} v{ver} vs repo v{ref_ver2}")
                elif block != ref_block2:
                    errors.append(f"PRODUCTION DRIFT: {label} resolver differs from repo")
        if found == 0:
            print(f"note: {fp.name}: no resolver blocks found "
                  f"(fine for e.g. PV_Eco.json)")

    # ── Report ──
    if errors:
        print(f"\n✗ RESOLVER SYNC CHECK FAILED ({len(errors)} problem(s)):\n")
        for e in errors:
            print(f"  • {e}")
        return 1

    n_flow = len(args.flow)
    print(f"✓ resolver in sync: {len(blocks)} byte-identical copies (v{ref_ver}), "
          f"{len(TWIN_FILES)} twins marked"
          + (f", {n_flow} flow export(s) checked" if n_flow else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
