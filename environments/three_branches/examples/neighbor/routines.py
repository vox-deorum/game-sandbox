"""Routines: small building blocks of village behavior, such as walking somewhere or using a prop.

Every routine has the same shape::

    def routine_name(observation, memory, goal):
        ...
        return action.walk(...)  # or action.stand(...), or None

- ``observation`` is this tick's observation.
- ``memory`` is the resident's own memory dictionary from ``agent.py``. A routine that needs to
  remember something between ticks keeps it under ``_state(memory, "routine_name")``.
- ``goal`` says what the routine is about: a prop id (``"stall_2"``), a building id (``"inn"``),
  a player id (``"player_0"``), a position (``{"x": 12.5, "y": 8.5}``), or ``None``.

A routine returns this tick's action, or ``None`` when it cannot do its job right now (for
example, ``tend`` with a goal that is not a prop). The agent then falls back to ``go_to``.

To add your own routine, write a function with this shape anywhere in this file and return its
name from ``assign`` in ``agent.py``. Routines can call each other: ``tend`` calls ``go_to`` to walk
to its prop, for example. Longer walks follow a path from ``routing.py``.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from random import Random
from typing import Any, cast

import routing
from sandbox.village import action, day, geometry, layout, me, people, props

Point = Mapping[str, object]

# Numbers you can tune.
COMFORT_DISTANCE = 3.0  # metres that follow keeps from its target, and avoid keeps a little beyond
WANDER_TURNS = (-45.0, -20.0, 0.0, 20.0, 45.0)  # degrees wander may turn away from its goal
WANDER_TICKS = 16  # ticks wander keeps one heading before choosing a new one
WANDER_SPEED = 0.45  # fraction of full speed while wandering


def go_to(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Walk toward a goal along the route graph, one cell at a time. Never returns ``None``.

    The path is planned once and reused on later ticks. It is planned again when the goal's cell
    changes, when the resident leaves the path, or when the resident stood still for a tick, which
    usually means someone is in the way. The graph does not know where other villagers stand, so
    the new path is often the same one. Making crowded cells cost more is one way to improve on it.
    """
    here = me.position(observation)
    point = goal_point(observation, goal)
    # Props and building centers are not walkable, so head for the nearest cell that is.
    end = None if point is None else layout.nearest_walkable(observation, point)
    if end is None:
        return action.stand(me.heading(observation))
    graph = _graph(memory)
    start = _cell_here(observation)
    if start not in graph:
        # Pressed against a wall or a prop, off the graph: step back onto the nearest walkable cell.
        nearest = layout.nearest_walkable(observation, here)
        if nearest is None:
            return action.stand(me.heading(observation))
        return action.walk(geometry.heading_to(here, layout.cell_center(observation, nearest)))

    state = _state(memory, "go_to")
    end_cell = (end["x"], end["y"])
    path = cast("list[routing.Cell] | None", state.get("path"))
    stalled = state.get("position") == here
    state["position"] = dict(here)
    if stalled or not path or path[-1] != end_cell or start not in path:
        path = routing.path(graph, start, end_cell)
        state["path"] = path
    if not path or start == end_cell:
        return action.stand(me.heading(observation))
    return action.walk(geometry.heading_to(here, _center(observation, path[path.index(start) + 1])))


def wander(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Drift toward a goal, turning a little now and then. Never returns ``None``."""
    state = _state(memory, "wander")
    tick = day.tick(observation)
    # Every WANDER_TICKS ticks, pick a new heading: the direction of the goal, turned a little.
    if cast(int, state.get("until", -1)) <= tick:
        point = goal_point(observation, goal)
        heading = (
            me.heading(observation) if point is None else geometry.heading_to(me.position(observation), point)
        )
        state["heading"] = heading + cast(Random, memory["rng"]).choice(WANDER_TURNS)
        state["until"] = tick + WANDER_TICKS
    return action.walk(cast(float, state["heading"]), WANDER_SPEED, "sweep")


def tend(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Walk to a prop and use it. The goal is a prop id. Returns ``None`` when it is not a prop."""
    target = props.find(observation, goal)
    if target is None:
        return None
    # The use command picks the nearest prop within reach with no wall in between. When that would
    # be this prop, use it.
    usable = props.usable(observation)
    if usable is not None and usable["id"] == target["id"]:
        return action.stand(me.heading(observation), "use")
    # Within reach, but the use command would pick something else (a wall is in the way, or
    # another prop is nearer). Shuffle to the closest neighboring cell with a clear view.
    point = _prop_center(observation, target)
    if target in props.in_reach(observation):
        return _step(
            observation,
            memory,
            lambda cell: (layout.line_of_sight(observation, cell, point), -geometry.distance(cell, point)),
        )
    return go_to(observation, memory, target["id"])


def rest(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Sit on a free bench near the goal. Returns ``None`` when there is no free bench nearby."""
    point = goal_point(observation, goal)
    if point is None:
        return None
    # A resident only knows the state of benches it can see, so any bench out of sight counts as
    # free until the resident gets close enough to look.
    bench = next(
        (
            item
            for item in props.all(observation)
            if item["type"] == "bench"
            and props.state(observation, str(item["id"])) != "occupied"
            and geometry.distance(_prop_center(observation, item), point) <= geometry.HEARING_RANGE
        ),
        None,
    )
    # Using a bench means sitting on it.
    return None if bench is None else tend(observation, memory, bench["id"])


def gather_at(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Stop and face someone at the meeting place, once they are close enough to hear.

    Returns ``None`` while nobody within hearing range is at the goal, so the agent's ``go_to``
    fallback keeps walking toward it.
    """
    point = goal_point(observation, goal)
    if point is None:
        return None
    here = me.position(observation)
    companions = [
        person["position"]
        for person in people.nearby(observation)
        if geometry.distance(person["position"], point) <= geometry.HEARING_RANGE
    ]
    if not companions:
        return None
    return action.stand(
        geometry.heading_to(here, min(companions, key=lambda at: geometry.distance(here, at)))
    )


def greet(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Wave once to a character, then stay close enough to talk.

    The goal is a player id. Returns ``None`` when that character is neither seen nor heard.
    """
    target = people.find(observation, goal)
    if target is None:
        return None
    here = me.position(observation)
    heading = geometry.heading_to(here, target["position"])
    # The agent clears these notes whenever a new plan starts, so each greeting waves once.
    state = _state(memory, "greet")
    if not state.get("waved"):
        state["waved"] = True
        return action.stand(heading, "wave")
    if geometry.distance(here, target["position"]) > geometry.HEARING_RANGE:
        return go_to(observation, memory, goal)
    return action.stand(heading)


def follow(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Stay about ``COMFORT_DISTANCE`` metres from a character.

    The goal is a player id. Returns ``None`` when that character is neither seen nor heard.
    """
    target = people.find(observation, goal)
    if target is None:
        return None
    there = cast(Point, target["position"])
    distance = geometry.distance(me.position(observation), there)
    # Too far: step toward them.
    if distance > COMFORT_DISTANCE + 0.75:
        return _step(observation, memory, lambda cell: -geometry.distance(cell, there))
    # Too close: back away slowly.
    if distance < COMFORT_DISTANCE - 0.75:
        return _step(observation, memory, lambda cell: geometry.distance(cell, there), 0.5)
    # About right: stand and face them.
    return action.stand(geometry.heading_to(me.position(observation), there))


def avoid(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Back away, startled, from the closest person, then carry on toward the goal.

    Returns ``None`` when nobody is seen or heard.
    """
    here = me.position(observation)
    positions = [person["position"] for person in (*people.seen(observation), *people.nearby(observation))]
    if not positions:
        return None
    threat = cast(Point, min(positions, key=lambda at: geometry.distance(here, at)))
    if geometry.distance(here, threat) >= COMFORT_DISTANCE + 1.0:
        return go_to(observation, memory, goal)
    return _step(observation, memory, lambda cell: geometry.distance(cell, threat), 0.8, "startle")


def watch(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Stand still, facing the goal. Never returns ``None``."""
    del memory  # watch needs no memory
    point = goal_point(observation, goal)
    if point is None:
        return action.stand(me.heading(observation))
    return action.stand(geometry.heading_to(me.position(observation), point))


def sleep_at(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Sleep inside the goal building. The goal is a building id.

    Returns ``None`` while the resident is not yet inside, so the agent's ``go_to`` fallback walks
    it there first.
    """
    here = me.position(observation)
    if layout.building_at(observation, here) != goal:
        return None
    # Keep walking toward the middle of the room, so a housemate can still get past the doorway.
    # Lie down once standing still: at the middle, or with someone in the way.
    if me.moved(observation) > 0.05:
        return go_to(observation, memory, goal)
    return action.stand(me.heading(observation), "sleep")


def goal_point(observation: Mapping[str, object], goal: object) -> Point | None:
    """Return the position a goal refers to, or ``None`` when it cannot be found.

    A prop or building goal means its center, and a player id means where that character is, if
    this resident can see or hear them.
    """
    if isinstance(goal, Mapping):
        return goal
    prop = props.find(observation, goal)
    if prop is not None:
        return _prop_center(observation, prop)
    building = layout.building_center(observation, str(goal))
    if building is not None:
        return building
    person = people.find(observation, goal)
    return None if person is None else cast(Point, person["position"])


# Helpers used by the routines above


def _state(memory: dict[str, object], name: str) -> dict[str, object]:
    """Return one routine's private notes, creating them the first time."""
    routines = cast("dict[str, object]", memory.setdefault("routines", {}))
    return cast("dict[str, object]", routines.setdefault(name, {}))


def _graph(memory: dict[str, object]) -> routing.Graph:
    """Return the route graph that ``agent.py`` built at reset."""
    return cast(routing.Graph, memory.get("graph", {}))


def _cell_here(observation: Mapping[str, object]) -> routing.Cell | None:
    """Return the cell the resident is standing in, or ``None`` outside the village."""
    cell = layout.cell_at(observation, me.position(observation))
    return None if cell is None else (int(cell["x"]), int(cell["y"]))


def _center(observation: Mapping[str, object], cell: routing.Cell) -> dict[str, float]:
    return layout.cell_center(observation, {"x": cell[0], "y": cell[1]})


def _prop_center(observation: Mapping[str, object], prop: Mapping[str, object]) -> dict[str, float]:
    return layout.cell_center(observation, cast(Point, prop["cell"]))


def _step(
    observation: Mapping[str, object],
    memory: dict[str, object],
    score: Callable[[dict[str, float]], Any],
    speed: float = 1.0,
    expression: str = "none",
):
    """Walk toward the neighboring cell whose center scores highest, without planning a whole path.

    Good for short moves around a moving target. Stands when there is no neighboring cell.
    """
    here = _cell_here(observation)
    steps = () if here is None else _graph(memory).get(here, ())
    neighbors = [_center(observation, cell) for cell, _cost in steps]
    if not neighbors:
        return action.stand(me.heading(observation))
    best = max(neighbors, key=score)
    return action.walk(geometry.heading_to(me.position(observation), best), speed, expression)
