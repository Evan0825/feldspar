#!/usr/bin/env python3
"""Generate parametric SnoozMate Moonstone prototype STL files.

The generator intentionally uses only Python's standard library and NumPy so
the model can be rebuilt on the user's machine without a CAD installation.
Dimensions are millimetres.
"""

from __future__ import annotations

import argparse
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


OUTER_LENGTH = 170.0
OUTER_WIDTH = 140.0
OUTER_HEIGHT = 90.0
BASE_HEIGHT = 28.0
UPPER_HEIGHT = OUTER_HEIGHT - BASE_HEIGHT
UPPER_WALL = 2.4
BASE_WALL = 2.8
BASE_FLOOR = 3.0
BOARD_ENVELOPE = (66.0, 32.0, 18.0)
FINAL_BOARD_ENVELOPE = (68.0, 33.0, 20.0)
TRAY_SIZE = (120.0, 90.0, 3.0)
OUTPUT_ROOT = Path("outputs/20260901-snoozmate-moonstone-cad")


@dataclass
class Mesh:
    vertices: list[tuple[float, float, float]] = field(default_factory=list)
    faces: list[tuple[int, int, int]] = field(default_factory=list)

    def vertex(self, xyz: tuple[float, float, float]) -> int:
        self.vertices.append(tuple(float(v) for v in xyz))
        return len(self.vertices) - 1

    def triangle(self, a: int, b: int, c: int) -> None:
        self.faces.append((a, b, c))

    def quad(self, a: int, b: int, c: int, d: int) -> None:
        self.triangle(a, b, c)
        self.triangle(a, c, d)

    def merge(self, other: "Mesh") -> None:
        offset = len(self.vertices)
        self.vertices.extend(other.vertices)
        self.faces.extend((a + offset, b + offset, c + offset) for a, b, c in other.faces)


def _normal(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    n = np.cross(b - a, c - a)
    length = float(np.linalg.norm(n))
    return n / length if length > 1e-12 else np.zeros(3, dtype=float)


def write_binary_stl(path: Path, mesh: Mesh) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    verts = np.asarray(mesh.vertices, dtype=np.float32)
    with path.open("wb") as handle:
        title = b"SnoozMate Moonstone parametric prototype"
        handle.write(title.ljust(80, b"\0"))
        handle.write(struct.pack("<I", len(mesh.faces)))
        for ia, ib, ic in mesh.faces:
            a, b, c = verts[ia], verts[ib], verts[ic]
            n = _normal(a, b, c).astype(np.float32)
            handle.write(struct.pack("<12fH", *(n.tolist() + a.tolist() + b.tolist() + c.tolist()), 0))


def _ellipse_point(a: float, b: float, theta: float, z: float) -> tuple[float, float, float]:
    return (a * math.cos(theta), b * math.sin(theta), z)


def moonstone_upper(*, refined: bool, segments: int, rings: int) -> Mesh:
    """Closed hollow upper shell with an open interior and solid lower rim."""
    mesh = Mesh()
    a, b = OUTER_LENGTH / 2, OUTER_WIDTH / 2
    ai, bi = a - UPPER_WALL, b - UPPER_WALL

    def point(r: float, theta: float, inner: bool) -> tuple[float, float, float]:
        radius_a = ai if inner else a
        radius_b = bi if inner else b
        height = UPPER_HEIGHT - (UPPER_WALL if inner else 0.0)
        # The refined surface has a subtle rearward crown and organic asymmetry.
        crown = (1.0 - r**2.15) ** (0.62 if refined else 0.70)
        asym = 1.0 + (0.055 if refined else 0.018) * r * math.sin(theta)
        shift_x = (-3.0 if refined else -1.0) * (1.0 - r) ** 1.7
        shift_y = (5.0 if refined else 1.5) * (1.0 - r) ** 1.5
        return (
            radius_a * r * math.cos(theta) + shift_x,
            radius_b * r * math.sin(theta) + shift_y,
            height * crown * asym,
        )

    def add_surface(inner: bool) -> tuple[list[list[int]], int]:
        ids: list[list[int]] = []
        for ring in range(rings):
            r = 1.0 - ring / rings
            ids.append([
                mesh.vertex(point(r, 2 * math.pi * j / segments, inner))
                for j in range(segments)
            ])
        center = mesh.vertex(point(0.0, 0.0, inner))
        for i in range(rings - 1):
            for j in range(segments):
                nj = (j + 1) % segments
                if inner:
                    mesh.quad(ids[i][j], ids[i + 1][j], ids[i + 1][nj], ids[i][nj])
                else:
                    mesh.quad(ids[i][j], ids[i][nj], ids[i + 1][nj], ids[i + 1][j])
        for j in range(segments):
            nj = (j + 1) % segments
            if inner:
                mesh.triangle(ids[-1][j], center, ids[-1][nj])
            else:
                mesh.triangle(ids[-1][j], ids[-1][nj], center)
        return ids, center

    outer, _ = add_surface(inner=False)
    inner, _ = add_surface(inner=True)
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(outer[0][j], inner[0][j], inner[0][nj], outer[0][nj])

    # Three printable pilot rings show where to drill the 1.2 mm mic ports.
    for x in (-5.0, 0.0, 5.0):
        marker = cylinder(radius=0.8, height=0.35, segments=18, z0=UPPER_HEIGHT - 0.2)
        marker.vertices = [(vx + x - 2.5, vy + 4.5, vz) for vx, vy, vz in marker.vertices]
        mesh.merge(marker)
    return mesh


def pebble_boundary_points(segments: int, length: float, width: float) -> np.ndarray:
    """Return an irregular, normalized pebble footprint centered on the origin."""
    theta = np.linspace(0.0, 2.0 * math.pi, segments, endpoint=False)
    radial = 1.0 + 0.085 * np.cos(theta - 0.35) + 0.045 * np.cos(2.0 * theta + 1.05) + 0.018 * np.sin(3.0 * theta)
    x = radial * np.cos(theta) * (1.0 + 0.035 * np.sin(theta))
    y = radial * np.sin(theta) * (1.0 - 0.055 * np.cos(theta))
    x = (x - (x.max() + x.min()) / 2.0) * (length / (x.max() - x.min()))
    y = (y - (y.max() + y.min()) / 2.0) * (width / (y.max() - y.min()))
    return np.column_stack((x, y))


def moonstone_upper_v2(*, segments: int = 256, rings: int = 52) -> Mesh:
    """Asymmetric front-low/rear-high shell matching the approved moonstone form."""
    mesh = Mesh()
    height = 68.0
    peak = np.array([-9.0, 18.5])
    outer_boundary = pebble_boundary_points(segments, 170.0, 140.0)
    inner_boundary = pebble_boundary_points(segments, 170.0 - 2 * UPPER_WALL, 140.0 - 2 * UPPER_WALL)

    def add_surface(inner: bool) -> list[list[int]]:
        boundary = inner_boundary if inner else outer_boundary
        local_height = height - (UPPER_WALL if inner else 0.0)
        ids: list[list[int]] = []
        for ring in range(rings):
            r = 1.0 - ring / rings
            current: list[int] = []
            for j in range(segments):
                theta = 2.0 * math.pi * j / segments
                xy = boundary[j] * r + peak * (1.0 - r) ** 1.35
                crown = (1.0 - r**2.0) ** 0.62
                front_rear = 1.0 + 0.16 * r * math.sin(theta)
                z = min(local_height, local_height * crown * front_rear)
                current.append(mesh.vertex((xy[0], xy[1], z)))
            ids.append(current)
        center = mesh.vertex((peak[0], peak[1], local_height))
        for i in range(rings - 1):
            for j in range(segments):
                nj = (j + 1) % segments
                if inner:
                    mesh.quad(ids[i][j], ids[i + 1][j], ids[i + 1][nj], ids[i][nj])
                else:
                    mesh.quad(ids[i][j], ids[i][nj], ids[i + 1][nj], ids[i + 1][j])
        for j in range(segments):
            nj = (j + 1) % segments
            if inner:
                mesh.triangle(ids[-1][j], center, ids[-1][nj])
            else:
                mesh.triangle(ids[-1][j], ids[-1][nj], center)
        return ids

    outer = add_surface(inner=False)
    inner = add_surface(inner=True)
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(outer[0][j], inner[0][j], inner[0][nj], outer[0][nj])
    return mesh


def moonstone_upper_v3(
    *,
    segments: int = 256,
    rings: int = 56,
    outer_length: float = 170.0,
    outer_width: float = 140.0,
) -> Mesh:
    """Taller moonstone shell for the thin, inset V3 lower chassis."""
    mesh = Mesh()
    height = 73.0
    peak = np.array([-8.0, 18.0])
    outer_boundary = pebble_boundary_points(segments, outer_length, outer_width)
    inner_boundary = pebble_boundary_points(segments, outer_length - 2 * UPPER_WALL, outer_width - 2 * UPPER_WALL)

    def add_surface(inner: bool) -> list[list[int]]:
        boundary = inner_boundary if inner else outer_boundary
        local_height = height - (UPPER_WALL if inner else 0.0)
        ids: list[list[int]] = []
        for ring in range(rings):
            r = 1.0 - ring / rings
            current: list[int] = []
            for j in range(segments):
                theta = 2.0 * math.pi * j / segments
                xy = boundary[j] * r + peak * (1.0 - r) ** 1.35
                crown = (1.0 - r**2.0) ** 0.62
                front_rear = 1.0 + 0.16 * r * math.sin(theta)
                z = min(local_height, local_height * crown * front_rear)
                current.append(mesh.vertex((xy[0], xy[1], z)))
            ids.append(current)
        center = mesh.vertex((peak[0], peak[1], local_height))
        for i in range(rings - 1):
            for j in range(segments):
                nj = (j + 1) % segments
                if inner:
                    mesh.quad(ids[i][j], ids[i + 1][j], ids[i + 1][nj], ids[i][nj])
                else:
                    mesh.quad(ids[i][j], ids[i][nj], ids[i + 1][nj], ids[i + 1][j])
        for j in range(segments):
            nj = (j + 1) % segments
            if inner:
                mesh.triangle(ids[-1][j], center, ids[-1][nj])
            else:
                mesh.triangle(ids[-1][j], ids[-1][nj], center)
        return ids

    outer = add_surface(inner=False)
    inner = add_surface(inner=True)
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(outer[0][j], inner[0][j], inner[0][nj], outer[0][nj])
    return mesh


def _disc_annulus(mesh: Mesh, outer: list[int], inner: list[int], reverse: bool = False) -> None:
    n = len(outer)
    for j in range(n):
        nj = (j + 1) % n
        if reverse:
            mesh.quad(outer[j], inner[j], inner[nj], outer[nj])
        else:
            mesh.quad(outer[j], outer[nj], inner[nj], inner[j])


def lower_base(*, refined: bool, segments: int) -> Mesh:
    """Hollow lower chassis with bottom speaker opening and rear service port."""
    mesh = Mesh()
    a, b = OUTER_LENGTH / 2, OUTER_WIDTH / 2
    ai, bi = a - BASE_WALL, b - BASE_WALL
    speaker_r = 19.0
    z_levels_outer = [0.0, BASE_FLOOR, 7.0, 21.0, BASE_HEIGHT]
    z_levels_inner = [BASE_FLOOR, 7.0, 21.0, BASE_HEIGHT]

    def ring(ra: float, rb: float, z: float) -> list[int]:
        return [mesh.vertex(_ellipse_point(ra, rb, 2 * math.pi * j / segments, z)) for j in range(segments)]

    outer = [ring(a - (2.0 if z == 0 else 0.0), b - (2.0 if z == 0 else 0.0), z) for z in z_levels_outer]
    inner = [ring(ai, bi, z) for z in z_levels_inner]
    speaker_bottom = [mesh.vertex((speaker_r * math.cos(2 * math.pi * j / segments), speaker_r * math.sin(2 * math.pi * j / segments), 0.0)) for j in range(segments)]
    speaker_top = [mesh.vertex((speaker_r * math.cos(2 * math.pi * j / segments), speaker_r * math.sin(2 * math.pi * j / segments), BASE_FLOOR)) for j in range(segments)]

    rear_center = math.pi / 2
    opening_width_angle = 0.66 if refined else 0.78

    def in_opening(j: int) -> bool:
        theta = 2 * math.pi * (j + 0.5) / segments
        delta = (theta - rear_center + math.pi) % (2 * math.pi) - math.pi
        return abs(delta) < opening_width_angle / 2

    # Outer side; only the 7–21 mm rear band is opened.
    for band in range(len(outer) - 1):
        for j in range(segments):
            if band == 2 and in_opening(j):
                continue
            nj = (j + 1) % segments
            mesh.quad(outer[band][j], outer[band][nj], outer[band + 1][nj], outer[band + 1][j])

    # Inner wall with the matching service opening.
    for band in range(len(inner) - 1):
        for j in range(segments):
            if band == 1 and in_opening(j):
                continue
            nj = (j + 1) % segments
            mesh.quad(inner[band][j], inner[band + 1][j], inner[band + 1][nj], inner[band][nj])

    # Close lower and upper faces of the rear service opening through wall thickness.
    for j in range(segments):
        if not in_opening(j):
            continue
        nj = (j + 1) % segments
        mesh.quad(outer[2][j], inner[1][j], inner[1][nj], outer[2][nj])
        mesh.quad(outer[3][j], outer[3][nj], inner[2][nj], inner[2][j])

    skipped = [j for j in range(segments) if in_opening(j)]
    start = skipped[0]
    end = (skipped[-1] + 1) % segments
    mesh.quad(outer[2][start], outer[3][start], inner[2][start], inner[1][start])
    mesh.quad(outer[2][end], inner[1][end], inner[2][end], outer[3][end])

    # Top rim, floor annulus and hidden bottom speaker aperture.
    _disc_annulus(mesh, outer[-1], inner[-1])
    _disc_annulus(mesh, inner[0], speaker_top, reverse=True)
    _disc_annulus(mesh, outer[0], speaker_bottom, reverse=True)
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(speaker_bottom[j], speaker_top[j], speaker_top[nj], speaker_bottom[nj])

    # Four M2.5 heat-insert bosses and a 40 mm speaker cradle.
    for x, y in ((-62, -45), (62, -45), (-62, 45), (62, 45)):
        boss = hollow_cylinder(outer_radius=4.8, inner_radius=2.1, height=15.0, segments=28, z0=BASE_FLOOR)
        boss.vertices = [(vx + x, vy + y, vz) for vx, vy, vz in boss.vertices]
        mesh.merge(boss)
    mesh.merge(hollow_cylinder(outer_radius=24.0, inner_radius=21.3, height=5.0, segments=72, z0=BASE_FLOOR))
    return mesh


def lower_base_v2(*, segments: int = 256) -> Mesh:
    """Low pebble chassis with hidden rear insert and inward screw bosses."""
    mesh = Mesh()
    height = 22.0
    floor = 3.0
    wall = 2.8
    speaker_r = 19.0
    z_outer = [0.0, floor, 5.0, 15.0, height]
    z_inner = [floor, 5.0, 15.0, height]

    outer_shapes = [
        pebble_boundary_points(segments, 161.0, 131.0),
        pebble_boundary_points(segments, 167.0, 137.0),
        pebble_boundary_points(segments, 167.0, 137.0),
        pebble_boundary_points(segments, 167.0, 137.0),
        pebble_boundary_points(segments, 167.0, 137.0),
    ]
    inner_shape = pebble_boundary_points(segments, 167.0 - 2 * wall, 137.0 - 2 * wall)

    def ring(points: np.ndarray, z: float) -> list[int]:
        return [mesh.vertex((p[0], p[1], z)) for p in points]

    outer = [ring(points, z) for points, z in zip(outer_shapes, z_outer)]
    inner = [ring(inner_shape, z) for z in z_inner]
    speaker_bottom = [mesh.vertex((speaker_r * math.cos(2 * math.pi * j / segments), speaker_r * math.sin(2 * math.pi * j / segments), 0.0)) for j in range(segments)]
    speaker_top = [mesh.vertex((speaker_r * math.cos(2 * math.pi * j / segments), speaker_r * math.sin(2 * math.pi * j / segments), floor)) for j in range(segments)]

    rear_center = math.pi / 2.0
    opening_width_angle = 0.74

    def in_opening(j: int) -> bool:
        theta = 2.0 * math.pi * (j + 0.5) / segments
        delta = (theta - rear_center + math.pi) % (2.0 * math.pi) - math.pi
        return abs(delta) < opening_width_angle / 2.0

    for band in range(len(outer) - 1):
        for j in range(segments):
            if band == 2 and in_opening(j):
                continue
            nj = (j + 1) % segments
            mesh.quad(outer[band][j], outer[band][nj], outer[band + 1][nj], outer[band + 1][j])
    for band in range(len(inner) - 1):
        for j in range(segments):
            if band == 1 and in_opening(j):
                continue
            nj = (j + 1) % segments
            mesh.quad(inner[band][j], inner[band + 1][j], inner[band + 1][nj], inner[band][nj])

    for j in range(segments):
        if not in_opening(j):
            continue
        nj = (j + 1) % segments
        mesh.quad(outer[2][j], inner[1][j], inner[1][nj], outer[2][nj])
        mesh.quad(outer[3][j], outer[3][nj], inner[2][nj], inner[2][j])
    skipped = [j for j in range(segments) if in_opening(j)]
    start = skipped[0]
    end = (skipped[-1] + 1) % segments
    mesh.quad(outer[2][start], outer[3][start], inner[2][start], inner[1][start])
    mesh.quad(outer[2][end], inner[1][end], inner[2][end], outer[3][end])

    _disc_annulus(mesh, outer[-1], inner[-1])
    _disc_annulus(mesh, inner[0], speaker_top, reverse=True)
    _disc_annulus(mesh, outer[0], speaker_bottom, reverse=True)
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(speaker_bottom[j], speaker_top[j], speaker_top[nj], speaker_bottom[nj])

    for x, y in ((-48, -32), (48, -32), (-48, 32), (48, 32)):
        boss = hollow_cylinder(outer_radius=4.8, inner_radius=2.1, height=13.0, segments=32, z0=floor)
        boss.vertices = [(vx + x, vy + y, vz) for vx, vy, vz in boss.vertices]
        mesh.merge(boss)
    mesh.merge(hollow_cylinder(outer_radius=24.0, inner_radius=21.3, height=5.0, segments=96, z0=floor))
    return mesh


def lower_base_v3(
    *,
    segments: int = 256,
    speaker_aperture_radius: float = 19.0,
    speaker_pocket_radius: float = 21.3,
    speaker_cradle_outer_radius: float = 24.0,
    speaker_cradle_height: float = 4.5,
    speaker_wire_notch: bool = False,
    acoustic_feet: bool = False,
    mating_lip: bool = False,
    power_line_clip: bool = False,
) -> Mesh:
    """Thin convex pebble base with a recessed footprint and hidden light gap."""
    mesh = Mesh()
    height = 17.0
    floor = 3.0
    wall = 2.8
    speaker_r = speaker_aperture_radius
    z_outer = [float(z) for z in range(18)]

    def eased_extent(bottom: float, top: float, z: float) -> float:
        progress = math.sin((z / height) * math.pi / 2.0) ** 0.8
        return bottom + (top - bottom) * progress

    top_length = 170.0 if mating_lip else 167.0
    top_width = 140.0 if mating_lip else 137.0
    lengths = [eased_extent(151.0, top_length, z) for z in z_outer]
    widths = [eased_extent(121.0, top_width, z) for z in z_outer]
    outer_shapes = [pebble_boundary_points(segments, length, width) for length, width in zip(lengths, widths)]
    inner_shapes = [
        pebble_boundary_points(segments, length - 2 * wall, width - 2 * wall)
        for length, width in zip(lengths[3:], widths[3:])
    ]

    def ring(points: np.ndarray, z: float) -> list[int]:
        return [mesh.vertex((p[0], p[1], z)) for p in points]

    outer = [ring(points, z) for points, z in zip(outer_shapes, z_outer)]
    inner = [ring(points, z) for points, z in zip(inner_shapes, z_outer[3:])]
    speaker_bottom = [mesh.vertex((speaker_r * math.cos(2 * math.pi * j / segments), speaker_r * math.sin(2 * math.pi * j / segments), 0.0)) for j in range(segments)]
    speaker_top = [mesh.vertex((speaker_r * math.cos(2 * math.pi * j / segments), speaker_r * math.sin(2 * math.pi * j / segments), floor)) for j in range(segments)]

    rear_center = math.pi / 2.0
    opening_width_angle = 0.64

    def in_opening(j: int) -> bool:
        theta = 2.0 * math.pi * (j + 0.5) / segments
        delta = (theta - rear_center + math.pi) % (2.0 * math.pi) - math.pi
        return abs(delta) < opening_width_angle / 2.0

    for band in range(len(outer) - 1):
        for j in range(segments):
            if 6 <= band < 14 and in_opening(j):
                continue
            nj = (j + 1) % segments
            mesh.quad(outer[band][j], outer[band][nj], outer[band + 1][nj], outer[band + 1][j])
    for band in range(len(inner) - 1):
        for j in range(segments):
            absolute_band = band + 3
            if 6 <= absolute_band < 14 and in_opening(j):
                continue
            nj = (j + 1) % segments
            mesh.quad(inner[band][j], inner[band + 1][j], inner[band + 1][nj], inner[band][nj])

    for j in range(segments):
        if not in_opening(j):
            continue
        nj = (j + 1) % segments
        mesh.quad(outer[6][j], inner[3][j], inner[3][nj], outer[6][nj])
        mesh.quad(outer[14][j], outer[14][nj], inner[11][nj], inner[11][j])
    skipped = [j for j in range(segments) if in_opening(j)]
    start = skipped[0]
    end = (skipped[-1] + 1) % segments
    for band in range(6, 14):
        inner_band = band - 3
        mesh.quad(
            outer[band][start],
            outer[band + 1][start],
            inner[inner_band + 1][start],
            inner[inner_band][start],
        )
        mesh.quad(
            outer[band][end],
            inner[inner_band][end],
            inner[inner_band + 1][end],
            outer[band + 1][end],
        )

    _disc_annulus(mesh, outer[-1], inner[-1])
    _disc_annulus(mesh, inner[0], speaker_top, reverse=True)
    _disc_annulus(mesh, outer[0], speaker_bottom, reverse=True)
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(speaker_bottom[j], speaker_top[j], speaker_top[nj], speaker_bottom[nj])

    for x, y in ((-48, -32), (48, -32), (-48, 32), (48, 32)):
        boss = hollow_cylinder(outer_radius=4.8, inner_radius=2.1, height=10.5, segments=32, z0=floor)
        boss.vertices = [(vx + x, vy + y, vz) for vx, vy, vz in boss.vertices]
        mesh.merge(boss)
    if speaker_wire_notch:
        mesh.merge(
            notched_hollow_cylinder(
                outer_radius=speaker_cradle_outer_radius,
                inner_radius=speaker_pocket_radius,
                height=speaker_cradle_height,
                notch_width=3.0,
                notch_height=2.0,
                segments=96,
                z0=floor,
            )
        )
    else:
        mesh.merge(
            hollow_cylinder(
                outer_radius=speaker_cradle_outer_radius,
                inner_radius=speaker_pocket_radius,
                height=speaker_cradle_height,
                segments=96,
                z0=floor,
            )
        )
    if acoustic_feet:
        for x, y in ((-48.0, -32.0), (48.0, -32.0), (-48.0, 32.0), (48.0, 32.0)):
            foot = tapered_cylinder(
                bottom_radius=5.0,
                top_radius=6.0,
                height=3.5,
                segments=48,
                z0=-3.5,
            )
            foot.vertices = [(vx + x, vy + y, vz) for vx, vy, vz in foot.vertices]
            mesh.merge(foot)
    if mating_lip:
        mesh.merge(pebble_hollow_ring(163.8, 133.8, 161.0, 131.0, 1.2, segments, z0=17.0))
    if power_line_clip:
        mesh.merge(box((2.8, 10.0, 6.2), (-10.4, 58.0, 6.1)))
        mesh.merge(box((2.8, 10.0, 6.2), (10.4, 58.0, 6.1)))
        mesh.merge(box((24.0, 10.0, 2.2), (0.0, 58.0, 8.1)))
    return mesh


def pebble_light_diffuser_v2(*, segments: int = 256) -> Mesh:
    mesh = Mesh()
    outer = pebble_boundary_points(segments, 163.0, 133.0)
    inner = pebble_boundary_points(segments, 155.0, 125.0)
    height = 1.4
    ob = [mesh.vertex((p[0], p[1], 0.0)) for p in outer]
    ot = [mesh.vertex((p[0], p[1], height)) for p in outer]
    ib = [mesh.vertex((p[0], p[1], 0.0)) for p in inner]
    it = [mesh.vertex((p[0], p[1], height)) for p in inner]
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(ob[j], ob[nj], ot[nj], ot[j])
        mesh.quad(ib[j], it[j], it[nj], ib[nj])
        mesh.quad(ot[j], ot[nj], it[nj], it[j])
        mesh.quad(ob[j], ib[j], ib[nj], ob[nj])
    return mesh


def pebble_light_diffuser_v3(*, segments: int = 256) -> Mesh:
    """Inset diffuser that is visible only as a soft underglow."""
    mesh = Mesh()
    outer = pebble_boundary_points(segments, 145.0, 115.0)
    inner = pebble_boundary_points(segments, 137.0, 107.0)
    height = 1.4
    ob = [mesh.vertex((p[0], p[1], 0.0)) for p in outer]
    ot = [mesh.vertex((p[0], p[1], height)) for p in outer]
    ib = [mesh.vertex((p[0], p[1], 0.0)) for p in inner]
    it = [mesh.vertex((p[0], p[1], height)) for p in inner]
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(ob[j], ob[nj], ot[nj], ot[j])
        mesh.quad(ib[j], it[j], it[nj], ib[nj])
        mesh.quad(ot[j], ot[nj], it[nj], it[j])
        mesh.quad(ob[j], ib[j], ib[nj], ob[nj])
    return mesh


def pebble_hollow_ring(
    outer_length: float,
    outer_width: float,
    inner_length: float,
    inner_width: float,
    height: float,
    segments: int,
    z0: float = 0.0,
) -> Mesh:
    """Closed low locating ring using the same pebble footprint as the enclosure."""
    mesh = Mesh()
    outer_bottom = pebble_boundary_points(segments, outer_length, outer_width)
    inner_bottom = pebble_boundary_points(segments, inner_length, inner_width)
    ob = [mesh.vertex((p[0], p[1], z0)) for p in outer_bottom]
    ot = [mesh.vertex((p[0], p[1], z0 + height)) for p in outer_bottom]
    ib = [mesh.vertex((p[0], p[1], z0)) for p in inner_bottom]
    it = [mesh.vertex((p[0], p[1], z0 + height)) for p in inner_bottom]
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(ob[j], ob[nj], ot[nj], ot[j])
        mesh.quad(ib[j], it[j], it[nj], ib[nj])
        mesh.quad(ot[j], ot[nj], it[nj], it[j])
        mesh.quad(ob[j], ib[j], ib[nj], ob[nj])
    return mesh


def rear_interface_insert_v2() -> Mesh:
    """Blank removable insert; drill connector-specific openings after fit check."""
    return box((50.0, 1.8, 12.0), (0.0, 0.0, 6.0))


def rear_interface_insert_v3() -> Mesh:
    """Smaller blank rear insert matching the thin V3 base."""
    return box((46.0, 1.8, 8.0), (0.0, 0.0, 4.0))


def rear_interface_insert_v4_final() -> Mesh:
    """Final insert with 0.2 mm width, 0.2 mm depth and 0.3 mm vertical clearance."""
    return box((45.6, 1.6, 7.4), (0.0, 0.0, 3.7))


def box(size: tuple[float, float, float], center: tuple[float, float, float]) -> Mesh:
    sx, sy, sz = size
    cx, cy, cz = center
    v = [
        (cx + dx * sx / 2, cy + dy * sy / 2, cz + dz * sz / 2)
        for dz in (-1, 1) for dy in (-1, 1) for dx in (-1, 1)
    ]
    m = Mesh(vertices=v)
    # Indices by z layer: 0..3 bottom, 4..7 top; each layer order --, +-, -+, ++.
    m.faces = [
        (0, 2, 3), (0, 3, 1), (4, 5, 7), (4, 7, 6),
        (0, 1, 5), (0, 5, 4), (2, 6, 7), (2, 7, 3),
        (0, 4, 6), (0, 6, 2), (1, 3, 7), (1, 7, 5),
    ]
    return m


def cylinder(radius: float, height: float, segments: int, z0: float = 0.0) -> Mesh:
    mesh = Mesh()
    bottom = [mesh.vertex((radius * math.cos(2 * math.pi * j / segments), radius * math.sin(2 * math.pi * j / segments), z0)) for j in range(segments)]
    top = [mesh.vertex((radius * math.cos(2 * math.pi * j / segments), radius * math.sin(2 * math.pi * j / segments), z0 + height)) for j in range(segments)]
    cb = mesh.vertex((0, 0, z0))
    ct = mesh.vertex((0, 0, z0 + height))
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(bottom[j], bottom[nj], top[nj], top[j])
        mesh.triangle(cb, bottom[nj], bottom[j])
        mesh.triangle(ct, top[j], top[nj])
    return mesh


def tapered_cylinder(
    bottom_radius: float,
    top_radius: float,
    height: float,
    segments: int,
    z0: float = 0.0,
) -> Mesh:
    """Closed low-profile frustum used for integrated acoustic feet."""
    mesh = Mesh()
    bottom = [
        mesh.vertex((bottom_radius * math.cos(2 * math.pi * j / segments), bottom_radius * math.sin(2 * math.pi * j / segments), z0))
        for j in range(segments)
    ]
    top = [
        mesh.vertex((top_radius * math.cos(2 * math.pi * j / segments), top_radius * math.sin(2 * math.pi * j / segments), z0 + height))
        for j in range(segments)
    ]
    bottom_center = mesh.vertex((0.0, 0.0, z0))
    top_center = mesh.vertex((0.0, 0.0, z0 + height))
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(bottom[j], bottom[nj], top[nj], top[j])
        mesh.triangle(bottom_center, bottom[nj], bottom[j])
        mesh.triangle(top_center, top[j], top[nj])
    return mesh


def hollow_cylinder(outer_radius: float, inner_radius: float, height: float, segments: int, z0: float = 0.0) -> Mesh:
    mesh = Mesh()
    ob = [mesh.vertex((outer_radius * math.cos(2 * math.pi * j / segments), outer_radius * math.sin(2 * math.pi * j / segments), z0)) for j in range(segments)]
    ot = [mesh.vertex((outer_radius * math.cos(2 * math.pi * j / segments), outer_radius * math.sin(2 * math.pi * j / segments), z0 + height)) for j in range(segments)]
    ib = [mesh.vertex((inner_radius * math.cos(2 * math.pi * j / segments), inner_radius * math.sin(2 * math.pi * j / segments), z0)) for j in range(segments)]
    it = [mesh.vertex((inner_radius * math.cos(2 * math.pi * j / segments), inner_radius * math.sin(2 * math.pi * j / segments), z0 + height)) for j in range(segments)]
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(ob[j], ob[nj], ot[nj], ot[j])
        mesh.quad(ib[j], it[j], it[nj], ib[nj])
        mesh.quad(ot[j], ot[nj], it[nj], it[j])
        mesh.quad(ob[j], ib[j], ib[nj], ob[nj])
    return mesh


def notched_hollow_cylinder(
    outer_radius: float,
    inner_radius: float,
    height: float,
    notch_width: float,
    notch_height: float,
    segments: int,
    z0: float = 0.0,
) -> Mesh:
    """Closed cradle ring with a shallow wire exit at the negative-X side."""
    mesh = Mesh()
    z_levels = (z0, z0 + height - notch_height, z0 + height)

    def rings(radius: float) -> list[list[int]]:
        return [
            [
                mesh.vertex((radius * math.cos(2 * math.pi * j / segments), radius * math.sin(2 * math.pi * j / segments), z))
                for j in range(segments)
            ]
            for z in z_levels
        ]

    outer = rings(outer_radius)
    inner = rings(inner_radius)
    half_angle = math.asin(min(1.0, notch_width / (2.0 * inner_radius)))

    def in_notch(j: int) -> bool:
        theta = 2.0 * math.pi * (j + 0.5) / segments
        delta = (theta - math.pi + math.pi) % (2.0 * math.pi) - math.pi
        return abs(delta) < half_angle

    for band in range(2):
        for j in range(segments):
            if band == 1 and in_notch(j):
                continue
            nj = (j + 1) % segments
            mesh.quad(outer[band][j], outer[band][nj], outer[band + 1][nj], outer[band + 1][j])
            mesh.quad(inner[band][j], inner[band + 1][j], inner[band + 1][nj], inner[band][nj])

    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(outer[0][j], inner[0][j], inner[0][nj], outer[0][nj])
        if in_notch(j):
            mesh.quad(outer[1][j], outer[1][nj], inner[1][nj], inner[1][j])
        else:
            mesh.quad(outer[2][j], outer[2][nj], inner[2][nj], inner[2][j])

    skipped = [j for j in range(segments) if in_notch(j)]
    start = skipped[0]
    end = (skipped[-1] + 1) % segments
    mesh.quad(outer[1][start], outer[2][start], inner[2][start], inner[1][start])
    mesh.quad(outer[1][end], inner[1][end], inner[2][end], outer[2][end])
    return mesh


def module_tray(*, refined: bool, board_envelope: tuple[float, float, float] = BOARD_ENVELOPE) -> Mesh:
    """Open-grid tray with a 66 x 32 mm board cradle and cable-tie lanes."""
    mesh = Mesh()
    length, width, thick = TRAY_SIZE
    rail = 5.0 if refined else 6.0
    # Perimeter and grid rails create real openings without mesh booleans.
    mesh.merge(box((length - 2 * rail + 1.0, rail, thick), (0, -(width - rail) / 2, thick / 2)))
    mesh.merge(box((length - 2 * rail + 1.0, rail, thick), (0, (width - rail) / 2, thick / 2)))
    mesh.merge(box((rail, width, thick), (-(length - rail) / 2, 0, thick / 2)))
    mesh.merge(box((rail, width, thick), ((length - rail) / 2, 0, thick / 2)))
    for x in (-35.0, 0.0, 35.0):
        mesh.merge(box((rail, width - 2 * rail, thick), (x, 0, thick / 2)))
    for y in (-25.0, 0.0, 25.0):
        mesh.merge(box((length - 2 * rail, rail, thick), (0, y, thick / 2)))

    board_l, board_w, _ = board_envelope
    bx, by = -18.0, -18.0
    tab_h = 5.0
    for x in (bx - board_l / 2 - 1.5, bx + board_l / 2 + 1.5):
        mesh.merge(box((3.0, board_w + 6.0, tab_h), (x, by, thick + tab_h / 2)))
    for y in (by - board_w / 2 - 1.5, by + board_w / 2 + 1.5):
        mesh.merge(box((board_l + 2.0, 3.0, tab_h), (bx, y, thick + tab_h / 2)))
    # Raised antenna-clearance rails: 15 mm beyond the board's antenna end.
    antenna_x = bx + board_l / 2 + 7.5
    for y in (by - board_w / 2, by + board_w / 2):
        mesh.merge(box((15.0, 1.2, 1.0), (antenna_x, y, thick + 0.5)))
    return mesh


def light_diffuser(*, refined: bool, segments: int) -> Mesh:
    mesh = Mesh()
    ao, bo = (81.0, 66.0) if refined else (80.0, 65.0)
    ai, bi = ao - 4.0, bo - 4.0
    height = 1.4
    ob = [mesh.vertex(_ellipse_point(ao, bo, 2 * math.pi * j / segments, 0.0)) for j in range(segments)]
    ot = [mesh.vertex(_ellipse_point(ao, bo, 2 * math.pi * j / segments, height)) for j in range(segments)]
    ib = [mesh.vertex(_ellipse_point(ai, bi, 2 * math.pi * j / segments, 0.0)) for j in range(segments)]
    it = [mesh.vertex(_ellipse_point(ai, bi, 2 * math.pi * j / segments, height)) for j in range(segments)]
    for j in range(segments):
        nj = (j + 1) % segments
        mesh.quad(ob[j], ob[nj], ot[nj], ot[j])
        mesh.quad(ib[j], it[j], it[nj], ib[nj])
        mesh.quad(ot[j], ot[nj], it[nj], it[j])
        mesh.quad(ob[j], ib[j], ib[nj], ob[nj])
    return mesh


def build_variant(name: str) -> dict[str, Mesh]:
    if name == "refined_v4_top_reprint":
        try:
            from .button_mount import (
                button_fit_gauge,
                top_reprint_button_upper_shell,
            )
            from .haptic_module import haptic_lid, haptic_lower
        except ImportError:  # Support this file when invoked directly.
            from button_mount import (
                button_fit_gauge,
                top_reprint_button_upper_shell,
            )
            from haptic_module import haptic_lid, haptic_lower

        return {
            "upper_shell": top_reprint_button_upper_shell(),
            "lower_base": lower_base_v3(
                speaker_aperture_radius=6.4,
                speaker_pocket_radius=7.9,
                speaker_cradle_outer_radius=10.9,
                speaker_cradle_height=4.8,
                speaker_wire_notch=True,
                acoustic_feet=True,
            ),
            "module_tray": module_tray(refined=True, board_envelope=FINAL_BOARD_ENVELOPE),
            "light_diffuser": pebble_light_diffuser_v3(),
            "rear_interface_insert": rear_interface_insert_v4_final(),
            "button_fit_gauge": button_fit_gauge(),
            "haptic_lower": haptic_lower(),
            "haptic_lid": haptic_lid(),
        }
    if name == "refined_v4_final":
        try:
            from .button_mount import button_fit_gauge, final_top_button_upper_shell
            from .haptic_module import haptic_lid, haptic_lower
        except ImportError:  # Support this file when invoked directly.
            from button_mount import button_fit_gauge, final_top_button_upper_shell
            from haptic_module import haptic_lid, haptic_lower

        return {
            "upper_shell": final_top_button_upper_shell(),
            "lower_base": lower_base_v3(
                speaker_aperture_radius=6.4,
                speaker_pocket_radius=7.9,
                speaker_cradle_outer_radius=10.9,
                speaker_cradle_height=4.8,
                speaker_wire_notch=True,
                acoustic_feet=True,
                mating_lip=True,
                power_line_clip=True,
            ),
            "module_tray": module_tray(refined=True, board_envelope=FINAL_BOARD_ENVELOPE),
            "light_diffuser": pebble_light_diffuser_v3(),
            "rear_interface_insert": rear_interface_insert_v4_final(),
            "button_fit_gauge": button_fit_gauge(),
            "haptic_lower": haptic_lower(),
            "haptic_lid": haptic_lid(),
        }
    if name == "refined_v3_button":
        try:
            from .button_mount import button_ready_upper_shell
        except ImportError:  # Support this file when invoked directly.
            from button_mount import button_ready_upper_shell

        return {
            "upper_shell": button_ready_upper_shell(),
            "lower_base": lower_base_v3(),
            "module_tray": module_tray(refined=True),
            "light_diffuser": pebble_light_diffuser_v3(),
            "rear_interface_insert": rear_interface_insert_v3(),
        }
    if name == "refined_v3":
        return {
            "upper_shell": moonstone_upper_v3(),
            "lower_base": lower_base_v3(),
            "module_tray": module_tray(refined=True),
            "light_diffuser": pebble_light_diffuser_v3(),
            "rear_interface_insert": rear_interface_insert_v3(),
        }
    if name == "refined_v2":
        return {
            "upper_shell": moonstone_upper_v2(),
            "lower_base": lower_base_v2(),
            "module_tray": module_tray(refined=True),
            "light_diffuser": pebble_light_diffuser_v2(),
            "rear_interface_insert": rear_interface_insert_v2(),
        }
    refined = name == "refined"
    segments = 160 if refined else 96
    rings = 34 if refined else 22
    models = {
        "upper_shell": moonstone_upper(refined=refined, segments=segments, rings=rings),
        "lower_base": lower_base(refined=refined, segments=segments),
        "module_tray": module_tray(refined=refined),
    }
    if refined:
        models["light_diffuser"] = light_diffuser(refined=True, segments=segments)
    return models


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--variant",
        choices=(
            "fast",
            "refined",
            "refined_v2",
            "refined_v3",
            "refined_v3_button",
            "refined_v4_final",
            "refined_v4_top_reprint",
            "all",
        ),
        default="all",
    )
    args = parser.parse_args()
    variants = ("fast", "refined") if args.variant == "all" else (args.variant,)
    for variant in variants:
        for part, mesh in build_variant(variant).items():
            folder = {
                "refined_v2": "stl-refined-v2",
                "refined_v3": "stl-refined-v3",
                "refined_v3_button": "stl-refined-v3-button",
                "refined_v4_final": "stl-refined-v4-final",
                "refined_v4_top_reprint": "stl-refined-v4-top-reprint",
            }.get(variant, "stl")
            path = OUTPUT_ROOT / folder / f"snoozmate_{variant}_{part}.stl"
            write_binary_stl(path, mesh)
            print(f"wrote {path} ({len(mesh.faces)} triangles)")
        if variant == "refined_v3_button":
            try:
                from .button_mount import button_cap_preview
            except ImportError:  # Support this file when invoked directly.
                from button_mount import button_cap_preview

            reference = (
                OUTPUT_ROOT
                / "preview-reference"
                / "snoozmate_refined_v3_button_cap_REFERENCE_ONLY.stl"
            )
            cap = button_cap_preview()
            write_binary_stl(reference, cap)
            print(f"wrote {reference} ({len(cap.faces)} triangles)")
        if variant in ("refined_v4_final", "refined_v4_top_reprint"):
            try:
                from .button_mount import (
                    final_top_button_cap_preview,
                    final_top_button_preview_shell,
                    top_reprint_button_cap_preview,
                    top_reprint_button_preview_shell,
                )
            except ImportError:  # Support this file when invoked directly.
                from button_mount import (
                    final_top_button_cap_preview,
                    final_top_button_preview_shell,
                    top_reprint_button_cap_preview,
                    top_reprint_button_preview_shell,
                )

            reference = (
                OUTPUT_ROOT
                / "preview-reference"
                / f"snoozmate_{variant}_button_cap_REFERENCE_ONLY.stl"
            )
            cap = (
                top_reprint_button_cap_preview()
                if variant == "refined_v4_top_reprint"
                else final_top_button_cap_preview()
            )
            write_binary_stl(reference, cap)
            print(f"wrote {reference} ({len(cap.faces)} triangles)")
            preview_shell_reference = (
                OUTPUT_ROOT
                / "preview-reference"
                / f"snoozmate_{variant}_preview_shell_REFERENCE_ONLY.stl"
            )
            preview_shell = (
                top_reprint_button_preview_shell()
                if variant == "refined_v4_top_reprint"
                else final_top_button_preview_shell()
            )
            write_binary_stl(preview_shell_reference, preview_shell)
            print(f"wrote {preview_shell_reference} ({len(preview_shell.faces)} triangles)")


if __name__ == "__main__":
    main()
