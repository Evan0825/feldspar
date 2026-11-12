"""Low-profile enclosure for the SnoozMate under-pillow haptic hardware."""

from __future__ import annotations

import numpy as np
from manifold3d import CrossSection, Manifold

try:
    from .generate_models import Mesh
except ImportError:  # Support direct execution through generate_models.py.
    from generate_models import Mesh


ENCLOSURE_LENGTH = 75.0
ENCLOSURE_WIDTH = 55.0
ASSEMBLED_HEIGHT = 14.0
LOWER_HEIGHT = 8.4
LOWER_BODY_HEIGHT = 7.8
WALL = 1.6
SEAM_CLEARANCE = 0.25
TONGUE_HEIGHT = LOWER_HEIGHT - LOWER_BODY_HEIGHT
TONGUE_THICKNESS = 1.2

LID_ASSEMBLED_Z = LOWER_BODY_HEIGHT
LID_HEIGHT = ASSEMBLED_HEIGHT - LID_ASSEMBLED_Z

DRIVER_ENVELOPE = (38.0, 27.0, 10.8)
DRIVER_CENTER = (10.0, 0.0)
DRIVER_POST_DIAMETER = 4.4
DRIVER_POST_SPACING = 16.0
DRIVER_BODY_HEIGHT = 10.0
DRIVER_BOTTOM_PAD = 0.4
DRIVER_TOP_PAD = 0.4

MOTOR_DIAMETER = 13.0
MOTOR_DEPTH = 5.0
MOTOR_CENTER = (-23.0, 0.0)

WIRE_CHANNEL_WIDTH = 3.0
WIRE_CHANNEL_DEPTH = 2.0
CABLE_OUTLET_WIDTH = 8.0
CABLE_OUTLET_HEIGHT = 4.0

SHELL_BOSS_POSITIONS = (
    (-30.0, -18.0),
    (-30.0, 18.0),
    (30.0, -18.0),
    (30.0, 18.0),
)


def _as_mesh(solid: Manifold) -> Mesh:
    result = solid.to_mesh()
    vertices = np.asarray(result.vert_properties, dtype=float)[:, :3]
    faces = np.asarray(result.tri_verts, dtype=np.uint32)
    return Mesh(
        vertices=[tuple(row) for row in vertices],
        faces=[tuple(int(value) for value in row) for row in faces],
    )


def _pebble_section(inset: float = 0.0) -> CrossSection:
    if inset >= 12.0:
        raise ValueError("inset is too large for the pebble corner radius")
    centers = (
        (-25.5, -14.8),
        (25.5, -15.5),
        (25.5, 14.7),
        (-24.7, 15.5),
    )
    discs = [CrossSection.circle(12.0, 64).translate(center) for center in centers]
    section = CrossSection.batch_hull(discs)
    return section.offset(-inset) if inset else section


def driver_locator_posts() -> Manifold:
    x, y = DRIVER_CENTER
    posts = [
        Manifold.cylinder(3.0, DRIVER_POST_DIAMETER / 2, circular_segments=48).translate(
            (x, y + offset, WALL)
        )
        for offset in (-DRIVER_POST_SPACING / 2, DRIVER_POST_SPACING / 2)
    ]
    return Manifold.compose(posts)


def driver_keepout() -> Manifold:
    x, y = DRIVER_CENTER
    body = Manifold.cube(DRIVER_ENVELOPE, True).translate(
        (x, y, WALL + DRIVER_ENVELOPE[2] / 2)
    )
    post_clearance = Manifold.compose(
        [
            Manifold.cylinder(
                DRIVER_ENVELOPE[2] + 0.2,
                2.4,
                circular_segments=48,
            ).translate((x, y + offset, WALL - 0.1))
            for offset in (-DRIVER_POST_SPACING / 2, DRIVER_POST_SPACING / 2)
        ]
    )
    return body - post_clearance


def motor_keepout() -> Manifold:
    return Manifold.cylinder(
        MOTOR_DEPTH,
        MOTOR_DIAMETER / 2,
        circular_segments=64,
    ).translate((MOTOR_CENTER[0], MOTOR_CENTER[1], WALL))


def _motor_cradle() -> Manifold:
    outer = Manifold.cylinder(MOTOR_DEPTH, 8.2, circular_segments=64).translate(
        (MOTOR_CENTER[0], MOTOR_CENTER[1], WALL)
    )
    return outer - motor_keepout()


def _driver_edge_rails() -> Manifold:
    x, y = DRIVER_CENTER
    long_side = DRIVER_ENVELOPE[0]
    short_side = DRIVER_ENVELOPE[1]
    rails = [
        Manifold.cube((1.5, short_side + 3.0, 2.0), True).translate(
            (x - long_side / 2 - 1.0, y, WALL + 1.0)
        ),
        Manifold.cube((1.5, short_side + 3.0, 2.0), True).translate(
            (x + long_side / 2 + 1.0, y, WALL + 1.0)
        ),
        Manifold.cube((long_side, 1.5, 2.0), True).translate(
            (x, y - short_side / 2 - 1.0, WALL + 1.0)
        ),
        Manifold.cube((long_side, 1.5, 2.0), True).translate(
            (x, y + short_side / 2 + 1.0, WALL + 1.0)
        ),
    ]
    return Manifold.compose(rails)


def _wire_channels() -> Manifold:
    z = WALL + WIRE_CHANNEL_DEPTH / 2
    return Manifold.compose(
        [
            Manifold.cube((8.0, WIRE_CHANNEL_WIDTH, WIRE_CHANNEL_DEPTH), True).translate(
                (-15.5, 0.0, z)
            ),
            Manifold.cube((8.0, WIRE_CHANNEL_WIDTH, WIRE_CHANNEL_DEPTH), True).translate(
                (33.0, 0.0, z)
            ),
        ]
    )


def cable_keepout() -> Manifold:
    radius = 1.0
    centers = (
        (-CABLE_OUTLET_HEIGHT / 2 + radius, -CABLE_OUTLET_WIDTH / 2 + radius),
        (-CABLE_OUTLET_HEIGHT / 2 + radius, CABLE_OUTLET_WIDTH / 2 - radius),
        (CABLE_OUTLET_HEIGHT / 2 - radius, -CABLE_OUTLET_WIDTH / 2 + radius),
        (CABLE_OUTLET_HEIGHT / 2 - radius, CABLE_OUTLET_WIDTH / 2 - radius),
    )
    section = CrossSection.batch_hull(
        [CrossSection.circle(radius, 32).translate(center) for center in centers]
    )
    return (
        section.extrude(10.0)
        .translate((0.0, 0.0, -5.0))
        .rotate((0.0, 90.0, 0.0))
        .translate((35.5, 0.0, LID_ASSEMBLED_Z))
    )


def _strain_relief_ribs() -> Manifold:
    z = 5.4
    return Manifold.compose(
        [
            Manifold.cube((2.0, 5.0, 2.0), True).translate((31.0, -2.0, z)),
            Manifold.cube((2.0, 5.0, 2.0), True).translate((34.0, 2.0, z)),
        ]
    )


def _shell_bosses() -> Manifold:
    return Manifold.compose(
        [
            Manifold.cylinder(LOWER_HEIGHT - WALL, 4.0, circular_segments=48).translate(
                (x, y, WALL)
            )
            for x, y in SHELL_BOSS_POSITIONS
        ]
    )


def _fastener_cuts() -> Manifold:
    cuts = []
    for x, y in SHELL_BOSS_POSITIONS:
        cuts.append(
            Manifold.cylinder(LOWER_HEIGHT + 0.2, 1.35, circular_segments=40).translate(
                (x, y, -0.1)
            )
        )
        cuts.append(
            Manifold.cylinder(1.5, 2.4, circular_segments=48).translate((x, y, -0.1))
        )
    return Manifold.compose(cuts)


def haptic_lower() -> Mesh:
    body = _pebble_section().extrude(LOWER_BODY_HEIGHT)
    cavity = _pebble_section(WALL).extrude(LOWER_BODY_HEIGHT).translate((0.0, 0.0, WALL))
    tongue_outer = _pebble_section(WALL + SEAM_CLEARANCE).extrude(TONGUE_HEIGHT).translate(
        (0.0, 0.0, LOWER_BODY_HEIGHT)
    )
    tongue_inner = _pebble_section(
        WALL + SEAM_CLEARANCE + TONGUE_THICKNESS
    ).extrude(TONGUE_HEIGHT + 0.2).translate((0.0, 0.0, LOWER_BODY_HEIGHT - 0.1))
    solid = (body - cavity) + (tongue_outer - tongue_inner)
    solid += _motor_cradle()
    solid += _driver_edge_rails()
    solid += driver_locator_posts()
    solid += _shell_bosses()
    solid += _strain_relief_ribs()
    solid -= _wire_channels()
    solid -= cable_keepout()
    solid -= _fastener_cuts()
    return _as_mesh(solid)


def _scaled_section(scale: float, inset: float = 0.0) -> CrossSection:
    section = _pebble_section().scale((scale, scale))
    return section.offset(-inset) if inset else section


def _loft(layers: tuple[tuple[float, float], ...], inset: float = 0.0) -> Manifold:
    slabs = [
        _scaled_section(scale, inset).extrude(0.05).translate((0.0, 0.0, z))
        for z, scale in layers
    ]
    result = Manifold()
    for lower, upper in zip(slabs, slabs[1:]):
        result += Manifold.batch_hull([lower, upper])
    return result


def _lid_bosses() -> Manifold:
    bosses = []
    for x, y in SHELL_BOSS_POSITIONS:
        outer = Manifold.cylinder(4.0, 4.0, circular_segments=48)
        insert_bore = Manifold.cylinder(3.3, 1.7, circular_segments=40).translate(
            (0.0, 0.0, -0.1)
        )
        bosses.append((outer - insert_bore).translate((x, y, 0.0)))
    return Manifold.compose(bosses)


def haptic_lid() -> Mesh:
    outer = _loft(
        (
            (0.0, 1.0),
            (3.7, 0.99),
            (5.3, 0.96),
            (LID_HEIGHT - 0.05, 0.88),
        )
    )
    cavity = _loft(
        (
            (-0.1, 1.0),
            (3.7, 0.99),
            (4.55, 0.978),
        ),
        inset=WALL,
    )
    solid = outer - cavity
    solid += _lid_bosses()
    solid -= cable_keepout().translate((0.0, 0.0, -LID_ASSEMBLED_Z))
    return _as_mesh(solid)


def seam_min_gap() -> float:
    lid_inner = _pebble_section(WALL).bounds()
    tongue_outer = _pebble_section(WALL + SEAM_CLEARANCE).bounds()
    gaps = (
        tongue_outer[0] - lid_inner[0],
        tongue_outer[1] - lid_inner[1],
        lid_inner[2] - tongue_outer[2],
        lid_inner[3] - tongue_outer[3],
    )
    return float(min(gaps))


def assembled_haptic_bounds() -> tuple[float, float, float]:
    lower = np.asarray(haptic_lower().vertices)
    lid = np.asarray(haptic_lid().vertices) + np.array((0.0, 0.0, LID_ASSEMBLED_Z))
    vertices = np.concatenate((lower, lid))
    size = np.ptp(vertices, axis=0)
    return tuple(float(value) for value in size)
