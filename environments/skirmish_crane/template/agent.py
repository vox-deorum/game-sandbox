"""A working Crane starter agent.

Each unit runs a separate instance of this class. This starter walks forward until it sees an
enemy, then takes one legal step toward the nearest visible enemy and names it. Start at the
``TODO(you)`` comments.
Read ``environment.md`` beside this file for the rules, helpers, and first improvement. Prepare
episode state in ``reset``. The constructor takes no arguments.
"""

from sandbox.crane import action, me, tile, visible
from sandbox.observation_types import AxialPosition, SkirmishAction, SkirmishObservation


class Agent:
    """Marches toward the enemy side, then steps toward the nearest visible enemy."""

    def reset(self, seed, observation) -> None:
        # Called once before each match. The opening observation is available here for
        # precomputation outside the decision clock. This starter stores no state.
        pass

    def act(self, observation: SkirmishObservation) -> SkirmishAction:
        # The enemies this unit can see.
        enemies = visible.enemies(observation)

        if not enemies:
            # At the beginning of a default skirmish match, units sit apart and see no enemies.
            # me.direction is the digit toward the enemy side, so this unit heads that way.
            forward = me.direction(observation)

            # legal_steps lists the single steps allowed by the mask. Checking membership keeps
            # this order legal when a wall, ally, or enemy blocks the way.
            if forward in action.legal_steps(observation):
                return action.move(forward)

            # TODO(you): this unit stands still when something blocks the way.
            # It may still attack, but can you choose a better response?
            return action.stay()

        # TODO(you): walking toward the nearest enemy is the entire strategy, and it is weak.
        # An archer should shoot and back away, cavalry should swing wide for a flank, and a
        # footman should hold the line beside an ally. What should each of your units do?

        # This unit's current {"q": ..., "r": ...} position.
        here = me.position(observation)

        # The closest enemy in sight. min returns the enemy dictionary, not the distance.
        nearest = min(enemies, key=lambda enemy: tile.distance(here, enemy["position"]))

        # The step that gets closest to the enemy, or 0 when no step gets closer.
        step = self._step_toward(observation, nearest["position"])

        # Naming a target makes the strike prefer that enemy. Any visible enemy can be named,
        # so both orders below are legal.
        if step == 0:
            return action.stay(nearest["unit_id"], observation)
        return action.move(step, nearest["unit_id"], observation)

    def _step_toward(self, observation: SkirmishObservation, goal: AxialPosition) -> int:
        """Return the single step that most closes the gap to goal, or 0 when none does."""
        # TODO(you): only single steps are tried here. A path can contain four steps, and cavalry
        # has four movement points, so most of that speed goes to waste.
        here = me.position(observation)

        # Standing still is path id 0. A step must reduce the distance to be worth taking.
        best_step = 0
        best_distance = tile.distance(here, goal)

        for step in action.legal_steps(observation):
            # at_path_end gives the landing tile, so this is the distance after the step.
            step_distance = tile.distance(tile.at_path_end(here, step), goal)

            # Remember this step if it is the best one so far.
            if step_distance < best_distance:
                best_step, best_distance = step, step_distance

        return best_step

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against the timing and episode budget. The order argument is
    # what act returned. It is named order so it does not shadow the action helpers.
    #
    # def learn(self, observation, order: SkirmishAction, reward: float, terminated: bool) -> None:
    #     ...

    # Optional: messaging. Season settings enable it from Season 3 onward. When enabled, chat runs
    # after a unit chooses its order and receives messages that arrived since its previous
    # activation. Return each message with a recipient and text. Use None to broadcast to both
    # sides, or a player id such as "player_2", not a unit id, to send directly to one ally. The
    # rosters in the observation map each player to its unit. By default, text is limited to 200
    # characters.
    # A direct message reaches its allied unit at its next activation, after that unit chooses its
    # own order. Every message is recorded and shown in replays, so nothing you send is ever secret.
    # Return nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
