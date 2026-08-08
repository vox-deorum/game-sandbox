"""A worked Skirmish at Crane Reach agent: one small state machine per unit type.

Every unit on a side runs its own copy of this class with no shared memory, so the policies
below coordinate through nothing but what they can see. Four habits do the work:

- Everyone takes up a station around the middle of the field, the melee in front and the
  archers a few tiles behind, and units that see each other close up. The detachment fights
  as a group instead of arriving one unit at a time.
- Nobody walks into a melee alone. Whoever we end up beside strikes back, so a unit fights
  when a friend is close enough to join in, and otherwise lets the enemy come to the line.
  Enemy archers are the exception: they never come, so we go to them.
- Nobody leaves the battle area to chase. An enemy that runs off comes back on its own.
- Everyone concentrates on the same enemy, the weakest one it can see (which is the enemy
  archer while everybody is fresh), so wounded enemies die instead of lingering.

The type policies are module-level functions, one per unit type, each an explicit state
machine whose current state is remembered in :class:`Memory`:

- ``archer_order``: advance, fire, fall_back. It opens distance from whatever is closing on
  it and still fires in the same activation, because a path and a strike are one order.
- ``cavalry_order``: advance, charge, flank. It rides to a tile beside its victim, preferring
  a long approach (the charge shape) and a tile no other enemy stands next to.
- ``footman_order``: engage, screen, advance. It fights what comes into reach and otherwise
  holds a tile beside the friendly archer, shoulder to shoulder with another footman when
  one is there.

Advance is the resting state: take up station, whether because nothing is in sight yet or
because the fight in front of us is not one to join alone. A footman with someone to guard
screens instead, since standing beside the archer is already its station.

Everything is built from the ``sandbox.crane`` helpers: paths come from ``legal_paths`` and
targets from ``nameable_targets``, so every order this file returns is legal by construction.
"""

from __future__ import annotations

import random
from collections.abc import Callable

from sandbox.crane import DIRECTIONS, decode_path, distance, legal_paths, move, nameable_targets, stay
from sandbox.observation_types import (
    AxialPosition,
    SkirmishAction,
    SkirmishObservation,
    VisibleUnit,
)

# The states each unit type moves between. The unit's current one lives in its Memory.
ADVANCE = "advance"
FIRE = "fire"
FALL_BACK = "fall_back"
CHARGE = "charge"
FLANK = "flank"
ENGAGE = "engage"
SCREEN = "screen"

ARCHER_RANGE = 6  # the archer's attack range, from the ruleset
ARCHER_COMFORT = 4  # an enemy closer than this puts the archer into fall_back
# The two rings the detachment forms up on, counted out from the middle of the field. The melee
# gathers one tile out, and the archers hold the back rim of the battle area, as far behind the
# fighting as they can stand and still cover it. Both scale with the field, so the same policy
# plays a small skirmish and a big battle.
MELEE_LINE = 1
BATTLE_MARGIN = 2  # the battle area stops this many tiles short of the field edge
CHARGE_DISTANCE = 3  # start-to-end displacement that earns the cavalry charge bonus
SCREEN_DISTANCE = 1  # how far from the archer the footman wants to stand
RALLY_RADIUS = 2  # how close to its station a unit has to be to count as arrived
PATIENCE = 8  # activations spent waiting at station before pushing into the enemy half
SUPPORT_RANGE = 3  # how near an ally has to be to the enemy to count as joining the fight
COHESION_RANGE = 2  # how close to a friend a unit tries to stand while it waits
# Whom to kill first among enemies on equal hit points. Archers are the softest and hit from
# the farthest away, so they are always worth removing before anything else.
TYPE_ORDER = {"archer": 0, "cavalry": 1, "footman": 2}
# Each type's damage, from the ruleset. A unit uses its own to recognize a finishing blow.
DAMAGE = {"footman": 3, "archer": 2, "cavalry": 3}


class Memory:
    """One unit's memory for one match: its tie-breaker, its spawn tile, and its state."""

    def __init__(self, seed: int = 0) -> None:
        self.rng = random.Random(seed)
        self.home: AxialPosition | None = None
        self.state: str = ADVANCE
        self.idle = 0  # consecutive activations with no enemy in sight


class _View:
    """The parts of one activation the policies below read, unpacked once."""

    def __init__(self, observation: SkirmishObservation, memory: Memory) -> None:
        state = observation["observation"]
        self.observation = observation
        self.unit = state["self"]
        self.side = self.unit["unit_id"].split("_", 1)[0]
        self.position = self.unit["position"]
        self.enemies = tuple(unit for unit in state["visible_units"] if unit["side"] != self.side)
        self.allies = tuple(unit for unit in state["visible_units"] if unit["side"] == self.side)
        self.nameable = frozenset(nameable_targets(observation))
        self.endpoints = _endpoints(observation, self.position)
        self.field_side = state["battlefield"]["side"]
        middle = (self.field_side - 1) // 2
        self.center: AxialPosition = {"q": middle, "r": middle}
        # The ground worth fighting over, and the two rings the detachment forms up on. The
        # smallest field the game allows has extent 5, so the battle area is never degenerate.
        self.battle_radius = state["parameters"]["field_extent"] - BATTLE_MARGIN
        self.melee_station = MELEE_LINE
        self.archer_station = self.battle_radius
        if memory.home is None:
            memory.home = self.position
        memory.idle = 0 if self.enemies else memory.idle + 1


# -- reading the reachable tiles ---------------------------------------------------------------


def _walk(position: AxialPosition, path_id: int) -> AxialPosition:
    """Return the tile a path ends on, stepping one direction digit at a time."""
    q, r = position["q"], position["r"]
    for digit in decode_path(path_id):
        dq, dr = DIRECTIONS[digit]
        q, r = q + dq, r + dr
    return {"q": q, "r": r}


def _endpoints(observation: SkirmishObservation, position: AxialPosition) -> dict[tuple[int, int], int]:
    """Map every tile this activation can end on to the shortest legal path that ends there.

    Several paths reach the same tile. Path ids are numbered shortest first, and ``legal_paths``
    hands them over in ascending order, so the first id that reaches a tile is the shortest way
    there: the fewest tiles entered, and the least of whatever those tiles cost.
    """
    chosen: dict[tuple[int, int], int] = {}
    for path_id in legal_paths(observation):
        end = _walk(position, path_id)
        chosen.setdefault((end["q"], end["r"]), path_id)
    return chosen


def _tile(coordinates: tuple[int, int]) -> AxialPosition:
    """Turn an endpoint key back into the position shape the helpers read."""
    return {"q": coordinates[0], "r": coordinates[1]}


Score = Callable[[AxialPosition], tuple[int, ...]]


def _best(view: _View, memory: Memory, tiles: list[tuple[int, int]], score: Score) -> int:
    """Return the path id of the best scoring tile among ``tiles``, breaking ties at random."""
    ranked = {tile: score(_tile(tile)) for tile in tiles}
    best = max(ranked.values())
    return view.endpoints[memory.rng.choice(sorted(tile for tile in ranked if ranked[tile] == best))]


def _pick(view: _View, memory: Memory, score: Score) -> int:
    """Return the path id of the best scoring tile this activation can reach."""
    return _best(view, memory, list(view.endpoints), score)


# -- reading the ground ------------------------------------------------------------------------


def _area(view: _View, tile: AxialPosition) -> int:
    """1 while a tile is inside the battle area, 0 once it is out in the wilds.

    Ranked ahead of every other consideration for the units that fight in the line, this is
    what stops a unit from following a fleeing enemy across the map and away from its side.
    """
    return int(distance(tile, view.center) <= view.battle_radius)


def _station(view: _View, tile: AxialPosition, ring: int) -> int:
    """Score a tile by how well it holds a station: ``ring`` tiles out from the field's middle.

    Ring 0 is the middle itself, where the melee gathers. The archer's ring is larger, which
    keeps it behind the fighting, on our own approach to it, and still inside its range.
    """
    return -abs(distance(tile, view.center) - ring)


def _travel(view: _View, tile: AxialPosition) -> int:
    """How far a tile is from where the unit stands: the tie-breaker that keeps units settled."""
    return distance(view.position, tile)


def _cohesion(view: _View, tile: AxialPosition) -> int:
    """Reward tiles within arm's reach of a friend, so units that meet stay met.

    Nobody knows where the rest of the detachment spawned, so the group assembles by sight:
    the first two units to see each other close up, and the third joins the pair it can see.
    """
    if not view.allies:
        return 0
    return -min(COHESION_RANGE, min(distance(tile, ally["position"]) for ally in view.allies))


# -- reading the enemy ---------------------------------------------------------------------------


def _kill_order(enemy: VisibleUnit) -> tuple[int, int, str]:
    """Rank one enemy for concentration: the most wounded first, archers ahead of their peers."""
    return (enemy["hit_points"], TYPE_ORDER[enemy["type"]], enemy["unit_id"])


def _victim(view: _View) -> VisibleUnit | None:
    """The enemy this unit concentrates on, or None when it sees nobody.

    Every unit ranks the enemies it sees the same way, so units watching the same fight pile
    onto the same enemy without a word passing between them.
    """
    return min(view.enemies, key=_kill_order) if view.enemies else None


def _reachable_victim(view: _View) -> tuple[VisibleUnit, list[tuple[int, int]]] | None:
    """The best enemy this activation should end up next to, with the tiles that do it.

    Reachable is not the same as worth reaching, and the two are decided about the same enemy:
    a one-hit kill we cannot get to never licenses walking into somebody else's melee.
    """
    for enemy in sorted(view.enemies, key=_kill_order):
        beside = [tile for tile in view.endpoints if distance(_tile(tile), enemy["position"]) == 1]
        if beside and _worth_joining(view, enemy):
            return enemy, beside
    return None


def _worth_joining(view: _View, victim: VisibleUnit) -> bool:
    """Whether walking into reach of this enemy is a fight our unit should take.

    Melee always trades: whoever we end up beside strikes back. So a unit fights when the
    numbers are on its side and not before. Four cases qualify:

    - The blow finishes the enemy, so nothing strikes back.
    - The enemy is an archer. It shoots from six tiles away and will never walk into our line,
      so somebody has to go and get it, and it is the softest thing on the field to trade with.
    - We are in contact already, where turning our back only gives away a free hit.
    - An ally is close enough to that enemy to join the fight this round or the next.

    Otherwise the unit holds its station and lets the enemy come to the whole detachment
    instead of meeting it one unit at a time.
    """
    if victim["hit_points"] <= DAMAGE[view.unit["type"]] or victim["type"] == "archer":
        return True
    if _pressure(view, view.position) <= 1:
        return True
    return any(distance(ally["position"], victim["position"]) <= SUPPORT_RANGE for ally in view.allies)


def _escorts(view: _View, tile: AxialPosition, victim: VisibleUnit) -> int:
    """Count the enemies other than the victim that stand next to a tile."""
    return sum(
        1
        for enemy in view.enemies
        if enemy["unit_id"] != victim["unit_id"] and distance(tile, enemy["position"]) == 1
    )


def _pressure(view: _View, tile: AxialPosition) -> int:
    """The distance from a tile to the nearest enemy, or the whole field when none is in sight."""
    if not view.enemies:
        return view.field_side
    return min(distance(tile, enemy["position"]) for enemy in view.enemies)


def _shelter(view: _View, tile: AxialPosition) -> int:
    """Prefer tiles near the friends who can cover us, or our station while we are alone.

    This is what turns a retreat into a useful move: the archer gives ground toward its own
    line, so whatever chases it arrives in front of the footman and the cavalry.
    """
    if view.allies:
        return -min(distance(tile, ally["position"]) for ally in view.allies)
    return _station(view, tile, view.archer_station)


# -- building the order --------------------------------------------------------------------------


def _order(view: _View, path_id: int, victim: VisibleUnit | None = None) -> SkirmishAction:
    """Turn a chosen path and an intended victim into one legal order."""
    named = victim["unit_id"] if victim is not None and victim["unit_id"] in view.nameable else None
    if path_id == 0:
        return stay(named, view.observation)
    return move(path_id, named, view.observation)


def _mirror(position: AxialPosition, field_side: int) -> AxialPosition:
    """Return the tile opposite a tile: the enemy half's answer to our own spawn."""
    return {"q": field_side - 1 - position["q"], "r": field_side - 1 - position["r"]}


def _hold(view: _View, memory: Memory, ring: int) -> SkirmishAction:
    """Take up station and settle there, striking whatever is in range from the tile chosen."""

    def score(tile: AxialPosition) -> tuple[int, ...]:
        return (_cohesion(view, tile), _station(view, tile, ring), -_travel(view, tile))

    return _order(view, _pick(view, memory, score), _victim(view))


def _regroup(view: _View, memory: Memory, ring: int) -> SkirmishAction:
    """Nothing in sight: take up station, and push into the enemy half if nobody ever comes."""
    at_station = abs(distance(view.position, view.center) - ring) <= RALLY_RADIUS
    if at_station and memory.idle > PATIENCE and memory.home is not None:
        goal = _mirror(memory.home, view.field_side)
        return _order(view, _pick(view, memory, lambda tile: (-distance(tile, goal),)))
    return _hold(view, memory, ring)


# -- the three unit policies -----------------------------------------------------------------------


def archer_order(observation: SkirmishObservation, memory: Memory) -> SkirmishAction:
    """Fire every activation, and give ground while firing once something is closing in.

    States: advance while nothing is in sight, fire while the fight is still at arm's length,
    fall_back once an enemy is inside the comfort distance. Falling back is not a retreat: the
    path and the strike are one order, so the archer opens the distance and still shoots on the
    way out, as long as the tile it lands on keeps its victim inside range.
    """
    view = _View(observation, memory)
    if not view.enemies:
        memory.state = ADVANCE
        return _regroup(view, memory, view.archer_station)

    victim = _victim(view)
    threat = _pressure(view, view.position)
    memory.state = FALL_BACK if threat < ARCHER_COMFORT else FIRE
    # Firing holds the line at a comfortable distance; falling back opens as much ground as the
    # bow still covers. Capping the reward for distance is what keeps the archer from running
    # away from a fight it is winning.
    room = ARCHER_RANGE if memory.state == FALL_BACK else ARCHER_COMFORT

    def score(tile: AxialPosition) -> tuple[int, ...]:
        covers = victim is not None and distance(tile, victim["position"]) <= ARCHER_RANGE
        return (int(covers), min(_pressure(view, tile), room), _shelter(view, tile))

    return _order(view, _pick(view, memory, score), victim)


def cavalry_order(observation: SkirmishObservation, memory: Memory) -> SkirmishAction:
    """Ride around the enemy line and hit its softest unit from a tile nobody else covers.

    States: charge when a tile beside an enemy worth fighting is reachable, flank while riding
    toward one, advance when nothing is in sight or nothing in sight is worth riding at alone.
    A charge prefers a long approach, which is the shape the cavalry's charge bonus rewards, and
    a tile with no second enemy beside it, so the ride ends on the victim rather than in the
    middle of its escort.
    """
    view = _View(observation, memory)
    reachable = _reachable_victim(view)
    if reachable is not None:
        memory.state = CHARGE
        victim, beside = reachable

        def strike(tile: AxialPosition) -> tuple[int, ...]:
            run = _travel(view, tile)
            return (_area(view, tile), -_escorts(view, tile, victim), int(run >= CHARGE_DISTANCE), run)

        return _order(view, _best(view, memory, beside, strike), victim)

    focus = _victim(view)
    if focus is None or not _worth_joining(view, focus):
        memory.state = ADVANCE
        return _regroup(view, memory, view.melee_station)

    memory.state = FLANK
    riding_at = focus

    def approach(tile: AxialPosition) -> tuple[int, ...]:
        # Close on the victim, and among the tiles that close the same amount take the one the
        # rest of the enemy is not standing on: that is the way around their line, not into it.
        return (
            _area(view, tile),
            -distance(tile, riding_at["position"]),
            -_escorts(view, tile, riding_at),
        )

    return _order(view, _pick(view, memory, approach), focus)


def footman_order(observation: SkirmishObservation, memory: Memory) -> SkirmishAction:
    """Hold the line: fight whatever comes into reach, and otherwise stay on the archer's shoulder.

    States: engage when there is a reachable enemy worth fighting, screen whenever it has anyone
    in sight to guard or to watch, advance only when it is alone on an empty field. Screening
    keeps the footman one tile from the friendly archer and on the side the enemy is coming from,
    and prefers a tile beside another footman, which is the shield wall the abilities variant
    rewards. A footman that chases leaves the archer to die.

    A footman guarding an archer screens even with nothing in sight, so it is the one type that
    does not go looking for the enemy on its own. It does not need to: it follows the archer it
    is guarding, and that archer pushes into the enemy half when nobody comes.
    """
    view = _View(observation, memory)
    if not view.enemies and not view.allies:
        memory.state = ADVANCE
        return _regroup(view, memory, view.melee_station)

    reachable = _reachable_victim(view)
    if reachable is not None:
        memory.state = ENGAGE
        victim, beside = reachable

        def stand(tile: AxialPosition) -> tuple[int, ...]:
            return (_area(view, tile), _shield_wall(view, tile), -distance(tile, _anchor(view)))

        return _order(view, _best(view, memory, beside, stand), victim)

    memory.state = SCREEN
    return _screen(view, memory)


def _anchor(view: _View) -> AxialPosition:
    """The tile the footman guards: the friendly archer it can see, or the middle of the field."""
    archers = [ally for ally in view.allies if ally["type"] == "archer"]
    if not archers:
        return view.center
    return min(archers, key=lambda ally: distance(view.position, ally["position"]))["position"]


def _shield_wall(view: _View, tile: AxialPosition) -> int:
    """Count the friendly footmen a tile would stand shoulder to shoulder with."""
    return sum(
        1 for ally in view.allies if ally["type"] == "footman" and distance(tile, ally["position"]) == 1
    )


def _screen(view: _View, memory: Memory) -> SkirmishAction:
    """Stand between the archer and the fight, one step out of reach, and wait for it to come.

    Getting as close to the enemy as the footman can without ending beside it is what puts its
    body in the way: the enemy that wants the archer has to come through this tile first.
    """
    anchor = _anchor(view)

    def score(tile: AxialPosition) -> tuple[int, ...]:
        return (
            _area(view, tile),
            int(_pressure(view, tile) > 1),
            _shield_wall(view, tile),
            -abs(distance(tile, anchor) - SCREEN_DISTANCE),
            -_pressure(view, tile),
        )

    return _order(view, _pick(view, memory, score), _victim(view))


_POLICIES = {"archer": archer_order, "cavalry": cavalry_order, "footman": footman_order}


class Agent:
    """One unit of the detachment, running the state machine its unit type calls for."""

    def __init__(self) -> None:
        self.memory = Memory()

    def reset(self, seed: int) -> None:
        self.memory = Memory(seed)

    def act(self, observation: SkirmishObservation) -> SkirmishAction:
        policy = _POLICIES[observation["observation"]["self"]["type"]]
        return policy(observation, self.memory)
