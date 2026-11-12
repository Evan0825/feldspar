# SPDX-FileCopyrightText: 2026 Feldspar project contributors
# SPDX-License-Identifier: CERN-OHL-P-2.0
"""Shared surface and mesh operations for the V6 enclosure. Units are millimetres."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import trimesh
from manifold3d import Error, Manifold, Mesh
from numpy.typing import NDArray

SHELL_LENGTH_MM = 167.0
SHELL_WIDTH_MM = 137.0
SHELL_HEIGHT_MM = 73.0
WALL_MM = 2.4
SURFACE_SEGMENTS = 256
SURFACE_RINGS = 56
CROWN_TRANSITION_Z_MM = 45.0


@dataclass(frozen=True)
class SurfaceFrame:
    center: NDArray[np.float64]
    across: NDArray[np.float64]
    down: NDArray[np.float64]
    normal: NDArray[np.float64]


def pebble_boundary_points(segments: int, length: float, width: float) -> np.ndarray:
    """Return an irregular, normalized pebble footprint centered on the origin."""
    theta = np.linspace(0.0, 2.0 * math.pi, segments, endpoint=False)
    radial = (
        1.0
        + 0.085 * np.cos(theta - 0.35)
        + 0.045 * np.cos(2.0 * theta + 1.05)
        + 0.018 * np.sin(3.0 * theta)
    )
    x = radial * np.cos(theta) * (1.0 + 0.035 * np.sin(theta))
    y = radial * np.sin(theta) * (1.0 - 0.055 * np.cos(theta))
    x = (x - (x.max() + x.min()) / 2.0) * (length / (x.max() - x.min()))
    y = (y - (y.max() + y.min()) / 2.0) * (width / (y.max() - y.min()))
    return np.column_stack((x, y))


def shell_surface(*, inner: bool = False) -> NDArray[np.float64]:
    """Sample a concentric shell surface from its rim to its crown."""
    inset = WALL_MM if inner else 0.0
    boundary = pebble_boundary_points(
        SURFACE_SEGMENTS, SHELL_LENGTH_MM - 2 * inset, SHELL_WIDTH_MM - 2 * inset
    )
    height = SHELL_HEIGHT_MM - inset
    peak = np.array([-8.0, 18.0])
    points = []
    for ring in range(SURFACE_RINGS):
        radius = 1.0 - ring / SURFACE_RINGS
        for segment in range(SURFACE_SEGMENTS):
            theta = 2.0 * math.pi * segment / SURFACE_SEGMENTS
            xy = boundary[segment] * radius + peak * (1.0 - radius) ** 1.35
            crown = (1.0 - radius**2.0) ** 0.62
            slope = 1.0 + 0.16 * radius * math.sin(theta)
            points.append((xy[0], xy[1], min(height, height * crown * slope)))
    points.append((peak[0], peak[1], height))
    return np.asarray(points)


def _unit(vector: NDArray[np.float64]) -> NDArray[np.float64]:
    return vector / np.linalg.norm(vector)


def surface_frame(ring: int, segment: int) -> SurfaceFrame:
    """Return the tangent frame for an opening on the outer shell."""
    outer = shell_surface()[:-1].reshape(SURFACE_RINGS, SURFACE_SEGMENTS, 3)
    center = outer[ring, segment]
    radial = outer[ring + 1, segment] - outer[ring - 1, segment]
    around = (
        outer[ring, (segment + 1) % SURFACE_SEGMENTS]
        - outer[ring, (segment - 1) % SURFACE_SEGMENTS]
    )
    across = _unit(around)
    normal = _unit(np.cross(around, radial))
    if normal[2] < 0:
        normal = -normal
    down = _unit(np.cross(normal, across))
    if down[2] > 0:
        down = -down
    return SurfaceFrame(center=center, across=across, down=down, normal=normal)


def frame_transform(frame: SurfaceFrame, center: np.ndarray) -> list[list[float]]:
    return [
        [frame.across[0], frame.down[0], frame.normal[0], center[0]],
        [frame.across[1], frame.down[1], frame.normal[1], center[1]],
        [frame.across[2], frame.down[2], frame.normal[2], center[2]],
    ]


def as_solid(mesh: trimesh.Trimesh) -> Manifold:
    solid = Manifold(
        Mesh(
            np.asarray(mesh.vertices, dtype=np.float32),
            np.asarray(mesh.faces, dtype=np.uint32),
        )
    )
    if solid.status() != Error.NoError:
        raise ValueError(f"Invalid manifold mesh: {solid.status()}")
    return solid


def as_mesh(solid: Manifold) -> trimesh.Trimesh:
    if solid.status() != Error.NoError:
        raise ValueError(f"Geometry operation failed: {solid.status()}")
    mesh = solid.to_mesh()
    return trimesh.Trimesh(
        np.asarray(mesh.vert_properties)[:, :3], mesh.tri_verts, process=True
    )


def clean_stl_roundoff(mesh: trimesh.Trimesh) -> None:
    """Weld only defective sub-0.00001 mm edges created by STL quantization."""
    for _ in range(3):
        mesh.update_faces(mesh.nondegenerate_faces(height=1e-9))
        mesh.update_faces(mesh.unique_faces())
        mesh.remove_unreferenced_vertices()
        edges, counts = np.unique(
            np.sort(mesh.edges, axis=1), axis=0, return_counts=True
        )
        defective = edges[counts != 2]
        if not len(defective):
            return
        length = np.linalg.norm(
            mesh.vertices[defective[:, 0]] - mesh.vertices[defective[:, 1]], axis=1
        )
        tiny = defective[
            (length < 1e-5)
            & (mesh.vertices[defective, 2] > CROWN_TRANSITION_Z_MM).all(axis=1)
        ]
        if not len(tiny):
            return
        parents = np.arange(len(mesh.vertices))
        for a, b in tiny:
            while parents[a] != a:
                a = parents[a]
            while parents[b] != b:
                b = parents[b]
            parents[max(a, b)] = min(a, b)
        while np.any(parents != parents[parents]):
            parents = parents[parents]
        mesh.faces = parents[mesh.faces]


def crown_envelopes() -> tuple[Manifold, Manifold]:
    """Create smooth outer/inner closed envelopes with the original lower mesh.

    Subdivision retains low-level coordinates exactly. Above the transition,
    vertex heights follow the continuous surface, without the old min() cap.
    Both surfaces use the same correction so the crown keeps its shell wall.
    """
    segments, rings = SURFACE_SEGMENTS, SURFACE_RINGS
    original = np.concatenate((shell_surface(), shell_surface(inner=True)))
    count = segments * rings + 1
    surfaces = []
    theta = np.arange(segments) * (2.0 * np.pi / segments)
    radius = 1.0 - np.arange(rings) / rings
    uv = np.column_stack(
        [
            (radius[:, None] * np.cos(theta)).ravel(),
            (radius[:, None] * np.sin(theta)).ravel(),
        ]
    )
    uv = np.vstack([uv, [0.0, 0.0]])
    faces = []
    for ring in range(rings - 1):
        for j in range(segments):
            a = ring * segments + j
            b = ring * segments + (j + 1) % segments
            c, d = b + segments, a + segments
            faces.extend([(a, b, c), (a, c, d)])
    for j in range(segments):
        faces.append(
            (
                (rings - 1) * segments + j,
                (rings - 1) * segments + (j + 1) % segments,
                count - 1,
            )
        )
    faces = np.asarray(faces)
    # Analytic extremum of (1-r²)^0.62 * (1+0.16r), on the rear axis.
    peak_r = (-1.24 + np.sqrt(1.24**2 + 4 * 0.3584 * 0.16)) / (2 * 0.3584)
    peak_factor = (1 - peak_r**2) ** 0.62 * (1 + 0.16 * peak_r)

    for inner in (False, True):
        points = original[count if inner else 0 : count * 2 if inner else count].copy()
        points = np.column_stack([points, uv])
        triangles = faces.copy()
        for _ in range(2):
            edges, inverse = np.unique(
                np.sort(triangles[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1),
                axis=0,
                return_inverse=True,
            )
            midpoint_ids = inverse.reshape(-1, 3) + len(points)
            points = np.vstack([points, points[edges].mean(axis=1)])
            a, b, c = triangles.T
            ab, bc, ca = midpoint_ids.T
            triangles = np.vstack(
                [
                    np.column_stack(t)
                    for t in (
                        (a, ab, ca),
                        (ab, b, bc),
                        (ca, bc, c),
                        (ab, bc, ca),
                    )
                ]
            )
        height = 70.6 if inner else 73.0
        u, v = points[:, 3], points[:, 4]
        raw_height = (
            height * np.maximum(0.0, 1.0 - u * u - v * v) ** 0.62 * (1.0 + 0.16 * v)
        )
        peak_height = height * peak_factor
        # Confine the crown correction to the former plateau, retaining button
        # seating height and the original slope around its opening.
        crown_start = height * (68.0 / 73.0)
        t = np.clip((raw_height - crown_start) / (peak_height - crown_start), 0.0, 1.0)
        crown = raw_height - (peak_height - height) * (t * t * (3 - 2 * t))
        t = np.clip((points[:, 2] - CROWN_TRANSITION_Z_MM) / 10.0, 0.0, 1.0)
        blend = t**3 * (10 - 15 * t + 6 * t * t)
        points[:, 2] += blend * (crown - points[:, 2])

        # Cap only the envelope at z=0, including every subdivided rim vertex.
        rim = np.flatnonzero(points[:, 2] == 0.0)
        rim = rim[np.argsort(np.arctan2(points[rim, 4], points[rim, 3]))]
        bottom_center = len(points)
        points = np.vstack([points, np.zeros((1, 5))])
        caps = np.column_stack(
            [np.roll(rim, -1), rim, np.full(len(rim), bottom_center)]
        )
        surfaces.append(
            as_solid(
                trimesh.Trimesh(
                    vertices=points[:, :3],
                    faces=np.vstack([triangles, caps]),
                    process=False,
                )
            )
        )
    return surfaces[0], surfaces[1]
