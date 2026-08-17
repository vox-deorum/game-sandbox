"""A visible village routine: wander a quarter, then tend one kind of prop."""

from sandbox.observation_types import ThreeBranchesAction, ThreeBranchesObservation
from sandbox.village import action, day, geometry, layout, me, props

IDLE_TICKS = 12
# N, E, S, W is also the deterministic tie-break order for equally good safe moves.
DIRECTIONS = ((0, 1), (1, 0), (0, -1), (-1, 0))


def _cell(item: object) -> dict[str, int]:
    assert isinstance(item, dict)
    cell = item["cell"]
    assert isinstance(cell, dict)
    return cell


def _centre(cell: dict[str, int]) -> dict[str, float]:
    return {"x": cell["x"] + 0.5, "y": cell["y"] + 0.5}


def _quarter(cell: dict[str, int], frame: dict[str, int | float]) -> int:
    """Number village quarters southwest, southeast, northwest, northeast."""

    east = cell["x"] >= int(frame["cells_x"]) // 2
    north = cell["y"] >= int(frame["cells_y"]) // 2
    return int(east) + 2 * int(north)


class Agent:
    """Gives each villager a seeded prop role and one village quarter."""

    def reset(self, seed: int, observation: ThreeBranchesObservation) -> None:
        """Assign a stable role, quarter, and layout-order target for this day."""

        rng = me.rng(observation, seed)
        self._role = rng.choice(tuple(props.TYPES))
        self._quarter = rng.randrange(4)
        matching = [prop for prop in props.all(observation) if prop["type"] == self._role]
        in_quarter = [
            prop for prop in matching if _quarter(_cell(prop), layout.frame(observation)) == self._quarter
        ]
        candidates = in_quarter or matching
        self._target = candidates[0] if candidates else None
        self._idle_offset = rng.randrange(IDLE_TICKS)

    def act(self, observation: ThreeBranchesObservation) -> ThreeBranchesAction:
        """Sweep while idling, safely approach the role prop, then use it when in reach."""

        here = me.position(observation)
        heading = me.heading(observation)
        target = self._target
        if target is None:
            return action.stand(heading, "sweep")
        usable = props.usable(observation)
        if usable is not None and usable["id"] == target["id"]:
            return action.stand(heading, "use")
        if (day.tick(observation) + self._idle_offset) % IDLE_TICKS == 0:
            return action.stand(heading, "sweep")

        here_cell = layout.cell_at(observation, here)
        if here_cell is None:
            return action.stand(heading, "sweep")
        goal = _centre(_cell(target))
        best = here_cell
        best_distance = geometry.distance(_centre(here_cell), goal)
        for dx, dy in DIRECTIONS:
            candidate = {"x": here_cell["x"] + dx, "y": here_cell["y"] + dy}
            if not layout.walkable(observation, candidate):
                continue
            if not layout.can_step(observation, here_cell, candidate):
                continue
            distance = geometry.distance(_centre(candidate), goal)
            if distance < best_distance:
                best, best_distance = candidate, distance

        if best == here_cell:
            return action.stand(heading, "sweep")
        return action.walk(geometry.heading_to(here, _centre(best)), 1.0, "sweep")
