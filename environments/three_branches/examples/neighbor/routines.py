"""Small, replaceable routines for the Season 4 village example.

The graph is deliberately simple. It is built from the public cell helpers at reset, then each
villager keeps its own copy in memory. Students can replace this route finder without changing
the routine interface.
"""

from __future__ import annotations

import heapq
from collections.abc import Mapping

from sandbox.village import action, geometry, layout, me, people, props

Cell = tuple[int, int]
Graph = dict[Cell, tuple[tuple[Cell, float], ...]]

_FORWARD_DIRECTIONS = ((0, 1), (1, 0))
_COMFORT_DISTANCE = 3.0
_BUILDING_SIZES = {"home": (8, 7), "inn": (12, 10), "shed": (8, 8)}


def build_graph(observation: Mapping[str, object]) -> Graph:
    """Build one whole-village graph from walkable cells and legal cell-to-cell steps."""
    frame = layout.frame(observation)
    cells = set()
    ground_speeds = {}
    for y in range(int(frame["cells_y"])):
        for x in range(int(frame["cells_x"])):
            point = {"x": x, "y": y}
            if not layout.walkable(observation, point):
                continue
            cell = (x, y)
            cells.add(cell)
            ground = layout.ground_at(observation, point)
            ground_speeds[cell] = layout.SPEED_LIMITS.get(ground or "", 1.0)
    mutable_graph: dict[Cell, list[tuple[Cell, float]]] = {cell: [] for cell in cells}
    for cell in cells:
        start = {"x": cell[0], "y": cell[1]}
        for dx, dy in _FORWARD_DIRECTIONS:
            end = (cell[0] + dx, cell[1] + dy)
            if end not in cells or not layout.can_step(observation, start, {"x": end[0], "y": end[1]}):
                continue
            mutable_graph[cell].append((end, 1.0 / ground_speeds[end]))
            mutable_graph[end].append((cell, 1.0 / ground_speeds[cell]))
    return {cell: tuple(edges) for cell, edges in mutable_graph.items()}


def go_to(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Walk one graph edge toward a semantic goal, replanning after a movement stall."""
    point = _goal_point(observation, goal)
    here = me.position(observation)
    here_cell = layout.cell_at(observation, here)
    graph = memory.get("graph")
    if point is None or here_cell is None or not isinstance(graph, dict):
        return action.stand(me.heading(observation))
    start = (int(here_cell["x"]), int(here_cell["y"]))
    state = _state(memory, "go_to")
    if start not in graph:
        last_cell = state.get("last_cell")
        reentry = last_cell if isinstance(last_cell, tuple) and last_cell in graph else None
        if reentry is None or geometry.distance(here, _center(reentry)) > 2.0:
            reentry = _nearest_cell(graph, here)
        if reentry is None:
            return action.stand(me.heading(observation))
        return action.walk(geometry.heading_to(here, _center(reentry)))
    state["last_cell"] = start
    destinations = state.setdefault("destinations", {})
    cache_key = _destination_key(observation, goal)
    destination = destinations.get(cache_key) if cache_key is not None else None
    if destination is None:
        destination = _nearest_cell(graph, point)
        if cache_key is not None and destination is not None:
            destinations[cache_key] = destination
    if destination is None:
        return action.stand(me.heading(observation))
    previous = state.get("position")
    previous_destination = state.get("destination")
    if previous == here and previous_destination == destination:
        state.pop("path", None)
    state["position"] = dict(here)
    path = state.get("path")
    if previous_destination != destination or not isinstance(path, list) or start not in path:
        path = _route(graph, start, destination)
        state["path"] = path
    state["destination"] = destination
    if path is None or start == destination:
        return action.stand(me.heading(observation))
    step_index = path.index(start) + 1
    if step_index >= len(path):
        return action.stand(me.heading(observation))
    next_cell = path[step_index]
    if not any(neighbor == next_cell for neighbor, _cost in graph.get(start, ())):
        state.pop("path", None)
        return action.stand(me.heading(observation))
    return action.walk(geometry.heading_to(here, _center(next_cell)))


def wander(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Drift toward a goal while changing heading periodically. This is the dispatch fallback."""
    if isinstance(goal, str) and layout.building(observation, goal) is not None:
        route_goal = memory.get("home_point", goal) if goal == memory.get("home") else goal
        return go_to(observation, memory, route_goal)
    state = _state(memory, "wander")
    tick = int(observation["tick"])
    point = _goal_point(observation, goal)
    heading = (
        me.heading(observation) if point is None else geometry.heading_to(me.position(observation), point)
    )
    if state.get("until", -1) <= tick:
        rng = memory.get("rng")
        turn = rng.choice((-45.0, -20.0, 0.0, 20.0, 45.0)) if rng is not None else 0.0
        state["heading"] = (heading + turn) % 360.0
        state["until"] = tick + 16
    return action.walk(float(state.get("heading", heading)), 0.45, "sweep")


def tend(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Walk to a named prop and hold its use action when the engine selects it."""
    target = _prop(observation, goal)
    if target is None:
        return None
    usable = props.usable(observation)
    if usable is not None and usable["id"] == target["id"]:
        return _settle_and_use(observation, memory, target)
    if target in props.in_reach(observation):
        return _reposition_for_prop(observation, memory, target)
    return go_to(observation, memory, target["id"])


def rest(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Use an empty bench near the scheduled meeting place."""
    point = _goal_point(observation, goal)
    if point is None:
        return None
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
    return tend(observation, memory, benches[0]["id"])


def gather_at(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Face a person already near the goal, once both villagers can hear each other."""
    point = _goal_point(observation, goal)
    if point is None:
        return None
    companions = [
        person
        for person in people.nearby(observation)
        if geometry.distance(person["position"], point) <= geometry.HEARING_RANGE
    ]
    if not companions:
        return None
    companion = min(
        companions, key=lambda person: geometry.distance(me.position(observation), person["position"])
    )
    return action.stand(geometry.heading_to(me.position(observation), companion["position"]))


def greet(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Wave once to a character in sight, then hold a nearby conversational station."""
    target = _person(observation, goal, seen_only=True)
    if target is None:
        return None
    state = _state(memory, "greet")
    if state.get("target") != target["id"]:
        state.clear()
        state["target"] = target["id"]
    heading = geometry.heading_to(me.position(observation), target["position"])
    if not state.get("waved"):
        state["waved"] = True
        return action.stand(heading, "wave")
    if geometry.distance(me.position(observation), target["position"]) > geometry.HEARING_RANGE:
        return go_to(observation, memory, target["id"])
    return action.stand(heading)


def follow(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Keep a heard or seen character about three metres away, matching their pace."""
    target = _person(observation, goal)
    if target is None:
        return None
    distance = geometry.distance(me.position(observation), target["position"])
    heading = geometry.heading_to(me.position(observation), target["position"])
    if distance > _COMFORT_DISTANCE + 0.75:
        return _graph_step_toward(
            observation,
            memory,
            target["position"],
            min(1.0, float(target.get("moved", 0.75)) + 0.25),
        )
    if distance < _COMFORT_DISTANCE - 0.75:
        return _graph_step_away(observation, memory, target["position"], goal, 0.5)
    return action.stand(heading)


def avoid(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Open distance from the closest perceived person, then resume the scheduled route."""
    candidates = (*people.seen(observation), *people.nearby(observation))
    if not candidates:
        return None
    target = min(
        candidates, key=lambda person: geometry.distance(me.position(observation), person["position"])
    )
    if geometry.distance(me.position(observation), target["position"]) < _COMFORT_DISTANCE + 1.0:
        return _graph_step_away(observation, memory, target["position"], goal, 0.8, "startle")
    return go_to(observation, memory, goal)


def watch(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Hold still while facing the scheduled place."""
    del memory
    point = _goal_point(observation, goal)
    if point is None:
        return action.stand(me.heading(observation))
    return action.stand(geometry.heading_to(me.position(observation), point))


def sleep_at(observation: Mapping[str, object], memory: dict[str, object], goal: object):
    """Sleep while on interior ground after routing to the assigned home."""
    del memory
    cell = layout.cell_at(observation, me.position(observation))
    building = layout.building(observation, str(goal))
    if cell is None or building is None or layout.ground_at(observation, cell) != "interior":
        return None
    width, height = _BUILDING_SIZES.get(str(building["type"]), (0, 0))
    origin = building["cell"]
    if not (
        int(origin["x"]) < int(cell["x"]) < int(origin["x"]) + width - 1
        and int(origin["y"]) < int(cell["y"]) < int(origin["y"]) + height - 1
    ):
        return None
    return action.stand(me.heading(observation), "sleep")


def prop_goal(observation: Mapping[str, object], kind: str, offset: int = 0) -> str | None:
    """Choose one static prop in layout order, spreading equal jobs around the village."""
    matching = [item["id"] for item in props.all(observation) if item["type"] == kind]
    return matching[offset % len(matching)] if matching else None


def building_slot_goal(observation: Mapping[str, object], building_id: str, slot: int) -> dict[str, float]:
    """Choose one of two separated interior points for residents who share a home."""
    building = layout.building(observation, building_id)
    if building is None:
        return dict(me.position(observation))
    width, height = _BUILDING_SIZES.get(str(building["type"]), (1, 1))
    origin = building["cell"]
    second_resident = slot >= 5
    return {
        "x": float(origin["x"]) + (width - 2.5 if second_resident else 2.5),
        "y": float(origin["y"]) + (height - 2.5 if second_resident else 2.5),
    }


def _state(memory: dict[str, object], name: str) -> dict[str, object]:
    routines = memory.setdefault("routines", {})
    return routines.setdefault(name, {})


def _graph_step_toward(
    observation: Mapping[str, object],
    memory: dict[str, object],
    target: Mapping[str, object],
    speed: float,
):
    choice = _best_neighbor(observation, memory, lambda cell: -geometry.distance(_center(cell), target))
    if choice is None:
        return go_to(observation, memory, target)
    return action.walk(geometry.heading_to(me.position(observation), _center(choice)), speed)


def _graph_step_away(
    observation: Mapping[str, object],
    memory: dict[str, object],
    threat: Mapping[str, object],
    goal: object,
    speed: float,
    expression: str = "none",
):
    goal_point = _goal_point(observation, goal)

    def score(cell: Cell) -> tuple[float, float]:
        point = _center(cell)
        progress = 0.0 if goal_point is None else -geometry.distance(point, goal_point)
        return geometry.distance(point, threat), progress

    choice = _best_neighbor(observation, memory, score)
    if choice is None:
        return go_to(observation, memory, goal)
    return action.walk(geometry.heading_to(me.position(observation), _center(choice)), speed, expression)


def _best_neighbor(observation: Mapping[str, object], memory: dict[str, object], score):
    graph = memory.get("graph")
    here_cell = layout.cell_at(observation, me.position(observation))
    if not isinstance(graph, dict) or here_cell is None:
        return None
    start = (int(here_cell["x"]), int(here_cell["y"]))
    neighbors = [neighbor for neighbor, _cost in graph.get(start, ())]
    return max(neighbors, key=score, default=None)


def _route(graph: Graph, start: Cell, destination: Cell) -> list[Cell] | None:
    if start not in graph or destination not in graph:
        return None
    queue = [(0.0, 0.0, start)]
    previous: dict[Cell, Cell | None] = {start: None}
    costs = {start: 0.0}
    while queue:
        _score, cost, cell = heapq.heappop(queue)
        if cell == destination:
            path = [cell]
            while previous[path[-1]] is not None:
                path.append(previous[path[-1]])
            return list(reversed(path))
        if cost != costs[cell]:
            continue
        for neighbor, edge_cost in graph[cell]:
            candidate = cost + edge_cost
            if candidate >= costs.get(neighbor, float("inf")):
                continue
            costs[neighbor] = candidate
            previous[neighbor] = cell
            estimate = abs(destination[0] - neighbor[0]) + abs(destination[1] - neighbor[1])
            heapq.heappush(queue, (candidate + estimate, candidate, neighbor))
    return None


def _nearest_cell(graph: Graph, point: Mapping[str, object]) -> Cell | None:
    return min(graph, key=lambda cell: geometry.distance(_center(cell), point), default=None)


def _destination_key(observation: Mapping[str, object], goal: object):
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
    graph = memory.get("graph")
    here = me.position(observation)
    here_cell = layout.cell_at(observation, here)
    if not isinstance(graph, dict) or here_cell is None:
        return action.stand(me.heading(observation))
    start = (int(here_cell["x"]), int(here_cell["y"]))
    point = _prop_point(target)
    candidates = [neighbor for neighbor, _cost in graph.get(start, ())]
    if not candidates:
        return action.stand(me.heading(observation))
    destination = min(
        candidates,
        key=lambda cell: (
            not layout.line_of_sight(observation, _center(cell), point),
            geometry.distance(_center(cell), point),
            cell,
        ),
    )
    return action.walk(geometry.heading_to(here, _center(destination)))


def _settle_and_use(
    observation: Mapping[str, object], memory: dict[str, object], target: Mapping[str, object]
):
    """Reach the routed cell center before use so perceived rounding cannot issue an early command."""
    graph = memory.get("graph")
    here = me.position(observation)
    here_cell = layout.cell_at(observation, here)
    if isinstance(graph, dict) and graph and here_cell is not None:
        cell = (int(here_cell["x"]), int(here_cell["y"]))
        if cell in graph:
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
                ground = layout.ground_at(observation, here_cell)
                speed_limit = layout.SPEED_LIMITS.get(ground or "", 1.0)
                speed = min(0.5, distance / speed_limit)
                return action.walk(geometry.heading_to(here, destination), speed)
    return action.stand(me.heading(observation), "use")


def _goal_point(observation: Mapping[str, object], goal: object):
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
    return None if person is None else person["position"]


def _prop(observation: Mapping[str, object], goal: object):
    return next((item for item in props.all(observation) if item["id"] == goal), None)


def _person(observation: Mapping[str, object], goal: object, *, seen_only: bool = False):
    records = (
        people.seen(observation) if seen_only else (*people.seen(observation), *people.nearby(observation))
    )
    return next((item for item in records if item["id"] == goal), None)


def _prop_point(item: Mapping[str, object]) -> dict[str, float]:
    cell = item["cell"]
    return {"x": float(cell["x"]) + 0.5, "y": float(cell["y"]) + 0.5}


def _building_point(building: Mapping[str, object]) -> dict[str, float]:
    width, height = _BUILDING_SIZES.get(str(building["type"]), (1, 1))
    cell = building["cell"]
    return {"x": float(cell["x"]) + width / 2, "y": float(cell["y"]) + height / 2}


def _center(cell: Cell) -> dict[str, float]:
    return {"x": cell[0] + 0.5, "y": cell[1] + 0.5}
