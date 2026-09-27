"""Neighbor: villagers who follow a fixed daily schedule and react when the visitor comes near.

The game runs a separate ``Agent`` for each of the ten residents, so every resident keeps its own
``memory`` dictionary. On every tick, each resident:

1. Asks ``assign`` what to do right now. The answer is a routine name from ``routines.py`` and a
   goal for it, such as ``("tend", "stall_2")``.
2. Runs that routine, which returns this tick's action.

To make the village your own, start with the two tables below (``ROLES`` and ``RESIDENTS``), then
rewrite ``assign``. To add a new kind of behavior, write a routine in ``routines.py`` and return its
name from ``assign``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import NamedTuple, cast

import dialogue
import routines
from sandbox.observation_types import ThreeBranchesAction, ThreeBranchesObservation
from sandbox.village import action, day, layout, me, people


class Role(NamedTuple):
    """What one kind of resident does through the day.

    A prop type is the ``type`` of a prop in ``props.all``, such as ``"stall"`` or ``"lantern"``. A
    building id is the ``id`` of a building in ``layout.buildings``, such as ``"inn"``.
    """

    work: str  # prop type to walk to at dawn and tend in the morning
    midday: str  # routine to run at midday
    meet: str  # midday goal: a building id, or a prop type
    evening: str  # prop type to tend in the evening, before walking home
    react: str  # routine to run when the visitor comes near: "greet", "follow", or "avoid"


ROLES = {
    "stallkeeper": Role(work="stall", midday="gather_at", meet="inn", evening="lantern", react="greet"),
    "trader": Role(work="stall", midday="gather_at", meet="stall", evening="lantern", react="greet"),
    "water-carrier": Role(work="pump", midday="rest", meet="inn", evening="lantern", react="follow"),
    "pump-tender": Role(work="pump", midday="rest", meet="inn", evening="lantern", react="follow"),
    "grower": Role(work="plot", midday="gather_at", meet="stall", evening="lantern", react="avoid"),
    "gardener": Role(work="plot", midday="go_to", meet="shrine", evening="shrine", react="avoid"),
    "reader": Role(work="board", midday="watch", meet="board", evening="lantern", react="greet"),
    "repairer": Role(work="repair_bench", midday="go_to", meet="inn", evening="hearth", react="follow"),
    "messenger": Role(work="bell", midday="watch", meet="bell", evening="bell", react="greet"),
    "caretaker": Role(work="hearth", midday="go_to", meet="shed", evening="repair_bench", react="avoid"),
}


class Resident(NamedTuple):
    """The fixed schedule for one resident. Row 0 is ``player_1``, row 1 is ``player_2``, and so on."""

    # Roles to choose from at random each day. Choices share one work prop type, so the work
    # offset below still sends this resident to its own prop whichever role it gets.
    roles: tuple[str, ...]
    # Which prop of the work type to use, counting in layout order. Giving residents with the same
    # job different offsets spreads them across the village instead of crowding one stall.
    work_offset: int
    # Which lantern to light in the evening, used only by roles whose evening prop is a lantern.
    lantern_offset: int
    # The evening tick when this resident stops working and walks home. Residents who live far
    # away leave earlier, so everyone is indoors when night falls.
    home_tick: int


# Every village has one pump, board, repair bench, hearth, and bell, and five stalls and five
# plots, so this table gives every resident a different work prop. Only the number of lanterns
# changes from village to village.
RESIDENTS = (
    Resident(roles=("water-carrier", "pump-tender"), work_offset=0, lantern_offset=9, home_tick=840),
    Resident(roles=("reader",), work_offset=0, lantern_offset=1, home_tick=880),
    Resident(roles=("repairer",), work_offset=0, lantern_offset=13, home_tick=760),
    Resident(roles=("caretaker",), work_offset=0, lantern_offset=2, home_tick=760),
    Resident(roles=("messenger",), work_offset=0, lantern_offset=4, home_tick=880),
    Resident(roles=("stallkeeper", "trader"), work_offset=0, lantern_offset=6, home_tick=880),
    Resident(roles=("stallkeeper", "trader"), work_offset=1, lantern_offset=5, home_tick=880),
    Resident(roles=("stallkeeper", "trader"), work_offset=2, lantern_offset=7, home_tick=840),
    Resident(roles=("grower", "gardener"), work_offset=0, lantern_offset=0, home_tick=840),
    Resident(roles=("grower", "gardener"), work_offset=1, lantern_offset=3, home_tick=880),
)

# Routines that react to the visitor, and how many ticks a reaction lasts before the resident
# goes back to its schedule.
REACTIONS = {"greet", "follow", "avoid"}
REACTION_TICKS = 40


class Agent:
    """One resident of Three Branches."""

    def __init__(self) -> None:
        self.memory: dict[str, object] = {}
        self.dialogue = dialogue.Dialogue("a friendly resident of Three Branches")

    def reset(self, seed: int, observation: ThreeBranchesObservation) -> None:
        """Get ready for a new day: pick a role, find home, and build the route graph."""
        rng = me.rng(observation, seed)
        # player_1 uses row 0 of RESIDENTS, player_2 uses row 1, and so on. player_0 is the visitor.
        slot = int(me.player_id(observation).removeprefix("player_")) - 1
        role = rng.choice(RESIDENTS[slot].roles)
        home = me.home(observation)
        # Everything this resident remembers lives in this one dictionary. The routines read and
        # write it too: "graph" is the route graph, and each routine keeps its own notes under
        # "routines".
        self.memory = {
            "rng": rng,
            "role": role,
            "slot": slot,
            "home": home,
            # Two residents share each home, so each one sleeps at its own spot inside.
            "home_point": routines.building_slot_goal(observation, home, slot),
            # Building the graph is slow, so it happens once here instead of on every tick.
            "graph": routines.build_graph(observation),
            "routines": {},
            # The current plan, and the tick it started on. act updates these.
            "routine": None,
            "goal": None,
            "plan_started": day.tick(observation),
            # Whether this resident already reacted to the visitor during the current visit.
            "visitor_handled": False,
        }
        self._update_plan(observation)
        self.dialogue = dialogue.Dialogue(f"the {role} of Three Branches")
        self.dialogue.observe(observation)

    def act(self, observation: ThreeBranchesObservation) -> ThreeBranchesAction:
        """Choose this tick's action: update the plan, then run the planned routine."""
        memory = self.memory

        # A resident reacts to the visitor once per visit, for REACTION_TICKS ticks, then goes back
        # to work even if the visitor stays. When the visitor leaves hearing range the visit is
        # over, so the next arrival gets a fresh reaction.
        if not visitor_nearby(observation):
            memory["visitor_handled"] = False
        elif memory["routine"] in REACTIONS and _plan_age(observation, memory) >= REACTION_TICKS:
            memory["visitor_handled"] = True

        self._update_plan(observation)
        self.dialogue.observe(observation)

        # Find the routine function in routines.py by its name and run it.
        routine = getattr(routines, str(memory["routine"]))
        goal = memory["goal"]
        order = routine(observation, memory, goal)
        # A routine returns None when it cannot do its job right now, for example gather_at when
        # nobody is at the meeting place yet. Wandering toward the goal is the fallback. Wander
        # routes straight to a building goal, which is how a resident walks to the inn to gather
        # or walks home before sleep_at can start.
        if order is None:
            order = routines.wander(observation, memory, goal)
        return action.stand(me.heading(observation)) if order is None else order

    def chat(self, inbox: object) -> list[dict[str, str]]:
        """Read the messages heard this tick, and return at most one reply to the visitor."""
        self.dialogue.receive(inbox)
        reply = self.dialogue.reply()
        return [] if reply is None else [reply]

    def _update_plan(self, observation: Mapping[str, object]) -> None:
        """Ask ``assign`` what to do now, and start a new plan whenever the answer changes."""
        routine, goal = assign(observation, self.memory)
        if (routine, goal) == (self.memory["routine"], self.memory["goal"]):
            return
        self.memory.update(routine=routine, goal=goal, plan_started=day.tick(observation))
        # The new routine starts with a clean slate, so, for example, greet waves on every visit.
        cast("dict[str, object]", self.memory["routines"]).pop(routine, None)


def assign(observation: Mapping[str, object], memory: dict[str, object]) -> tuple[str, object]:
    """Choose what this resident should do right now: a routine name and a goal for it.

    This is the place to write your own village story. It runs on every tick, and the resident
    switches plans whenever the answer changes. A goal can be a prop id (``"stall_2"``), a building
    id (``"inn"``), a player id (``"player_0"``), a position (``{"x": 12.5, "y": 8.5}``), or
    ``None``. The checks run in priority order, so the first one that matches wins.
    """
    slot = cast(int, memory["slot"])
    resident = RESIDENTS[slot]
    role = ROLES[str(memory["role"])]
    home = str(memory["home"])
    phase = day.phase(observation)

    # Night: sleep at home. Nothing else interrupts sleep, not even the visitor.
    if phase == "night":
        return "sleep_at", home

    # Late evening: head home early enough to be indoors before night falls.
    if phase == "evening" and day.tick(observation) >= resident.home_tick:
        return "go_to", memory["home_point"]

    # The visitor is within hearing range and this resident has not reacted yet.
    if visitor_nearby(observation) and not memory["visitor_handled"]:
        if role.react == "avoid":
            # Keep the current goal, so the resident backs away while still heading there.
            return "avoid", memory["goal"]
        return role.react, "player_0"

    if phase == "dawn":
        return "go_to", routines.prop_goal(observation, role.work, resident.work_offset)

    if phase == "morning":
        return "tend", routines.prop_goal(observation, role.work, resident.work_offset)

    if phase == "midday":
        if layout.building(observation, role.meet) is not None:
            return role.midday, role.meet
        return role.midday, routines.prop_goal(observation, role.meet, slot)

    if phase == "evening":
        offset = resident.lantern_offset if role.evening == "lantern" else resident.work_offset
        goal = routines.prop_goal(observation, role.evening, offset)
        # Not every village has lanterns, so a resident with none to light keeps working instead.
        if goal is None:
            goal = routines.prop_goal(observation, role.work, resident.work_offset)
        return "tend", goal

    # Seasons with day and night turned off report a single "day" phase.
    return "wander", routines.prop_goal(observation, "board", slot)


def visitor_nearby(observation: Mapping[str, object]) -> bool:
    """Return whether the visitor is within hearing range, with no wall in between."""
    return any(people.is_visitor(str(person["id"])) for person in people.nearby(observation))


def _plan_age(observation: Mapping[str, object], memory: dict[str, object]) -> int:
    """Return how many ticks the current plan has been running."""
    return day.tick(observation) - cast(int, memory["plan_started"])
