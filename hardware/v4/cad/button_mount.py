"""DFRobot DFR0029 button openings and internal mounting bosses."""

from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np
from manifold3d import CrossSection, Manifold, Mesh as ManifoldMesh

try:
    from .generate_models import Mesh, moonstone_upper_v3
except ImportError:  # Support generate_models.py when invoked directly.
    from generate_models import Mesh, moonstone_upper_v3


BUTTON_OPENING_DIAMETER = 14.0
BUTTON_BOARD_SIZE = (30.0, 22.0)
BUTTON_INTERNAL_CLEARANCE = 18.0
FINAL_BUTTON_OPENING_DIAMETER = 14.6
TOP_REPRINT_BUTTON_OPENING_DIAMETER = 13.0
SIDE_MICROPHONE_OPENING_DIAMETER = 1.3
FINAL_BUTTON_BOARD_ENVELOPE = (32.0, 24.0, 20.0)

_SURFACE_SEGMENTS = 256
_SURFACE_RINGS = 56
_BUTTON_RING = 7
_BUTTON_SEGMENT = 39
_FINAL_BUTTON_RING = 36
_FINAL_BUTTON_SEGMENT = 249
_TOP_REPRINT_SIDE_MIC_RING = 6
_TOP_REPRINT_SIDE_MIC_SEGMENT = 128


@dataclass(frozen=True)
class ButtonFrame:
    center: np.ndarray
    across: np.ndarray
    down: np.ndarray
    normal: np.ndarray


def _unit(vector: np.ndarray) -> np.ndarray:
    return vector / np.linalg.norm(vector)


def _surface_frame(shell: Mesh, ring: int, segment: int) -> ButtonFrame:
    outer = np.asarray(shell.vertices[: _SURFACE_SEGMENTS * _SURFACE_RINGS], dtype=float).reshape(
        _SURFACE_RINGS, _SURFACE_SEGMENTS, 3
    )
    center = outer[ring, segment]
    radial = outer[ring + 1, segment] - outer[ring - 1, segment]
    around = outer[ring, (segment + 1) % _SURFACE_SEGMENTS] - outer[
        ring, (segment - 1) % _SURFACE_SEGMENTS
    ]
    across = _unit(around)
    normal = _unit(np.cross(around, radial))
    if normal[2] < 0:
        normal = -normal
    down = _unit(np.cross(normal, across))
    if down[2] > 0:
        down = -down
    return ButtonFrame(center=center, across=across, down=down, normal=normal)


def button_frame(shell: Mesh) -> ButtonFrame:
    """Return the local tangent frame on the rear-right shoulder."""
    return _surface_frame(shell, _BUTTON_RING, _BUTTON_SEGMENT)


def final_top_button_frame(shell: Mesh) -> ButtonFrame:
    """Return the top-right frame used by the final white button."""
    return _surface_frame(shell, _FINAL_BUTTON_RING, _FINAL_BUTTON_SEGMENT)


def top_reprint_source_shell() -> Mesh:
    return moonstone_upper_v3(
        segments=_SURFACE_SEGMENTS,
        rings=_SURFACE_RINGS,
        outer_length=167.0,
        outer_width=137.0,
    )


def top_reprint_button_frame() -> ButtonFrame:
    return final_top_button_frame(top_reprint_source_shell())


def top_reprint_side_microphone_frame() -> ButtonFrame:
    return _surface_frame(
        top_reprint_source_shell(),
        _TOP_REPRINT_SIDE_MIC_RING,
        _TOP_REPRINT_SIDE_MIC_SEGMENT,
    )


def _transform(frame: ButtonFrame, center: np.ndarray) -> list[list[float]]:
    return [
        [frame.across[0], frame.down[0], frame.normal[0], center[0]],
        [frame.across[1], frame.down[1], frame.normal[1], center[1]],
        [frame.across[2], frame.down[2], frame.normal[2], center[2]],
    ]


def _as_manifold(mesh: Mesh) -> Manifold:
    return Manifold(
        ManifoldMesh(
            vert_properties=np.asarray(mesh.vertices, dtype=np.float32),
            tri_verts=np.asarray(mesh.faces, dtype=np.uint32),
        )
    )


def _as_mesh(solid: Manifold) -> Mesh:
    result = solid.to_mesh()
    vertices = np.asarray(result.vert_properties, dtype=float)[:, :3]
    faces = np.asarray(result.tri_verts, dtype=np.uint32)
    return Mesh(vertices=[tuple(row) for row in vertices], faces=[tuple(int(v) for v in row) for row in faces])


def button_ready_upper_shell() -> Mesh:
    """Cut the cap opening and add two blind M2.5 mounting bosses."""
    source = moonstone_upper_v3(segments=_SURFACE_SEGMENTS, rings=_SURFACE_RINGS)
    frame = button_frame(source)
    shell = _as_manifold(source)

    cutter = Manifold.cylinder(
        12.0,
        BUTTON_OPENING_DIAMETER / 2.0,
        circular_segments=64,
        center=True,
    ).transform(_transform(frame, frame.center))
    shell = shell - cutter

    boss_length = 4.8
    boss_axis_center = frame.center - frame.normal * 4.2
    for across_offset in (-7.5, 7.5):
        center = boss_axis_center + frame.across * across_offset - frame.down * 7.0
        outer = Manifold.cylinder(boss_length, 3.2, circular_segments=40, center=True)
        bore = Manifold.cylinder(boss_length + 0.2, 1.35, circular_segments=32, center=True)
        boss = (outer - bore).transform(_transform(frame, center))
        shell = shell + boss

    return _as_mesh(shell)


def button_cap_preview() -> Mesh:
    """Return a non-print reference cap used only in assembly previews."""
    shell = moonstone_upper_v3(segments=_SURFACE_SEGMENTS, rings=_SURFACE_RINGS)
    frame = button_frame(shell)
    cap = Manifold.cylinder(6.0, 6.5, circular_segments=64, center=True).transform(
        _transform(frame, frame.center + frame.normal * 2.0)
    )
    return _as_mesh(cap)


def _round_boss(frame: ButtonFrame, center: np.ndarray) -> Manifold:
    """Internal M2.5 boss with rounded free edge, flared root and blind bore."""
    length = 6.2
    edge_radius = 0.8
    side_radius = 3.8
    free_face_radius = side_radius - edge_radius
    free_z = -length / 2.0
    fillet_center_z = free_z + edge_radius
    fillet = [
        (
            free_face_radius + edge_radius * math.cos(angle),
            fillet_center_z + edge_radius * math.sin(angle),
        )
        for angle in np.linspace(-math.pi / 2.0, 0.0, 9)
    ]
    root_radius = 3.2
    root_start_z = -1.2
    root_outer_radius = side_radius + root_radius
    root_fillet = [
        (
            root_outer_radius + root_radius * math.cos(angle),
            root_start_z + root_radius * math.sin(angle),
        )
        for angle in np.linspace(math.pi, math.pi / 2.0, 17)
    ]
    root_end_z = root_start_z + root_radius
    profile = CrossSection(
        [[(0.0, free_z), *fillet, (side_radius, root_start_z), *root_fillet, (0.0, root_end_z)]]
    )
    outer = Manifold.revolve(profile, circular_segments=96).transform(_transform(frame, center))
    blind_bore = Manifold.cylinder(4.4, 1.7, circular_segments=96, center=True).transform(
        _transform(frame, center - frame.normal * 1.0)
    )
    return outer - blind_bore


def _final_button_shell(source: Mesh, *, opening_diameter: float, opening_segments: int) -> Mesh:
    """V4 shell with a tolerant top opening and round internal DFR0029 bosses."""
    frame = final_top_button_frame(source)
    shell = _as_manifold(source)

    cutter_center = frame.center - frame.normal * 3.0
    cutter = Manifold.cylinder(
        12.0,
        opening_diameter / 2.0,
        circular_segments=opening_segments,
        center=True,
    ).transform(_transform(frame, cutter_center))

    boss_axis_center = frame.center - frame.normal * 4.3
    for across_offset in (-7.5, 7.5):
        center = boss_axis_center + frame.across * across_offset + frame.down * 9.2
        shell = shell + _round_boss(frame, center)
    return _as_mesh(shell - cutter)


def final_top_button_upper_shell() -> Mesh:
    source = moonstone_upper_v3(segments=_SURFACE_SEGMENTS, rings=_SURFACE_RINGS)
    return _final_button_shell(source, opening_diameter=FINAL_BUTTON_OPENING_DIAMETER, opening_segments=64)


def top_reprint_button_upper_shell() -> Mesh:
    """Top shell reworked to visually match the already printed 167 x 137 mm base."""
    source = top_reprint_source_shell()
    shell = _as_manifold(
        _final_button_shell(
            source,
            opening_diameter=TOP_REPRINT_BUTTON_OPENING_DIAMETER,
            opening_segments=96,
        )
    )
    frame = top_reprint_side_microphone_frame()
    mic_cutter = Manifold.cylinder(
        8.0,
        SIDE_MICROPHONE_OPENING_DIAMETER / 2.0,
        circular_segments=48,
        center=True,
    ).transform(_transform(frame, frame.center - frame.normal * 1.5))
    return _as_mesh(shell - mic_cutter)


def _preview_shell(source: Mesh, *, opening_diameter: float, opening_segments: int, side_microphone: bool = False) -> Mesh:
    """Exterior preview shell without internal bosses that confuse the painter renderer."""
    frame = final_top_button_frame(source)
    shell = _as_manifold(source)
    cutter = Manifold.cylinder(
        12.0,
        opening_diameter / 2.0,
        circular_segments=opening_segments,
        center=True,
    ).transform(_transform(frame, frame.center - frame.normal * 3.0))
    if side_microphone:
        mic_frame = top_reprint_side_microphone_frame()
        cutter = cutter + Manifold.cylinder(
            8.0,
            SIDE_MICROPHONE_OPENING_DIAMETER / 2.0,
            circular_segments=48,
            center=True,
        ).transform(_transform(mic_frame, mic_frame.center - mic_frame.normal * 1.5))
    return _as_mesh(shell - cutter)


def final_top_button_preview_shell() -> Mesh:
    source = moonstone_upper_v3(segments=_SURFACE_SEGMENTS, rings=_SURFACE_RINGS)
    return _preview_shell(source, opening_diameter=FINAL_BUTTON_OPENING_DIAMETER, opening_segments=64)


def top_reprint_button_preview_shell() -> Mesh:
    source = top_reprint_source_shell()
    return _preview_shell(
        source,
        opening_diameter=TOP_REPRINT_BUTTON_OPENING_DIAMETER,
        opening_segments=96,
        side_microphone=True,
    )


def final_top_button_cap_preview() -> Mesh:
    """White DFR0029 cap reference for the final assembly preview only."""
    shell = moonstone_upper_v3(segments=_SURFACE_SEGMENTS, rings=_SURFACE_RINGS)
    frame = final_top_button_frame(shell)
    cap = Manifold.cylinder(6.0, 6.5, circular_segments=64, center=True).transform(
        _transform(frame, frame.center + frame.normal * 2.0)
    )
    return _as_mesh(cap)


def top_reprint_button_cap_preview() -> Mesh:
    """White DFR0029 cap reference aligned to the top reprint shell."""
    frame = top_reprint_button_frame()
    cap = Manifold.cylinder(6.0, 6.5, circular_segments=64, center=True).transform(
        _transform(frame, frame.center + frame.normal * 2.0)
    )
    return _as_mesh(cap)


def button_fit_gauge() -> Mesh:
    """Three-hole coupon for choosing the best opening on the actual printer."""
    gauge = Manifold.cube((60.0, 25.0, 3.0), True)
    for x, diameter in zip((-20.0, 0.0, 20.0), (14.2, 14.6, 15.0)):
        cutter = Manifold.cylinder(5.0, diameter / 2.0, circular_segments=64, center=True).translate(
            (x, 0.0, 0.0)
        )
        gauge = gauge - cutter
    return _as_mesh(gauge)
