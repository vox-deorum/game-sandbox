"""Static types for the semantic Days at Three Branches observation and action."""

from __future__ import annotations

from typing import TypedDict


class Position(TypedDict):
    """One position in village meters."""

    x: float
    y: float


class Expression(TypedDict):
    """The expression resolved during the latest village tick."""

    type: str
    target: str


class Character(TypedDict):
    """A character visible to the observer, or the observer themself."""

    id: str
    position: Position
    heading: float
    moved: float
    expression: Expression


class NearbyCharacter(TypedDict):
    """A character audible to the observer."""

    id: str
    position: Position


class SeenProp(TypedDict):
    """One visible prop and its current state."""

    prop: str
    state: str


class Polyline(TypedDict):
    """A centerline route with its authored width."""

    points: tuple[Position, ...]
    width: float


class Bridge(TypedDict):
    """One bridge deck over a channel."""

    position: Position
    heading: float
    width: float
    span: float


class Doorway(TypedDict):
    """The center and width of a building's wall gap."""

    position: Position
    width: float


class Building(TypedDict):
    """One static building footprint."""

    id: str
    type: str
    center: Position
    width: float
    depth: float
    rotation: float
    doorway: Doorway


class Prop(TypedDict):
    """One static prop footprint."""

    id: str
    type: str
    position: Position
    footprint: dict[str, float]
    rotation: float


class Scenery(TypedDict):
    """One circular non-interactive obstacle."""

    type: str
    position: Position
    radius: float


class Village(TypedDict):
    """The complete static village layout shared by every character."""

    channels: tuple[Polyline, ...]
    road: Polyline
    footpaths: tuple[Polyline, ...]
    bridges: tuple[Bridge, ...]
    buildings: tuple[Building, ...]
    fields: tuple[tuple[Position, ...], ...]
    reed_banks: tuple[tuple[Position, ...], ...]
    props: tuple[Prop, ...]
    scenery: tuple[Scenery, ...]
    spawn: Position


class RosterEntry(TypedDict):
    """One character's stable rules-level identity and home."""

    id: str
    home: str


class Parameters(TypedDict):
    """The resolved gameplay settings for this village day."""

    seat_plan: str
    daynight: int


class ThreeBranchesObservation(TypedDict):
    """The full object-shaped observation received by one village character."""

    self: Character
    seen: tuple[Character, ...]
    nearby: tuple[NearbyCharacter, ...]
    props: tuple[SeenProp, ...]
    bell: int
    tick: int
    phase: str
    village: Village
    roster: tuple[RosterEntry, ...]
    parameters: Parameters


class ThreeBranchesAction(TypedDict):
    """One complete movement and expression order for a village tick."""

    heading: float
    speed: float
    action: int
