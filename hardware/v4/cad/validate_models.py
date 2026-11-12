#!/usr/bin/env python3
"""Validate generated binary STL dimensions and edge closure."""

from __future__ import annotations

import json
import struct
import sys
from collections import Counter
from pathlib import Path

import numpy as np


PART_ENVELOPE_LIMITS = {
    "snoozmate_refined_v4_final_haptic_lower.stl": (75.05, 55.05, 8.45),
    "snoozmate_refined_v4_final_haptic_lid.stl": (75.05, 55.05, 6.25),
}


def inspect_binary_stl(path: Path) -> dict[str, object]:
    raw = path.read_bytes()
    if len(raw) < 84:
        raise ValueError(f"{path}: binary STL header is incomplete")
    count = struct.unpack_from("<I", raw, 80)[0]
    expected = 84 + count * 50
    if len(raw) != expected:
        raise ValueError(f"{path}: expected {expected} bytes, got {len(raw)}")
    triangles = np.empty((count, 3, 3), dtype=np.float32)
    for i in range(count):
        values = struct.unpack_from("<12fH", raw, 84 + i * 50)
        triangles[i] = np.asarray(values[3:12], dtype=np.float32).reshape(3, 3)
    finite = np.isfinite(triangles)
    invalid = int(triangles.size - finite.sum())
    mins = triangles.min(axis=(0, 1))
    maxs = triangles.max(axis=(0, 1))
    sizes = maxs - mins
    edge_counts: Counter[tuple[tuple[float, ...], tuple[float, ...]]] = Counter()
    for tri in triangles:
        pts = [tuple(float(round(v, 4)) for v in p) for p in tri]
        for a, b in ((pts[0], pts[1]), (pts[1], pts[2]), (pts[2], pts[0])):
            edge_counts[tuple(sorted((a, b)))] += 1
    unmatched = sum(1 for n in edge_counts.values() if n != 2)
    return {
        "file": path.name,
        "triangles": int(count),
        "min_mm": [round(float(v), 3) for v in mins],
        "max_mm": [round(float(v), 3) for v in maxs],
        "size_mm": [round(float(v), 3) for v in sizes],
        "invalid_coordinates": invalid,
        "nonmanifold_or_open_edges": unmatched,
        "bytes": len(raw),
    }


def main() -> None:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("outputs/20260901-snoozmate-moonstone-cad/stl")
    expected_count = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    files = sorted(root.glob("*.stl"))
    if len(files) != expected_count:
        raise SystemExit(f"expected {expected_count} STL files, found {len(files)}")
    report = [inspect_binary_stl(path) for path in files]
    failures: list[str] = []
    for item in report:
        if item["invalid_coordinates"] != 0:
            failures.append(f"{item['file']}: invalid coordinates")
        if item["nonmanifold_or_open_edges"] != 0:
            failures.append(f"{item['file']}: open/nonmanifold edges={item['nonmanifold_or_open_edges']}")
        limits = PART_ENVELOPE_LIMITS.get(item["file"], (170.5, 140.5, 90.5))
        if any(size > limit for size, limit in zip(item["size_mm"], limits)):
            failures.append(f"{item['file']}: exceeds part envelope {limits}")
    report_name = "validation-report.json"
    if root.name != "stl":
        report_name = f"validation-report-{root.name.removeprefix('stl-')}.json"
    out = root.parent / report_name
    out.write_text(json.dumps({"models": report, "failures": failures}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"models": report, "failures": failures}, ensure_ascii=False, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
