"""The template's bolder sibling: march on enemy ground instead of walking straight ahead.

The template walks its ``direction`` digit until something comes into view, which is a straight
line: two units on rows farther apart than they can see walk right past each other. This one aims
somewhere instead. Each unit remembers the tile it spawned on, its one piece of episode state, and
marches on that tile's mirror image. The field is point-symmetric, so the mirror of your own
starting ground is always enemy starting ground, and a side that marches on it sweeps the field
rather than crossing it.

The fighting half is the template's, unchanged: step at the nearest enemy in sight and name it.
So are its weaknesses. It only ever takes single steps, so cavalry wastes three of its four
movement points; it never fires from range with the archer; and it walks into melee alone. Those
are what the worked example ``vanguard`` fixes.
"""

from __future__ import annotations

from sandbox.crane import action, me, tile, visible
from sandbox.observation_types import AxialPosition, SkirmishAction, SkirmishObservation, VisibleUnit


def _step_toward(observation: SkirmishObservation, goal: AxialPosition) -> int:
    """Return the single step that most closes the gap to ``goal``, or 0 when none does."""
    here = me.position(observation)

    # Standing still is path id 0. A step has to beat its distance to be worth taking. Only
    # single steps are tried, so cavalry wastes most of its speed, just as the template does.
    best_step = 0
    best_distance = tile.distance(here, goal)

    for step in action.legal_steps(observation):
        # at_path_end says where a step would land us, so this is the distance after it.
        step_distance = tile.distance(tile.at_path_end(here, step), goal)
        if step_distance < best_distance:
            best_step, best_distance = step, step_distance

    return best_step


class Agent:
    """Marches on the mirror of its spawn tile, then steps at the nearest enemy it can see."""

    def reset(self, seed: int) -> None:
        # The one thing this unit remembers all match: the tile it started on. reset runs before
        # every match, so last match's tile is never carried into this one.
        self._home: AxialPosition | None = None

    def act(self, observation: SkirmishObservation) -> SkirmishAction:
        # The first activation is our only chance to see the spawn tile, so record it now.
        if self._home is None:
            self._home = me.position(observation)

        # Two modes, and what the unit **can see** decides which one runs.
        enemies = visible.enemies(observation)
        if enemies:
            return self._attack(observation, enemies)
        return self._march(observation, self._home)

    def _march(self, observation: SkirmishObservation, home: AxialPosition) -> SkirmishAction:
        """Nothing in sight: one step toward the mirror of our spawn, deep in enemy ground."""
        # at_mirror reflects a position through the middle of the field. The field is symmetric,
        # so the mirror of our own spawn is always enemy starting ground.
        step = _step_toward(observation, tile.at_mirror(home, observation))

        # Standing still is always legal, and it still attacks whatever walks into range.
        return action.move(step) if step else action.stay()

    def _attack(self, observation: SkirmishObservation, enemies: list[VisibleUnit]) -> SkirmishAction:
        """Close on the nearest enemy in sight and name it, so the strike prefers that one."""
        here = me.position(observation)

        # The closest enemy in sight. min hands back the unit itself, not the distance.
        nearest = min(enemies, key=lambda enemy: tile.distance(here, enemy["position"]))
        step = _step_toward(observation, nearest["position"])

        # Anything we can see we can name, so both orders below are legal.
        if step == 0:
            return action.stay(nearest["unit_id"], observation)
        return action.move(step, nearest["unit_id"], observation)
