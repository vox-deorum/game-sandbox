"""Validated generation tuning for the seeded village.

Every number the generator draws with lives in ``generation.json``. Code and tests read values from
here instead of restating them, so a tuning pass is a data edit. The document is validated when the
generation package imports, and the cross-group checks at the end of ``load`` are the arithmetic that
keeps the guarantees reachable: three mouths fit the south edge, and the widest trunk enters inside
its band. They bound what tuning allows, and each stage still checks the village it actually drew.

A group lands when its stage lands, so every number shipped here has a consumer. The road, its
crossings, and the spawn arrive with the settlement work, and bring the ``network`` group with them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import resources
from math import ceil
from typing import Any

from ..rules import FRAME
from ..validation import mapping, nonnegative_number, positive_int, positive_number


class Retry(Exception):
    """A mandatory placement ran out of candidates, so the whole layout is drawn again."""


def _int_range(value: Any, name: str) -> tuple[int, int]:
    """Accept inclusive whole-number bounds the generator draws between."""
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f"{name} must be a two-element array")
    low, high = (positive_int(item, name) for item in value)
    if low > high:
        raise ValueError(f"{name} must run from low to high")
    return low, high


def _number_range(value: Any, name: str) -> tuple[float, float]:
    """Accept inclusive bounds the generator draws a per-seed weight between."""
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f"{name} must be a two-element array")
    low, high = (positive_number(item, name) for item in value)
    if low > high:
        raise ValueError(f"{name} must run from low to high")
    return low, high


def _fraction(value: Any, name: str) -> float:
    """Accept a share of the unit range, which is the scale the noise fields are normalised to."""
    number = nonnegative_number(value, name)
    if number > 1.0:
        raise ValueError(f"{name} must fall between zero and one")
    return number


@dataclass(frozen=True, slots=True)
class Octave:
    """One layer of a noise field. Layering a few builds detail on top of broad shape."""

    # Cells between lattice nodes. Wide spacing gives broad country, narrow spacing gives texture.
    spacing: int
    # How much this layer counts against the others before the field is normalised.
    amplitude: float


@dataclass(frozen=True, slots=True)
class Fields:
    """The two noise fields every later stage reads: how high the land is and how wet it is."""

    # Shapes the land the water runs down.
    elevation_octaves: tuple[Octave, ...]
    # Shapes where reeds and fields grow, and which ground the road will prefer.
    moisture_octaves: tuple[Octave, ...]
    # How much elevation is lifted toward the north, which is what sends the water south. Zero
    # leaves the noise alone and one flattens it into a pure slope.
    south_bias: float


@dataclass(frozen=True, slots=True)
class Walker:
    """How a carving brush steers.

    Every step the walker blends the weights below into one heading, moves `step` along it, and
    paints. The three drawn ranges are sampled once per course, so two rivers on one map still
    behave differently from each other.
    """

    # Cells the brush travels each step. Shorter steps trace a smoother line and cost more time.
    step: float
    # Most steps one course may take. A walk that never reaches its stop line abandons the layout.
    step_budget: int
    # Recent steps of its own trail a course ignores when testing contact. Its trail is directly
    # behind it, so without this a course would block on the ground it just covered.
    self_ignore: int
    # When a step is blocked, how many turns to try and how far each one turns, alternating sides.
    reroute_attempts: int
    reroute_degrees: float
    # Weight on the heading it already had. High momentum makes a long, lazy curve.
    momentum: tuple[float, float]
    # Weight on the downhill slope of the elevation field.
    downhill: tuple[float, float]
    # Weight on the straight line to wherever the course is headed. This is what makes it arrive.
    pull: tuple[float, float]
    # Strength of the random nudge each step, which keeps the line from looking drawn.
    wobble: float
    # Strength of the turn away from the east and west frame edges.
    edge_push: float
    # Strength of the turn away from water another course already carved.
    separation: float
    # How far past the blocking clearance a course senses another. Sensing further than it blocks
    # is what lets it turn away in time instead of stopping dead against what it found.
    look_ahead: float
    # Strength of the sideways swing across the line to the target, and the cells travelled per
    # full swing. This is what bends a course rather than letting it run at its target.
    meander: float
    meander_wavelength: tuple[int, int]


@dataclass(frozen=True, slots=True)
class Water:
    """The trunk, the fork, and the three channels that give the village its name."""

    # Columns the trunk may enter the north edge in. The run it paints stays inside the band, not
    # just the point it starts from.
    entry_band: tuple[int, int]
    # Rows below the north edge where the trunk ends and the three channels take over. A deep fork
    # leaves the channels a long way to run; a shallow one keeps the braid near the top of the map.
    fork_band: tuple[int, int]
    # Cells across the trunk and across each channel. Both must be odd, because that is what a
    # brush centred on a cell can carve exactly.
    trunk_width: tuple[int, int]
    channel_width: tuple[int, int]
    # Least distance allowed between neighbouring mouth centres on the south edge.
    mouth_separation: int
    # Extra separation demanded of the drawn targets on top of that, so a course can wander on its
    # way down and still land far enough from its neighbour.
    mouth_slack: int
    # Rows at a frame edge over which a course runs straight. That is what makes the run it paints
    # where it meets the edge come out at exactly the width it was carved with.
    edge_straight: int
    # Columns of land kept clear along the east and west frame edges, so no course hugs the side.
    edge_margin: int
    # Radius of the shared pool where the trunk ends.
    fork_radius: float
    # Opening steps of each channel that count as shared water too. The pool alone is not enough
    # room for three channels to part, so their first reaches join the area where they may meet.
    fork_steps: int
    # How far the outer channels are turned away from their target as they leave the fork. This is
    # what fans them apart fast enough to stand clear of each other below the shared area.
    fan_degrees: float
    # Cells of land kept between any two courses outside that shared area.
    clearance: float
    # Draws allowed to find three mouth targets that keep their separation.
    mouth_budget: int
    walker: Walker


@dataclass(frozen=True, slots=True)
class Grounds:
    """Reed flats and terraced fields, painted over the open ground the water left."""

    # Cells from water within which a bank cell may turn to reeds, and the moisture it needs.
    reed_distance: int
    reed_moisture: float
    # Rows above the south edge where a bank cell turns to reeds whatever its moisture, so every
    # channel mouth collects them.
    mouth_reed_depth: int
    # A field wants land that is low, dry, and flat, so it takes elevation and moisture at or below
    # these and a local slope no steeper than this.
    field_elevation: float
    field_moisture: float
    field_slope: float
    # Majority passes over the land classes. Per-cell thresholds always speckle, and this clears it.
    smoothing_passes: int


@dataclass(frozen=True, slots=True)
class Generation:
    fields: Fields
    water: Water
    grounds: Grounds
    # Whole layouts one seed may draw before generation gives up and raises. A draw is discarded
    # when a mandatory stage runs out of room, and the next one continues on the same stream.
    redraw_cap: int


def _octaves(value: Any, name: str) -> tuple[Octave, ...]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{name} must be a non-empty array")
    return tuple(
        Octave(
            positive_int(entry["spacing"], f"{name}.spacing"),
            positive_number(entry["amplitude"], f"{name}.amplitude"),
        )
        for entry in (mapping(item, name, {"spacing", "amplitude"}) for item in value)
    )


def _walker(value: Any) -> Walker:
    data = mapping(value, "water.walker", set(Walker.__dataclass_fields__))
    return Walker(
        positive_number(data["step"], "water.walker.step"),
        positive_int(data["step_budget"], "water.walker.step_budget"),
        positive_int(data["self_ignore"], "water.walker.self_ignore"),
        positive_int(data["reroute_attempts"], "water.walker.reroute_attempts"),
        positive_number(data["reroute_degrees"], "water.walker.reroute_degrees"),
        _number_range(data["momentum"], "water.walker.momentum"),
        _number_range(data["downhill"], "water.walker.downhill"),
        _number_range(data["pull"], "water.walker.pull"),
        nonnegative_number(data["wobble"], "water.walker.wobble"),
        nonnegative_number(data["edge_push"], "water.walker.edge_push"),
        nonnegative_number(data["separation"], "water.walker.separation"),
        positive_number(data["look_ahead"], "water.walker.look_ahead"),
        nonnegative_number(data["meander"], "water.walker.meander"),
        _int_range(data["meander_wavelength"], "water.walker.meander_wavelength"),
    )


def load(data: Any) -> Generation:
    """Validate a decoded generation document without accepting unrecognised data."""
    root = mapping(data, "generation", {"fields", "water", "grounds", "redraw"})
    fields_data = mapping(root["fields"], "generation.fields", set(Fields.__dataclass_fields__))
    field_tuning = Fields(
        _octaves(fields_data["elevation_octaves"], "fields.elevation_octaves"),
        _octaves(fields_data["moisture_octaves"], "fields.moisture_octaves"),
        _fraction(fields_data["south_bias"], "fields.south_bias"),
    )
    water_data = mapping(root["water"], "generation.water", set(Water.__dataclass_fields__))
    water_tuning = Water(
        _int_range(water_data["entry_band"], "water.entry_band"),
        _int_range(water_data["fork_band"], "water.fork_band"),
        _int_range(water_data["trunk_width"], "water.trunk_width"),
        _int_range(water_data["channel_width"], "water.channel_width"),
        positive_int(water_data["mouth_separation"], "water.mouth_separation"),
        positive_int(water_data["mouth_slack"], "water.mouth_slack"),
        positive_int(water_data["edge_straight"], "water.edge_straight"),
        positive_int(water_data["edge_margin"], "water.edge_margin"),
        positive_number(water_data["fork_radius"], "water.fork_radius"),
        positive_int(water_data["fork_steps"], "water.fork_steps"),
        positive_number(water_data["fan_degrees"], "water.fan_degrees"),
        positive_number(water_data["clearance"], "water.clearance"),
        positive_int(water_data["mouth_budget"], "water.mouth_budget"),
        _walker(water_data["walker"]),
    )
    grounds_data = mapping(root["grounds"], "generation.grounds", set(Grounds.__dataclass_fields__))
    grounds_tuning = Grounds(
        positive_int(grounds_data["reed_distance"], "grounds.reed_distance"),
        _fraction(grounds_data["reed_moisture"], "grounds.reed_moisture"),
        positive_int(grounds_data["mouth_reed_depth"], "grounds.mouth_reed_depth"),
        _fraction(grounds_data["field_elevation"], "grounds.field_elevation"),
        _fraction(grounds_data["field_moisture"], "grounds.field_moisture"),
        positive_number(grounds_data["field_slope"], "grounds.field_slope"),
        positive_int(grounds_data["smoothing_passes"], "grounds.smoothing_passes"),
    )
    redraw_data = mapping(root["redraw"], "generation.redraw", {"cap"})
    tuning = Generation(
        field_tuning,
        water_tuning,
        grounds_tuning,
        positive_int(redraw_data["cap"], "redraw.cap"),
    )
    _check_frame_arithmetic(tuning)
    return tuning


def _check_frame_arithmetic(tuning: Generation) -> None:
    """Reject tuning the shipped frame cannot satisfy, before any village is drawn."""
    water = tuning.water
    if any(bound % 2 == 0 for bound in (*water.trunk_width, *water.channel_width)):
        raise ValueError("water course widths must be odd, which is what a cell-centred brush carves")
    if water.fork_band[1] >= FRAME.cells_y or water.entry_band[1] >= FRAME.cells_x:
        raise ValueError("water.fork_band and water.entry_band must fall inside the frame")
    trunk_reach = ceil(water.trunk_width[1] / 2)
    channel_reach = ceil(water.channel_width[1] / 2)
    mouth_span = FRAME.cells_x - 1 - 2 * (water.edge_margin + channel_reach)
    if 2 * (water.mouth_separation + water.mouth_slack) >= mouth_span:
        raise ValueError("water.mouth_separation and water.mouth_slack leave no room for three mouths")
    if water.entry_band[1] - water.entry_band[0] <= water.trunk_width[1]:
        raise ValueError("water.entry_band must be wider than the widest trunk it has to contain")
    if water.entry_band[0] - trunk_reach < water.edge_margin:
        raise ValueError("water.entry_band must keep the widest trunk inside water.edge_margin")
    if water.entry_band[1] + trunk_reach > FRAME.cells_x - 1 - water.edge_margin:
        raise ValueError("water.entry_band must keep the widest trunk inside water.edge_margin")


GENERATION = load(
    json.loads(resources.files(__package__).joinpath("generation.json").read_text(encoding="utf-8"))
)
