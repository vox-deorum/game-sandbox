"""Routing: find a walking path across the village with A* search.

``build_graph`` turns every walkable cell of the village into a graph node once, at reset, and
``path`` searches that graph for the cheapest path between two cells. ``go_to`` in ``routines.py``
is the only caller. You may change how the graph is built or replace the search, as long as
``path`` keeps the same shape.
"""

from __future__ import annotations

import heapq
from collections.abc import Mapping

from sandbox.village import layout

# A cell is an (x, y) pair of grid indices. Cells are one metre square, so cell (3, 7) covers the
# positions from (3.0, 7.0) up to (4.0, 8.0).
Cell = tuple[int, int]
# Each cell maps to the cells one step away and the cost of stepping there.
Graph = dict[Cell, tuple[tuple[Cell, float], ...]]


def build_graph(observation: Mapping[str, object]) -> Graph:
    """Build a graph of the whole village: one node per walkable cell, one edge per legal step.

    Stepping onto slow ground (such as a field) costs more than stepping onto a road, so the
    route finder prefers roads when they are not much longer.
    """
    frame = layout.frame(observation)
    step_costs = {}
    for y in range(int(frame["cells_y"])):
        for x in range(int(frame["cells_x"])):
            point = {"x": x, "y": y}
            if layout.walkable(observation, point):
                # Road is full speed (1.0) and fields are half speed (0.5), so stepping onto a
                # field costs 2.0 and stepping onto a road costs 1.0.
                ground = layout.ground_at(observation, point)
                step_costs[(x, y)] = 1.0 / layout.SPEED_LIMITS.get(ground or "", 1.0)

    edges: dict[Cell, list[tuple[Cell, float]]] = {cell: [] for cell in step_costs}
    for cell in step_costs:
        # Check only the east and north neighbors, and add each edge in both directions. That
        # covers every pair of neighboring cells exactly once.
        for end in ((cell[0] + 1, cell[1]), (cell[0], cell[1] + 1)):
            if end in step_costs and layout.can_step(
                observation, {"x": cell[0], "y": cell[1]}, {"x": end[0], "y": end[1]}
            ):
                edges[cell].append((end, step_costs[end]))
                edges[end].append((cell, step_costs[cell]))
    return {cell: tuple(steps) for cell, steps in edges.items()}


def path(graph: Graph, start: Cell, end: Cell) -> list[Cell] | None:
    """Return the cheapest path from ``start`` to ``end``, both included, or ``None`` when there is none.

    A* explores cells in order of the cost so far plus a guess of the cost still to go. The guess
    here is the number of steps in a straight grid line. Since no step costs less than 1.0, the
    guess never overestimates, which keeps the path A* finds the cheapest one.
    """
    if start not in graph or end not in graph:
        return None
    # The queue holds (cost so far + guess, cost so far, cell), so the most promising cell comes
    # out first.
    queue = [(0.0, 0.0, start)]
    came_from: dict[Cell, Cell | None] = {start: None}
    costs = {start: 0.0}
    while queue:
        _priority, cost, cell = heapq.heappop(queue)
        if cell == end:
            # Walk back from the end to the start, then reverse.
            steps = [cell]
            while (prior := came_from[steps[-1]]) is not None:
                steps.append(prior)
            return steps[::-1]
        # A cheaper way to this cell was found after this entry was queued, so skip it.
        if cost != costs[cell]:
            continue
        for neighbor, step_cost in graph[cell]:
            candidate = cost + step_cost
            if candidate >= costs.get(neighbor, float("inf")):
                continue
            costs[neighbor] = candidate
            came_from[neighbor] = cell
            guess = abs(end[0] - neighbor[0]) + abs(end[1] - neighbor[1])
            heapq.heappush(queue, (candidate + guess, candidate, neighbor))
    return None
