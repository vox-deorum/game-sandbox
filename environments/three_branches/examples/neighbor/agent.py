"""Season 4's static, replaceable village schedule and visitor reactions."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

import dialogue
import routines
from sandbox.observation_types import ThreeBranchesAction, ThreeBranchesObservation
from sandbox.village import action, day, me, people

ROLES = (
    "stallkeeper",
    "water-carrier",
    "grower",
    "reader",
    "repairer",
    "trader",
    "pump-tender",
    "gardener",
    "messenger",
    "caretaker",
)
SLOT_ROLE_CHOICES = (
    ("water-carrier", "pump-tender"),
    ("reader",),
    ("repairer",),
    ("caretaker",),
    ("messenger",),
    ("stallkeeper", "trader"),
    ("stallkeeper", "trader"),
    ("stallkeeper", "trader"),
    ("grower", "gardener"),
    ("grower", "gardener"),
)
SLOT_JOB_OFFSETS = (0, 0, 0, 0, 0, 0, 1, 2, 0, 1)
SLOT_LANTERN_OFFSETS = (9, 1, 13, 2, 4, 6, 5, 7, 0, 3)
REACTION_TICKS = 40
RETURN_HOME_TICK = 880
SLOT_RETURN_HOME_TICKS = (840, 880, 760, 760, 880, 880, 880, 840, 840, 880)
ROLE_JOBS = {
    "stallkeeper": "stall",
    "water-carrier": "pump",
    "grower": "plot",
    "reader": "board",
    "repairer": "repair_bench",
    "trader": "stall",
    "pump-tender": "pump",
    "gardener": "plot",
    "messenger": "bell",
    "caretaker": "hearth",
}
ROLE_MIDDAY = {
    "stallkeeper": "gather_at",
    "water-carrier": "rest",
    "grower": "gather_at",
    "reader": "watch",
    "repairer": "go_to",
    "trader": "gather_at",
    "pump-tender": "rest",
    "gardener": "go_to",
    "messenger": "watch",
    "caretaker": "go_to",
}
ROLE_MIDDAY_GOALS = {
    "stallkeeper": "inn",
    "water-carrier": "inn",
    "grower": "stall",
    "reader": "board",
    "repairer": "inn",
    "trader": "stall",
    "pump-tender": "inn",
    "gardener": "shrine",
    "messenger": "bell",
    "caretaker": "shed",
}
ROLE_REACTIONS = {
    "stallkeeper": "greet",
    "water-carrier": "follow",
    "grower": "avoid",
    "reader": "greet",
    "repairer": "follow",
    "trader": "greet",
    "pump-tender": "follow",
    "gardener": "avoid",
    "messenger": "greet",
    "caretaker": "avoid",
}
ROLE_EVENING = {
    "stallkeeper": "lantern",
    "water-carrier": "lantern",
    "grower": "lantern",
    "reader": "lantern",
    "repairer": "hearth",
    "trader": "lantern",
    "pump-tender": "lantern",
    "gardener": "shrine",
    "messenger": "bell",
    "caretaker": "repair_bench",
}


class Agent:
    """One independent villager following the same non-adaptive daily table."""

    def __init__(self) -> None:
        self.memory: dict[str, object] = {}
        self.dialogue = dialogue.Dialogue("a friendly resident of Three Branches")

    def reset(self, seed: int, observation: ThreeBranchesObservation) -> None:
        rng = me.rng(observation, seed)
        slot = int(me.player_id(observation).removeprefix("player_")) - 1
        role = rng.choice(SLOT_ROLE_CHOICES[slot])
        home = me.home(observation)
        self.memory = {
            "rng": rng,
            "role": role,
            "slot": slot,
            "job_offset": SLOT_JOB_OFFSETS[slot],
            "home": home,
            "home_point": routines.building_slot_goal(observation, home, slot),
            "graph": routines.build_graph(observation),
            "phase": None,
            "schedule_mark": None,
            "visitor_nearby": False,
            "visitor_handled": False,
            "reaction_until": None,
            "routines": {},
        }
        self._assign(observation)
        self.dialogue = dialogue.Dialogue(f"the {role} of Three Branches")
        self.dialogue.observe(observation)

    def act(self, observation: ThreeBranchesObservation) -> ThreeBranchesAction:
        visitor_nearby = any(person["id"] == "player_0" for person in people.nearby(observation))
        if not visitor_nearby:
            self.memory["visitor_handled"] = False
        reaction_until = self.memory.get("reaction_until")
        reaction_finished = (
            str(self.memory.get("routine")) in {"greet", "follow", "avoid"}
            and isinstance(reaction_until, int)
            and day.tick(observation) >= reaction_until
        )
        if reaction_finished:
            self.memory["visitor_handled"] = True
        if (
            self.memory.get("schedule_mark") != _schedule_mark(observation)
            or self.memory.get("visitor_nearby") != visitor_nearby
            or reaction_finished
        ):
            self._assign(observation)
        self.dialogue.observe(observation)
        routine = str(self.memory["routine"])
        goal = self.memory["goal"]
        order = getattr(routines, routine)(observation, self.memory, goal)
        if order is None:
            order = routines.wander(observation, self.memory, goal)
        return action.stand(me.heading(observation)) if order is None else order

    def chat(self, inbox: object) -> list[dict[str, str]]:
        self.dialogue.receive(inbox)
        reply = self.dialogue.reply()
        return [] if reply is None else [reply]

    def _assign(self, observation: Mapping[str, object]) -> None:
        routine, goal = assign(observation, self.memory)
        self.memory["routine"] = routine
        self.memory["goal"] = goal
        self.memory["phase"] = day.phase(observation)
        self.memory["schedule_mark"] = _schedule_mark(observation)
        self.memory["visitor_nearby"] = any(
            person["id"] == "player_0" for person in people.nearby(observation)
        )
        self.memory["reaction_until"] = (
            day.tick(observation) + REACTION_TICKS if routine in {"greet", "follow", "avoid"} else None
        )


def assign(observation: Mapping[str, object], memory: dict[str, object]) -> tuple[str, object]:
    """The Season 4 design seam: a static role table that students are meant to replace."""
    slot = cast(int, memory["slot"])
    job_offset = cast(int, memory.get("job_offset", slot))
    role = str(memory["role"])
    home = memory["home"]
    phase = day.phase(observation)
    return_home_tick = SLOT_RETURN_HOME_TICKS[slot]
    if phase == "night":
        return "sleep_at", home
    if phase == "evening" and day.tick(observation) >= return_home_tick:
        return "go_to", memory.get("home_point", home)
    visitor_nearby = any(person["id"] == "player_0" for person in people.nearby(observation))
    if visitor_nearby and not memory.get("visitor_handled"):
        reaction = ROLE_REACTIONS[role]
        return reaction, memory.get("goal") if reaction == "avoid" else "player_0"
    job = ROLE_JOBS[role]
    if phase == "dawn":
        return "go_to", routines.prop_goal(observation, job, job_offset)
    if phase == "morning":
        return "tend", routines.prop_goal(observation, job, job_offset)
    if phase == "midday":
        routine = ROLE_MIDDAY[role]
        goal_type = ROLE_MIDDAY_GOALS[role]
        goal = goal_type if goal_type in {"inn", "shed"} else routines.prop_goal(observation, goal_type, slot)
        return routine, goal
    if phase == "evening":
        evening_job = ROLE_EVENING[role]
        evening_offset = SLOT_LANTERN_OFFSETS[slot] if evening_job == "lantern" else job_offset
        goal = routines.prop_goal(observation, evening_job, evening_offset)
        if goal is None:
            goal = routines.prop_goal(observation, job, job_offset)
        return "tend", goal
    return "wander", routines.prop_goal(observation, "board", slot)


def _schedule_mark(observation: Mapping[str, object]) -> tuple[str, int]:
    """Split evening so every resident visibly returns home before the night phase."""
    phase = day.phase(observation)
    tick = day.tick(observation)
    reached = max((boundary for boundary in SLOT_RETURN_HOME_TICKS if tick >= boundary), default=0)
    return phase, reached if phase == "evening" else 0
