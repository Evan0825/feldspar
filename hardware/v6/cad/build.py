# SPDX-FileCopyrightText: 2026 Feldspar project contributors
# SPDX-License-Identifier: CERN-OHL-P-2.0
"""Build and validate the two printable parts of the Moonstone V6 enclosure."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import trimesh
from geometry import (
    SHELL_LENGTH_MM,
    SHELL_WIDTH_MM,
    SURFACE_SEGMENTS,
    as_mesh,
    as_solid,
    clean_stl_roundoff,
    crown_envelopes,
    frame_transform,
    pebble_boundary_points,
    surface_frame,
)
from manifold3d import CrossSection, Manifold

BASE_HEIGHT_MM = 22.0
FOOT_HEIGHT_MM = 3.5
BUTTON_FRAME = (36, 249)
MICROPHONE_FRAME = (6, 128)
FEET = ((-43, -29), (43, -29), (-43, 29), (43, 29))
TIE_POINTS = ((-30, -51), (30, -51), (-30, 51), (30, 51), (-67, 0), (67, 0))
UPPER_REFERENCE = Path(__file__).with_name("inputs") / "upper-reference.stl.gz"
UPPER_NAME = "moonstone_v6_upper.stl"
BASE_NAME = "moonstone_v6_base.stl"


@dataclass(frozen=True)
class Clip:
    x: float
    y: float
    side: int


def box(size, center) -> Manifold:
    return Manifold.cube(size, center=True).translate(center)


def cylinder(radius: float, z: float, height: float, xy=(0.0, 0.0)) -> Manifold:
    return Manifold.cylinder(height, radius, circular_segments=96).translate([*xy, z])


def clip_tooth(clip: Clip) -> Manifold:
    """Form the ramp faces that deflect a clip during opening and closing."""
    x, y, side = clip.x, clip.y, clip.side
    vertices = [(x - side, 1.2), (x + side * 1.25, 2.2), (x - side, 3.2)]
    profile = CrossSection([vertices if side > 0 else vertices[::-1]])
    return profile.extrude(5).transform(
        [[1, 0, 0, 0], [0, 0, 1, y + 2.5], [0, 1, 0, BASE_HEIGHT_MM]]
    )


def build_enclosure() -> tuple[Manifold, Manifold, list[Clip], Manifold, Manifold]:
    with gzip.open(UPPER_REFERENCE, "rb") as source:
        reference = as_solid(trimesh.load_mesh(source, file_type="stl"))
    outside, inside = crown_envelopes()

    frame = surface_frame(*BUTTON_FRAME)
    clearance = Manifold()
    for offset in (-7.5, 7.5):
        center = (
            frame.center - frame.normal * 4.3 + frame.across * offset + frame.down * 9.2
        )
        clearance += Manifold.cylinder(
            18, 8, circular_segments=96, center=True
        ).transform(frame_transform(frame, center))
    upper = reference - (inside.translate([0, 0, 0.03]) ^ clearance)
    upper += (outside - inside) ^ box([110, 40, 44], [0, -60, 22])

    outer = CrossSection(
        [pebble_boundary_points(SURFACE_SEGMENTS, SHELL_LENGTH_MM, SHELL_WIDTH_MM)]
    )
    rim = inside.slice(4).offset(-0.35).simplify(0.005)
    rim_inner = rim.offset(-1.4).simplify(0.005)
    base = outer.extrude(BASE_HEIGHT_MM) - outer.offset(-2.8).extrude(
        BASE_HEIGHT_MM
    ).translate([0, 0, 3])
    base += (outer - rim_inner).extrude(2).translate([0, 0, BASE_HEIGHT_MM - 2])
    lip = (rim - rim_inner).extrude(4).translate([0, 0, BASE_HEIGHT_MM])

    rim_points = rim.to_polygons()[0]
    clips = []
    for side in (-1, 1):
        x, y = rim_points[np.argmax(side * rim_points[:, 0])]
        clip = Clip(float(x), float(y), side)
        # Free one end of the 20 mm spring, keeping the other end attached to the rim.
        lip -= box([8, 20, 1.2], [x, y, BASE_HEIGHT_MM + 0.6])
        lip -= box([8, 1.0, 4.4], [x, y + 10, BASE_HEIGHT_MM + 2])
        lip += clip_tooth(clip)
        upper -= box([3.0, 5.8, 1.3], [x + side * 0.05, y + 5, 2.25])
        clips.append(clip)

    # Finger access in the upper shell and a separate lower cable opening.
    upper -= box([22, 25, 6.05], [0, 69, 3])
    lip -= box([25, 25, 5], [0, 69, BASE_HEIGHT_MM + 2])
    base += lip

    # Bottom speaker seat, acoustic feet and cable tie tunnels.
    base += cylinder(10.9, 3, 4.8) - cylinder(7.9, 3, 5)
    base -= cylinder(6.4, -1, 5)
    base -= box([3, 10, 2], [0, 9, 7])
    for xy in FEET:
        base += cylinder(6, -FOOT_HEIGHT_MM, 3.6, xy)
    base -= box([44, 35, 10], [0, 66, 12])
    for x, y in TIE_POINTS:
        base += box([8, 6, 5], [x, y, 5.3]) - box([4.2, 8, 1.8], [x, y, 4.5])

    return upper, base, clips, inside ^ clearance, reference


def export_part(part: Manifold, path: Path, expected_size: tuple[float, float, float]):
    mesh = as_mesh(part)
    clean_stl_roundoff(mesh)
    if not mesh.is_watertight:
        mesh.merge_vertices(digits_vertex=3)
        mesh.update_faces(mesh.nondegenerate_faces(height=1e-9))
        mesh.update_faces(mesh.unique_faces())
        mesh.remove_unreferenced_vertices()

    mesh.export(path)
    exported = trimesh.load_mesh(path)
    if not (
        exported.is_watertight
        and exported.is_winding_consistent
        and exported.body_count == 1
    ):
        raise ValueError(
            f"{path.name}: expected one closed mesh with consistent winding"
        )
    if not np.allclose(exported.extents, expected_size, atol=0.001, rtol=0):
        raise ValueError(
            f"{path.name}: expected dimensions {expected_size}, got {exported.extents}"
        )
    if path.name == UPPER_NAME and exported.euler_number != -2:
        raise ValueError(f"{path.name}: unexpected number of through-holes")

    return as_solid(exported), {
        "size_mm": exported.extents.tolist(),
        "watertight": True,
        "bodies": 1,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def require_under(name: str, value: float, limit: float) -> None:
    if not 0 <= value < limit:
        raise ValueError(f"{name}: {value:.6g} exceeds the tolerance {limit:g}")


def validate_assembly(
    upper: Manifold,
    base: Manifold,
    clips: list[Clip],
    boss_zone: Manifold,
    reference: Manifold,
) -> dict[str, float]:
    """Check geometry after exporting and reopening the two print meshes."""
    measurements: dict[str, float] = {}

    def clearance(name: str, first: Manifold, second: Manifold) -> None:
        overlap = abs((first ^ second).volume())
        require_under(name, overlap, 0.03)
        measurements[name] = overlap

    closed_upper = upper.translate([0, 0, BASE_HEIGHT_MM])
    clearance("closed_collision_mm3", closed_upper, base)
    measurements["reference_button_boss_material_mm3"] = (
        reference ^ boss_zone
    ).volume()
    if measurements["reference_button_boss_material_mm3"] <= 200:
        raise ValueError("Unexpected button boss geometry in the reference mesh")
    clearance("remaining_button_boss_material_mm3", upper, boss_zone)

    clip_zone = Manifold()
    for clip in clips:
        clip_zone += box([8, 9, 9], [clip.x, clip.y + 5, BASE_HEIGHT_MM + 2.2])
    for lift in (0.1, 0.3, 0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 10, 30):
        overlap = upper.translate([0, 0, BASE_HEIGHT_MM + lift]) ^ base
        name = f"clip_interference_at_lift_{lift}_mm3"
        measurements[name] = abs(overlap.volume())
        require_under(
            f"unintended overlap at {lift:g} mm lift",
            abs((overlap - clip_zone).volume()),
            0.03,
        )

    lip_root = base.slice(BASE_HEIGHT_MM + 0.05)
    support = base.slice(BASE_HEIGHT_MM - 0.05)
    measurements["stationary_lip_root_area_mm2"] = lip_root.area()
    measurements["unsupported_root_area_mm2"] = (lip_root - support).area()
    require_under(
        "unsupported lip root area", measurements["unsupported_root_area_mm2"], 0.05
    )

    for name, position, radius, length, depth in (
        ("microphone", MICROPHONE_FRAME, 0.60, 8, 1.5),
        ("button", BUTTON_FRAME, 6.4, 12, 3),
    ):
        frame = surface_frame(*position)
        probe = Manifold.cylinder(
            length, radius, circular_segments=96, center=True
        ).transform(frame_transform(frame, frame.center - frame.normal * depth))
        clearance(f"{name}_passage_mm3", upper, probe)

    for index, (x, y) in enumerate(TIE_POINTS, start=1):
        clearance(f"tie_{index}_access_mm3", base, box([3.8, 10, 1.2], [x, y, 4.5]))

    for name, (x, y), size in (
        ("main", (-32, 0), (33, 68, 35)),
        ("rear_right", (30, 20), (36, 26, 22)),
        ("front_right", (30, -17), (36, 30, 22)),
        ("rear", (-1, 43), (24, 22, 22)),
    ):
        envelope = box(size, [x, y, 4.5 + size[2] / 2])
        clearance(f"{name}_base_mm3", envelope, base)
        clearance(f"{name}_upper_mm3", envelope, closed_upper)

    return measurements


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, required=True, help="Directory for generated files"
    )
    args = parser.parse_args()
    output = args.output
    stl_dir = output / "stl"
    stl_dir.mkdir(parents=True, exist_ok=True)

    upper, base, clips, boss_zone, reference = build_enclosure()
    upper, upper_report = export_part(
        upper, stl_dir / UPPER_NAME, (SHELL_LENGTH_MM, SHELL_WIDTH_MM, 73.0)
    )
    base, base_report = export_part(
        base.translate([0, 0, FOOT_HEIGHT_MM]),
        stl_dir / BASE_NAME,
        (SHELL_LENGTH_MM, SHELL_WIDTH_MM, 29.5),
    )
    measurements = validate_assembly(
        upper, base.translate([0, 0, -FOOT_HEIGHT_MM]), clips, boss_zone, reference
    )
    report = {
        "digital_checks": "PASS",
        "parts": {"upper": upper_report, "base": base_report},
        "measurements": measurements,
    }
    (output / "validation.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"V6 geometry checks passed. Generated meshes and report: {output.resolve()}")


if __name__ == "__main__":
    main()
