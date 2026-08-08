"""Your agent.

The template starts as a working agent: while it sees no enemy it takes one step toward the
enemy side, and once an enemy comes into view it steps at the nearest one and names it. Both
sides do the same, so the two armies walk into each other and fight. Run ``python -m sandbox
play`` to watch it and ``python -m sandbox test`` to check it; both work before you change
anything. Your job starts at the ``TODO(you)`` comments inside ``act``.

Skirmish at Crane Reach in one paragraph: two sides, Red and Blue, fight over a hex field, and
every unit on a side runs a separately constructed copy of this exact class, with no memory shared
between them. On its turn a unit selects one order: a path of up to four steps, then a strike if an
enemy ends up in range of the final tile. The action mask tells you exactly which paths and which
named targets are legal right now.

Your ``act`` method returns that order: a dict with a path choice and a target choice, which you
build with ``action.move()`` or ``action.stay()``. Those come from ``sandbox.crane``, whose six
namespaces are the provided helpers: ``action`` builds orders and reads what is legal, ``me``
reads your own unit, ``visible`` and ``roster`` read the other units, ``tile`` does hex geometry
and terrain, and ``paths`` owns the path encoding. ``sandbox.crane`` and
``sandbox.observation_types`` are the only sandbox imports an agent should make, and only at the
top of this file, as they are here. ``environment.md``, shipped alongside this file, walks through
the observation, the mask, the helpers, messaging, and local play in more depth.

The optional hooks near the bottom stay commented out until you use them. Episode state belongs in
``reset``; the constructor takes no arguments.
"""

from sandbox.crane import action, me, tile, visible
from sandbox.observation_types import AxialPosition, SkirmishAction, SkirmishObservation


class Agent:
    """Marches toward the enemy side, then steps at the nearest enemy it can see."""

    def reset(self, seed: int) -> None:
        # Called once before each match. This agent keeps no state between turns, so there is
        # nothing to prepare for now.
        pass

    def act(self, observation: SkirmishObservation) -> SkirmishAction:
        # Every unit this one **can see**, minus its own side.
        enemies = visible.enemies(observation)

        if not enemies:
            # At the beginning, units sit apart and your units see no enemies.
            # me.direction is the digit that heads toward the enemy side, so we head there.
            forward = me.direction(observation)

            # legal_steps lists the single steps the mask allows right now. Checking membership
            # is what keeps this order legal when a wall, an ally, or an enemy blocks the way.
            if forward in action.legal_steps(observation):
                return action.move(forward)

            # TODO(you): when something is in the way, this unit stands still.
            # It still attacks, but maybe you can do better?
            return action.stay()

        # TODO(you): walking at the nearest enemy is the whole strategy here, and it is a weak
        # one. An archer should shoot and back away, cavalry should swing wide for a flank, and
        # a footman should hold the line beside a friend. What would each of yours rather do?

        # Where this unit is standing, as a {"q": ..., "r": ...} position.
        here = me.position(observation)

        # The closest enemy in sight. min hands back the unit itself, not the distance.
        nearest = min(enemies, key=lambda enemy: tile.distance(here, enemy["position"]))

        # The step that takes us closest to it, or 0 when nothing gets closer.
        step = self._step_toward(observation, nearest["position"])

        # Naming a target makes our strike prefer that enemy. Anything we **can see** we can
        # name, so both orders below are legal.
        if step == 0:
            return action.stay(nearest["unit_id"], observation)
        return action.move(step, nearest["unit_id"], observation)

    def _step_toward(self, observation: SkirmishObservation, goal: AxialPosition) -> int:
        """Return the single step that most closes the gap to goal, or 0 when none does."""
        # TODO(you): only single steps are tried here. A path can be four steps long and cavalry
        # has four movement points, so most of that speed is going to waste.
        here = me.position(observation)

        # Standing still is path id 0. A step has to beat its distance to be worth taking.
        best_step = 0
        best_distance = tile.distance(here, goal)

        for step in action.legal_steps(observation):
            # at_path_end says where a step would land us, so this is the distance after it.
            step_distance = tile.distance(tile.at_path_end(here, step), goal)

            # Better than anything so far, so remember it.
            if step_distance < best_distance:
                best_step, best_distance = step, step_distance

        return best_step

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget. The order argument is
    # the one act returned, named order rather than action so it does not shadow the helpers.
    #
    # def learn(self, observation, order: SkirmishAction, reward: float, terminated: bool) -> None:
    #     ...

    # Optional: messaging. Crane Reach turns it on from Season 3 onward, so whether the runner
    # calls chat at all depends on your season's settings. When it is on, right after a unit picks
    # its order the runner calls chat with any messages that arrived for it since its last
    # activation. Return messages with a recipient and text. Use None as the recipient to broadcast
    # to both sides, or a player id such as "player_2" to send directly to one allied unit (the
    # rosters in the observation map each player to its unit). By default, text is limited to 200
    # characters as counted by the system. A broadcast is heard by both sides, and a direct message
    # reaches its allied unit at that unit's next activation, right after that unit picks its own
    # order. Every message is recorded and shown in replays, so nothing you send is ever secret.
    # Return nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
