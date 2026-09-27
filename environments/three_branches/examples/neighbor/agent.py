"""Neighbor: villagers who live a plain, fixed day and greet the visitor.

The game runs a separate ``Agent`` for each of the ten residents, so every resident keeps its own
``memory`` dictionary. Every resident lives the same ordinary day:

- Dawn: walk from home to its work prop.
- Morning: work there, which means using the prop.
- Midday: meet the neighbors at its meeting place and say good day to one of them.
- Evening: work again.
- Night: walk home and sleep there.

When the visitor comes within hearing range, a resident greets them once per visit and then goes
back to its day. ``dialogue.py`` answers whatever the visitor or a neighbor says.

This day is deliberately plain. It shows how the pieces fit together, not what a good village
looks like; that part is yours to design.

On every tick, each resident:

1. Checks that its last use worked, and moves on to the next nearest work prop if someone else
   holds this one.
2. Asks ``assign`` what to do right now. The answer is a routine name from ``routines.py`` and a
   goal for it, such as ``("tend", "stall_2")``.
3. Runs that routine, which returns this tick's action.

To make the village your own, start with the ``RESIDENTS`` table, then rewrite ``assign``. To add a
new kind of behavior, write a routine in ``routines.py`` and return its name from ``assign``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import NamedTuple, cast

import dialogue
import routines
import routing
from sandbox.observation_types import ThreeBranchesAction, ThreeBranchesObservation
from sandbox.village import action, day, geometry, layout, me, people, props


class Resident(NamedTuple):
    """One row of ``RESIDENTS``: the choices that make one resident different from another.

    To give residents another difference, add a field here, fill it in on every row of
    ``RESIDENTS``, and read it in ``assign`` as ``resident.field_name``.
    """

    work: str  # the type of prop this resident works at, such as "stall" (see props.TYPES)
    meet: str  # the building where it spends midday, such as "inn" (see layout.buildings)


# One row per resident: row 0 is player_1, row 1 is player_2, and so on (player_0 is the visitor).
# Every village has one pump, board, repair bench, hearth, and bell, and five stalls and five
# plots, so this table gives every resident a prop to work at. Residents who share a prop type,
# such as the three stall keepers, each find a free one of their own (see _find_free_work_prop).
RESIDENTS = (
    Resident(work="pump", meet="inn"),
    Resident(work="board", meet="inn"),
    Resident(work="repair_bench", meet="inn"),
    Resident(work="hearth", meet="inn"),
    Resident(work="bell", meet="inn"),
    Resident(work="stall", meet="inn"),
    Resident(work="stall", meet="inn"),
    Resident(work="stall", meet="inn"),
    Resident(work="plot", meet="inn"),
    Resident(work="plot", meet="inn"),
)

# How a resident reacts when the visitor comes near. "follow" and "avoid" in routines.py are other
# reactions to try. A reaction lasts REACTION_TICKS ticks before the resident goes back to its day.
VISITOR_REACTION = "greet"
REACTION_TICKS = 40

# The action number of the "use" expression, for noticing when a use did not work.
USE = action.stand(0.0, "use")["action"]


class Agent:
    """One resident of Three Branches."""

    def __init__(self) -> None:
        self.memory: dict[str, object] = {}
        self.dialogue = dialogue.Dialogue("a resident of Three Branches")

    def reset(self, seed: int, observation: ThreeBranchesObservation) -> None:
        """Get ready for a new day: find home, build the route graph, and pick a work prop."""
        # player_1 uses row 0 of RESIDENTS, player_2 uses row 1, and so on.
        slot = int(me.player_id(observation).removeprefix("player_")) - 1
        resident = RESIDENTS[slot]
        home = me.home(observation)
        work_props = _props_by_distance(observation, resident.work, home)
        # Everything this resident remembers lives in this one dictionary. The routines read and
        # write it too: "graph" is the route graph, and each routine keeps its own notes under
        # "routines".
        self.memory = {
            "rng": me.rng(observation, seed),
            "slot": slot,
            "home": home,
            # Building the graph is slow, so it happens once here instead of on every tick.
            "graph": routing.build_graph(observation),
            "routines": {},
            # Every prop of this resident's work type, nearest to home first. The resident starts
            # with the nearest one and moves down the list when it finds one taken.
            "work_props": work_props,
            "work_prop": work_props[0] if work_props else None,
            # The current plan, and the tick it started on. act updates these.
            "routine": None,
            "goal": None,
            "plan_started": day.tick(observation),
            # Whether this resident already reacted to the visitor during the current visit.
            "visitor_handled": False,
            # Whether this resident already said good day to a neighbor today.
            "said_good_day": False,
            # Whether the last action was a use, so the next tick can check that it worked.
            "tried_use": False,
        }
        self._update_plan(observation)
        self.dialogue = dialogue.Dialogue(f"a resident of Three Branches who works at the {resident.work}")
        self.dialogue.observe(observation)

    def act(self, observation: ThreeBranchesObservation) -> ThreeBranchesAction:
        """Choose this tick's action: check the work prop, update the plan, then run the routine."""
        memory = self.memory
        self.dialogue.observe(observation)
        self._find_free_work_prop(observation)

        # A resident reacts to the visitor once per visit, for REACTION_TICKS ticks, then goes back
        # to its day even if the visitor stays. When the visitor leaves hearing range the visit is
        # over, so the next arrival gets a fresh reaction.
        if not visitor_nearby(observation):
            memory["visitor_handled"] = False
        elif memory["routine"] == VISITOR_REACTION and _plan_age(observation, memory) >= REACTION_TICKS:
            memory["visitor_handled"] = True

        self._update_plan(observation)
        self._small_talk(observation)

        # Find the routine function in routines.py by its name and run it.
        routine = getattr(routines, str(memory["routine"]))
        goal = memory["goal"]
        order = routine(observation, memory, goal)
        # A routine returns None when it cannot do its job right now, for example gather_at when
        # nobody is at the meeting place yet. Walking toward the goal is the fallback, which is how
        # a resident reaches the inn to gather or walks home before sleep_at can start.
        if order is None:
            order = routines.go_to(observation, memory, goal)
        memory["tried_use"] = order["action"] == USE
        return order

    def chat(self, inbox: list[dict[str, object]]) -> list[dict[str, str | None]]:
        """Read the messages heard this tick, and return this tick's lines."""
        self.dialogue.receive(inbox)
        return self.dialogue.messages()

    def _update_plan(self, observation: Mapping[str, object]) -> None:
        """Ask ``assign`` what to do now, and start a new plan whenever the answer changes."""
        routine, goal = assign(observation, self.memory)
        if (routine, goal) == (self.memory["routine"], self.memory["goal"]):
            return
        self.memory.update(routine=routine, goal=goal, plan_started=day.tick(observation))
        # The new routine starts with a clean slate, so, for example, greet waves on every visit.
        cast("dict[str, object]", self.memory["routines"]).pop(routine, None)

    def _find_free_work_prop(self, observation: Mapping[str, object]) -> None:
        """Move on to the next nearest work prop when the last use of this one did not work.

        A prop takes one user at a time, and whoever held it first keeps it, so a use that did not
        land means someone else holds the prop. The list wraps around, so a resident keeps trying.
        """
        memory = self.memory
        work_prop = memory["work_prop"]
        if (
            memory["tried_use"]
            and memory["goal"] == work_prop
            and me.expression(observation)["target"] != work_prop
        ):
            work_props = cast("list[str]", memory["work_props"])
            memory["work_prop"] = work_props[(work_props.index(str(work_prop)) + 1) % len(work_props)]

    def _small_talk(self, observation: Mapping[str, object]) -> None:
        """At the midday meeting, say good day to the nearest neighbor, once a day.

        Answering a neighbor who spoke first counts too, so two residents do not greet twice.
        """
        memory = self.memory
        if memory["routine"] != "gather_at" or memory["said_good_day"]:
            return
        if any(people.is_npc(listener) for listener in self.dialogue.turns):
            memory["said_good_day"] = True
            return
        neighbors = [person for person in people.nearby(observation) if people.is_npc(str(person["id"]))]
        if not neighbors:
            return
        here = me.position(observation)
        nearest = min(neighbors, key=lambda person: geometry.distance(here, person["position"]))
        if self.dialogue.say(str(nearest["id"]), dialogue.GOOD_DAY):
            memory["said_good_day"] = True


def assign(observation: Mapping[str, object], memory: dict[str, object]) -> tuple[str, object]:
    """Choose what this resident should do right now: a routine name and a goal for it.

    This is the place to write your own village story. It runs on every tick, and the resident
    switches plans whenever the answer changes. A goal can be a prop id (``"stall_2"``), a building
    id (``"inn"``), a player id (``"player_0"``), a position (``{"x": 12.5, "y": 8.5}``), or
    ``None``. The checks run in priority order, so the first one that matches wins.
    """
    resident = RESIDENTS[cast(int, memory["slot"])]
    work_prop = memory["work_prop"]
    phase = day.phase(observation)

    # Night: sleep at home. Nothing else interrupts sleep, not even the visitor. Until the resident
    # is indoors, sleep_at returns None and the go_to fallback walks it home.
    if phase == "night":
        return "sleep_at", memory["home"]

    # The visitor is within hearing range and this resident has not reacted yet.
    if visitor_nearby(observation) and not memory["visitor_handled"]:
        return VISITOR_REACTION, "player_0"

    if phase == "dawn":
        return "go_to", work_prop

    if phase == "midday":
        return "gather_at", resident.meet

    # Morning and evening are for work. Seasons with day and night turned off report a single
    # "day" phase, which is all work too.
    return "tend", work_prop


def visitor_nearby(observation: Mapping[str, object]) -> bool:
    """Return whether the visitor is within hearing range, with no wall in between."""
    return any(people.is_visitor(str(person["id"])) for person in people.nearby(observation))


def _props_by_distance(observation: Mapping[str, object], kind: str, building_id: str) -> list[str]:
    """Return the ids of every prop of a given type, nearest to a building first."""
    center = layout.building_center(observation, building_id) or me.position(observation)
    matching = [item for item in props.all(observation) if item["type"] == kind]
    matching.sort(key=lambda item: geometry.distance(routines.goal_point(observation, item["id"]), center))
    return [str(item["id"]) for item in matching]


def _plan_age(observation: Mapping[str, object], memory: dict[str, object]) -> int:
    """Return how many ticks the current plan has been running."""
    return day.tick(observation) - cast(int, memory["plan_started"])
