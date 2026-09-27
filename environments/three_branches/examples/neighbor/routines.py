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
example, ``tend`` with a goal that is not a prop). The agent then falls back to ``wander``.

To add your own routine, write a function with this shape anywhere in this file and return its
name from ``assign`` in ``agent.py``. Routines can call each other: ``tend`` calls ``go_to`` to walk
to its prop, for example.

Most movement goes through the route graph. ``build_graph`` turns every walkable cell of the
village into a graph node once, at reset, and ``go_to`` searches that graph for a path with A*. You
may change how the graph is built or replace the route finder, as long as ``go_to`` keeps the same
shape.
"""

from __future__ import annotations

import heapq
from collections.abc import Mapping
from random import Random
from typing import cast

from sandbox.village import action, day, geometry, layout, me, people, props

# A cell is an (x, y) pair of grid indices. Cells are one metre square, so cell (3, 7) covers the
# positions from (3.0, 7.0) up to (4.0, 8.0).
Cell = tuple[int, int]
# Each cell maps to the cells one step away and the cost of stepping there.
Graph = dict[Cell, tuple[tuple[Cell, float], ...]]

# Numbers you can tune.
COMFORT_DISTANCE = 3.0  # metres that follow keeps from its target, and avoid keeps a little beyond
WANDER_TURNS = (-45.0, -20.0, 0.0, 20.0, 45.0)  # degrees wander may turn away from its goal
WANDER_TICKS = 16  # ticks wander keeps one heading before choosing a new one
WANDER_SPEED = 0.45  # fraction of full speed while wandering


# Routing


def build_graph(observation: Mapping[str, object]) -> Graph:
    """Build a graph of the whole village: one node per walkable cell, one edge per legal step.

    Stepping onto slow ground (such as a field) costs more than stepping onto a road, so the
    route finder prefers roads when they are not much longer.
    """
    frame = layout.frame(observation)
    cells = set()
    step_costs = {}
    for y in range(int(frame["cells_y"])):
        for x in range(int(frame["cells_x"])):
            point = {"x": x, "y": y}
            if not layout.walkable(observation, point):
                continue
            cell = (x, y)
            cells.add(cell)
            # Road is full speed (1.0) and fields are half speed (0.5), so stepping onto a field
            # costs 2.0 and stepping onto a road costs 1.0.
            ground = layout.ground_at(observation, point)
            step_costs[cell] = 1.0 / layout.SPEED_LIMITS.get(ground or "", 1.0)

    edges: dict[Cell, list[tuple[Cell, float]]] = {cell: [] for cell in cells}
    for cell in cells:
        start = {"x": cell[0], "y": cell[1]}
        # Check only the east and north neighbors, and add each edge in both directions. That
        # covers every pair of neighboring cells exactly once.
        for dx, dy in ((1, 0), (0, 1)):
            end = (cell[0] + dx, cell[1] + dy)
            if end not in cells or not layout.can_step(observation, start, {"x": end[0], "y": end[1]}):
                continue
            edges[cell].append((end, step_costs[end]))
            edges[end].append((cell, step_costs[cell]))
    return {cell: tuple(steps) for cell, steps in edges.items()}


def go_to(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Walk toward a goal along the route graph, one cell at a time.

    The path is planned once and reused on later ticks. It is planned again when the destination
    changes, when the resident leaves the path, or when the resident stood still for a tick.
    """
    here = me.position(observation)
    start = _cell_here(observation)
    point = _goal_point(observation, goal)
    if point is None or start is None:
        return action.stand(me.heading(observation))
    graph = _graph(memory)
    state = _state(memory, "go_to")

    # The resident's position can fall in a cell that is not in the graph, such as a cell partly
    # covered by a wall or a prop. Step back to the last graph cell, or else the nearest one.
    if start not in graph:
        last_cell = state.get("last_cell")
        reentry = last_cell if isinstance(last_cell, tuple) and last_cell in graph else None
        if reentry is None or geometry.distance(here, _center(reentry)) > 2.0:
            reentry = _nearest_cell(graph, here)
        if reentry is None:
            return action.stand(me.heading(observation))
        return action.walk(geometry.heading_to(here, _center(reentry)))
    state["last_cell"] = start

    # Turn the goal into the nearest graph cell. That search looks at every cell, so the answer is
    # remembered for goals that never move: props, buildings, and fixed positions.
    destinations = cast("dict[object, Cell]", state.setdefault("destinations", {}))
    key = _destination_key(observation, goal)
    destination = destinations.get(key) if key is not None else None
    if destination is None:
        destination = _nearest_cell(graph, point)
        if destination is None:
            return action.stand(me.heading(observation))
        if key is not None:
            destinations[key] = destination

    # Standing in the same spot as last tick usually means something is in the way, so forget the
    # path and plan it again. The graph does not know where other villagers stand, so the new path
    # is often the same one. Making crowded cells cost more is one way to improve on this.
    previous_position = state.get("position")
    previous_destination = state.get("destination")
    if previous_position == here and previous_destination == destination:
        state.pop("path", None)
    state["position"] = dict(here)

    # Plan a new path when there is none, the destination changed, or the resident left the path.
    path = state.get("path")
    if previous_destination != destination or not isinstance(path, list) or start not in path:
        path = _route(graph, start, destination)
        state["path"] = path
    state["destination"] = destination
    if path is None or start == destination:
        return action.stand(me.heading(observation))

    # Walk toward the center of the next cell along the path.
    next_cell = path[path.index(start) + 1]
    return action.walk(geometry.heading_to(here, _center(next_cell)))


# Routines


def wander(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Drift toward a goal, turning a little now and then. Never returns ``None``.

    The agent also runs this whenever the planned routine returns ``None``. A building goal is the
    exception to drifting: wander walks straight there with ``go_to``. That is how a resident
    reaches the inn when ``gather_at`` finds nobody there yet, and how it walks home before
    ``sleep_at`` can start. At its own home, it heads for its own sleeping spot.
    """
    if isinstance(goal, str) and layout.building(observation, goal) is not None:
        route_goal = memory["home_point"] if goal == memory.get("home") else goal
        return go_to(observation, memory, route_goal)

    state = _state(memory, "wander")
    tick = day.tick(observation)
    point = _goal_point(observation, goal)
    heading = (
        me.heading(observation) if point is None else geometry.heading_to(me.position(observation), point)
    )
    # Every WANDER_TICKS ticks, pick a new heading: the direction of the goal, turned a little.
    if cast("int", state.get("until", -1)) <= tick:
        rng = cast("Random | None", memory.get("rng"))
        turn = rng.choice(WANDER_TURNS) if rng is not None else 0.0
        state["heading"] = (heading + turn) % 360.0
        state["until"] = tick + WANDER_TICKS
    return action.walk(cast("float", state.get("heading", heading)), WANDER_SPEED, "sweep")


def tend(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Walk to a prop and use it. The goal is a prop id. Returns ``None`` when it is not a prop."""
    target = _prop(observation, goal)
    if target is None:
        return None
    # The use command picks the nearest prop within reach with no wall in between. When that would
    # be this prop, use it.
    usable = props.usable(observation)
    if usable is not None and usable["id"] == target["id"]:
        return _settle_and_use(observation, memory, target)
    # Within reach, but the use command would pick something else (a wall is in the way, or
    # another prop is nearer). Shuffle to a better neighboring cell.
    if target in props.in_reach(observation):
        return _reposition_for_prop(observation, memory, target)
    # Still too far away: walk there.
    return go_to(observation, memory, target["id"])


def rest(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Sit on a free bench near the goal. Returns ``None`` when there is no free bench nearby."""
    point = _goal_point(observation, goal)
    if point is None:
        return None
    # A resident only knows the state of benches it can see, so any bench out of sight counts as
    # free until the resident gets close enough to look.
    states = {entry["prop"]: entry["state"] for entry in props.seen(observation)}
    benches = [
        item
        for item in props.all(observation)
        if item["type"] == "bench"
        and states.get(item["id"]) != "occupied"
        and geometry.distance(_prop_point(item), point) <= geometry.HEARING_RANGE
    ]
    if not benches:
        return None
    # Using a bench means sitting on it.
    return tend(observation, memory, benches[0]["id"])


def gather_at(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Stop and face someone at the meeting place, once they are close enough to hear.

    Returns ``None`` while nobody within hearing range is at the goal, so the agent's ``wander``
    fallback keeps walking toward it.
    """
    point = _goal_point(observation, goal)
    if point is None:
        return None
    here = me.position(observation)
    companions = [
        person
        for person in people.nearby(observation)
        if geometry.distance(person["position"], point) <= geometry.HEARING_RANGE
    ]
    if not companions:
        return None
    companion = min(companions, key=lambda person: geometry.distance(here, person["position"]))
    return action.stand(geometry.heading_to(here, companion["position"]))


def greet(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Wave once to a character in sight, then stay close enough to talk.

    The goal is a player id. Returns ``None`` when that character is not in sight.
    """
    target = _person(observation, goal, seen_only=True)
    if target is None:
        return None
    # The agent clears these notes whenever a new plan starts, so each greeting waves once.
    state = _state(memory, "greet")
    heading = geometry.heading_to(me.position(observation), target["position"])
    if not state.get("waved"):
        state["waved"] = True
        return action.stand(heading, "wave")
    if geometry.distance(me.position(observation), target["position"]) > geometry.HEARING_RANGE:
        return go_to(observation, memory, target["id"])
    return action.stand(heading)


def follow(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Stay about ``COMFORT_DISTANCE`` metres from a character, roughly matching their pace.

    The goal is a player id. Returns ``None`` when that character is neither seen nor heard.
    """
    target = _person(observation, goal)
    if target is None:
        return None
    distance = geometry.distance(me.position(observation), target["position"])
    # Too far: step toward them, a little faster than they moved last tick. Only characters in
    # sight report how far they moved, so a heard-only target gets full speed.
    if distance > COMFORT_DISTANCE + 0.75:
        speed = min(1.0, float(cast("float", target.get("moved", 0.75))) + 0.25)
        return _step_toward(observation, memory, _position_of(target), speed)
    # Too close: back away slowly.
    if distance < COMFORT_DISTANCE - 0.75:
        return _step_away(observation, memory, _position_of(target), goal, 0.5)
    # About right: stand and face them.
    return action.stand(geometry.heading_to(me.position(observation), target["position"]))


def avoid(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Back away, startled, from the closest person, then carry on toward the goal.

    Returns ``None`` when nobody is seen or heard.
    """
    candidates = (*people.seen(observation), *people.nearby(observation))
    if not candidates:
        return None
    here = me.position(observation)
    closest = min(candidates, key=lambda person: geometry.distance(here, person["position"]))
    if geometry.distance(here, closest["position"]) < COMFORT_DISTANCE + 1.0:
        return _step_away(observation, memory, _position_of(closest), goal, 0.8, "startle")
    return go_to(observation, memory, goal)


def watch(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Stand still, facing the goal. Never returns ``None``."""
    del memory  # watch needs no memory
    point = _goal_point(observation, goal)
    if point is None:
        return action.stand(me.heading(observation))
    return action.stand(geometry.heading_to(me.position(observation), point))


def sleep_at(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Sleep inside the goal building. The goal is a building id.

    Returns ``None`` while the resident is not yet inside, so the agent's ``wander`` fallback walks
    it there first.
    """
    del memory  # sleep_at needs no memory
    cell = layout.cell_at(observation, me.position(observation))
    building = layout.building(observation, str(goal))
    if cell is None or building is None or layout.ground_at(observation, cell) != "interior":
        return None
    # The interior ground must also belong to this building. A building's walls take up its
    # outermost ring of cells, so its floor runs from one cell inside each edge.
    width, height = layout.BUILDING_SIZES[str(building["type"])]
    origin = building["cell"]
    if not (
        int(origin["x"]) < int(cell["x"]) < int(origin["x"]) + width - 1
        and int(origin["y"]) < int(cell["y"]) < int(origin["y"]) + height - 1
    ):
        return None
    return action.stand(me.heading(observation), "sleep")


# Goal helpers for agent.py


def prop_goal(observation: Mapping[str, object], kind: str, offset: int = 0) -> str | None:
    """Return the id of one prop of a given type, or ``None`` when the village has none.

    Props of each type are counted in layout order, and ``offset`` picks one (wrapping around past
    the last one). Giving residents with the same job different offsets spreads them out.
    """
    matching = [str(item["id"]) for item in props.all(observation) if item["type"] == kind]
    return matching[offset % len(matching)] if matching else None


def building_slot_goal(observation: Mapping[str, object], building_id: str, slot: int) -> dict[str, float]:
    """Return a sleeping spot inside a building, keeping two residents of one home apart.

    Residents in slots 0 to 4 (``player_1`` to ``player_5``) each live in a different home, and
    slots 5 to 9 share those homes in the same order. The first resident sleeps near the home's
    southwest corner and the second near its northeast corner.
    """
    building = layout.building(observation, building_id)
    if building is None:
        return dict(me.position(observation))
    width, height = layout.BUILDING_SIZES[str(building["type"])]
    origin = building["cell"]
    second_resident = slot >= 5
    return {
        "x": float(origin["x"]) + (width - 2.5 if second_resident else 2.5),
        "y": float(origin["y"]) + (height - 2.5 if second_resident else 2.5),
    }


# Helpers used by the routines above


def _state(memory: dict[str, object], name: str) -> dict[str, object]:
    """Return one routine's private notes, creating them the first time."""
    routines = cast("dict[str, object]", memory.setdefault("routines", {}))
    return cast("dict[str, object]", routines.setdefault(name, {}))


def _graph(memory: dict[str, object]) -> Graph:
    """Return the route graph that ``agent.py`` built at reset."""
    return cast(Graph, memory.get("graph", {}))


def _cell_here(observation: Mapping[str, object]) -> Cell | None:
    """Return the cell the resident is standing in, or ``None`` outside the village."""
    cell = layout.cell_at(observation, me.position(observation))
    return None if cell is None else (int(cell["x"]), int(cell["y"]))


def _step_toward(
    observation: Mapping[str, object],
    memory: dict[str, object],
    target: Mapping[str, object],
    speed: float,
):
    """Step to the neighboring cell closest to a moving target, without planning a whole path."""
    choice = _best_neighbor(observation, memory, lambda cell: -geometry.distance(_center(cell), target))
    if choice is None:
        return go_to(observation, memory, target)
    return action.walk(geometry.heading_to(me.position(observation), _center(choice)), speed)


def _step_away(
    observation: Mapping[str, object],
    memory: dict[str, object],
    threat: Mapping[str, object],
    goal: object,
    speed: float,
    expression: str = "none",
):
    """Step to the neighboring cell farthest from a threat. Between equally far cells, prefer the
    one closer to the goal."""
    goal_point = _goal_point(observation, goal)

    def score(cell: Cell) -> tuple[float, float]:
        point = _center(cell)
        progress = 0.0 if goal_point is None else -geometry.distance(point, goal_point)
        return geometry.distance(point, threat), progress

    choice = _best_neighbor(observation, memory, score)
    if choice is None:
        return go_to(observation, memory, goal)
    return action.walk(geometry.heading_to(me.position(observation), _center(choice)), speed, expression)


def _best_neighbor(observation: Mapping[str, object], memory: dict[str, object], score) -> Cell | None:
    """Return the neighboring graph cell with the highest score, or ``None`` when off the graph."""
    start = _cell_here(observation)
    if start is None:
        return None
    neighbors = [neighbor for neighbor, _cost in _graph(memory).get(start, ())]
    return max(neighbors, key=score, default=None)


def _route(graph: Graph, start: Cell, destination: Cell) -> list[Cell] | None:
    """Find the cheapest path between two cells with A* search, or ``None`` when there is none.

    A* explores cells in order of the cost so far plus a guess of the cost still to go. The guess
    here is the number of steps in a straight grid line. Since no step costs less than 1.0, the
    guess never overestimates, which keeps the path A* finds the cheapest one.
    """
    if start not in graph or destination not in graph:
        return None
    # The queue holds (cost so far + guess, cost so far, cell), so the most promising cell comes
    # out first.
    queue = [(0.0, 0.0, start)]
    came_from: dict[Cell, Cell | None] = {start: None}
    costs = {start: 0.0}
    while queue:
        _priority, cost, cell = heapq.heappop(queue)
        if cell == destination:
            # Walk back from the destination to the start, then reverse.
            path = [cell]
            while (prior := came_from[path[-1]]) is not None:
                path.append(prior)
            return path[::-1]
        # A cheaper way to this cell was found after this entry was queued, so skip it.
        if cost != costs[cell]:
            continue
        for neighbor, step_cost in graph[cell]:
            candidate = cost + step_cost
            if candidate >= costs.get(neighbor, float("inf")):
                continue
            costs[neighbor] = candidate
            came_from[neighbor] = cell
            guess = abs(destination[0] - neighbor[0]) + abs(destination[1] - neighbor[1])
            heapq.heappush(queue, (candidate + guess, candidate, neighbor))
    return None


def _nearest_cell(graph: Graph, point: Mapping[str, object]) -> Cell | None:
    """Return the graph cell whose center is closest to a position."""
    return min(graph, key=lambda cell: geometry.distance(_center(cell), point), default=None)


def _destination_key(observation: Mapping[str, object], goal: object):
    """Return a key for remembering a goal's destination cell, or ``None`` for a goal that moves.

    Props, buildings, and fixed positions stay put. A person's destination changes as they walk.
    """
    if isinstance(goal, Mapping) and "x" in goal and "y" in goal:
        return "point", float(goal["x"]), float(goal["y"])
    if not isinstance(goal, str):
        return None
    if _prop(observation, goal) is not None or layout.building(observation, goal) is not None:
        return "static", goal
    return None


def _reposition_for_prop(
    observation: Mapping[str, object], memory: dict[str, object], target: Mapping[str, object]
):
    """Step to the neighboring cell with a clear view of a prop, closest to it."""
    here = me.position(observation)
    start = _cell_here(observation)
    if start is None:
        return action.stand(me.heading(observation))
    point = _prop_point(target)
    candidates = [neighbor for neighbor, _cost in _graph(memory).get(start, ())]
    if not candidates:
        return action.stand(me.heading(observation))
    destination = min(
        candidates,
        key=lambda cell: (
            not layout.line_of_sight(observation, _center(cell), point),  # clear view first
            geometry.distance(_center(cell), point),  # then closest
            cell,  # then a fixed order, so ties always break the same way
        ),
    )
    return action.walk(geometry.heading_to(here, _center(destination)))


def _settle_and_use(
    observation: Mapping[str, object], memory: dict[str, object], target: Mapping[str, object]
):
    """Walk to the center of the current cell, then use the prop.

    Positions in the observation are rounded. At the very edge of reach, ``props.usable`` can say
    yes while the game does not. Settling at the cell center first (nudged 2 cm toward the prop)
    makes the use command land.
    """
    here = me.position(observation)
    cell = _cell_here(observation)
    if cell is not None and cell in _graph(memory):
        center = _center(cell)
        point = _prop_point(target)
        toward_target = geometry.distance(center, point)
        destination = dict(center)
        if toward_target > 0:
            destination = {
                "x": center["x"] + 0.02 * (point["x"] - center["x"]) / toward_target,
                "y": center["y"] + 0.02 * (point["y"] - center["y"]) / toward_target,
            }
        distance = geometry.distance(here, destination)
        if distance > 0.005:
            # Speed is a fraction of this ground's speed limit. Slow down on the last step so it
            # lands on the spot instead of overshooting.
            ground = layout.ground_at(observation, {"x": cell[0], "y": cell[1]})
            speed_limit = layout.SPEED_LIMITS.get(ground or "", 1.0)
            speed = min(0.5, distance / speed_limit)
            return action.walk(geometry.heading_to(here, destination), speed)
    return action.stand(me.heading(observation), "use")


def _goal_point(observation: Mapping[str, object], goal: object) -> Mapping[str, object] | None:
    """Return the position a goal refers to, or ``None`` when it cannot be found.

    A prop or building goal means its center, and a player id means where that character is, if
    this resident can see or hear them.
    """
    if isinstance(goal, Mapping) and "x" in goal and "y" in goal:
        return goal
    if not isinstance(goal, str):
        return None
    prop = _prop(observation, goal)
    if prop is not None:
        return _prop_point(prop)
    building = layout.building(observation, goal)
    if building is not None:
        return _building_point(building)
    person = _person(observation, goal)
    return None if person is None else _position_of(person)


def _prop(observation: Mapping[str, object], goal: object) -> Mapping[str, object] | None:
    """Return the prop with this id, or ``None``."""
    return next((item for item in props.all(observation) if item["id"] == goal), None)


def _person(
    observation: Mapping[str, object], goal: object, *, seen_only: bool = False
) -> Mapping[str, object] | None:
    """Return the character with this id if they are seen (or, unless ``seen_only``, heard)."""
    records = (
        people.seen(observation) if seen_only else (*people.seen(observation), *people.nearby(observation))
    )
    return next((item for item in records if item["id"] == goal), None)


def _position_of(item: Mapping[str, object]) -> Mapping[str, object]:
    return cast("Mapping[str, object]", item["position"])


def _prop_point(item: Mapping[str, object]) -> dict[str, float]:
    """Return the center of a prop's anchor cell."""
    cell = cast(Mapping[str, float], item["cell"])
    return {"x": cell["x"] + 0.5, "y": cell["y"] + 0.5}


def _building_point(building: Mapping[str, object]) -> dict[str, float]:
    """Return the center of a building's footprint."""
    width, height = layout.BUILDING_SIZES[str(building["type"])]
    cell = cast(Mapping[str, float], building["cell"])
    return {"x": cell["x"] + width / 2, "y": cell["y"] + height / 2}


def _center(cell: Cell) -> dict[str, float]:
    """Return the position at the middle of a cell."""
    return {"x": cell[0] + 0.5, "y": cell[1] + 0.5}
