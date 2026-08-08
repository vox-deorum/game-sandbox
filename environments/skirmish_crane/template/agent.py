"""Your agent.

Skirmish at Crane Reach in one paragraph: two sides, Red and Blue, fight over a hex field, and
every unit on a side runs a separately constructed copy of this exact class, with no memory shared
between them. On its turn a unit selects one order: a path of up to four steps, then a strike if an
enemy ends up in range of the final tile. The action mask tells you exactly which paths and which
named targets are legal right now.

Your act method returns that order: a dict with a path choice and a target choice, which you get by
calling move() or stay() from sandbox.crane. sandbox.crane and sandbox.observation_types are the
only sandbox imports an agent should make, and only at the top of this file, as they are here.
environment.md, shipped alongside this file, walks through the observation, the mask, the helpers,
messaging, and local play in more depth.

The optional hooks near the bottom stay commented out until you use them. Episode state belongs in
reset; the constructor takes no arguments.
"""

from sandbox.crane import distance, legal_paths, move, nameable_targets, neighbors, stay
from sandbox.observation_types import AxialPosition, SkirmishAction, SkirmishObservation


class Agent:
    """Marches blind toward enemy ground, then steps at the nearest enemy it can see."""

    def reset(self, seed: int) -> None:
        # Called once before each match. Episode state lives here: this agent remembers only its
        # spawn tile, so it can march on the mirrored spot while nothing is in sight. A learning
        # agent would also clear its memory in this method.
        self._home: AxialPosition | None = None

    def act(self, observation: SkirmishObservation) -> SkirmishAction:
        state = observation["observation"]
        position = state["self"]["position"]
        if self._home is None:
            self._home = position
        own_side = state["self"]["unit_id"].split("_", 1)[0]
        enemies = [unit for unit in state["visible_units"] if unit["side"] != own_side]

        if not enemies:
            # Spawns sit farther apart than any unit can see, so a unit that waits for a target
            # waits forever. The field is point-symmetric, which puts the mirror image of your
            # spawn tile in enemy ground: march on it one step at a time until something shows up.
            extent = state["parameters"]["field_extent"]
            goal: AxialPosition = {"q": 2 * extent - self._home["q"], "r": 2 * extent - self._home["r"]}
            step = self._step_toward(observation, goal)
            if step == 0:
                # Boxed in for now. Standing still is always legal, and it still strikes anything
                # that walks into range.
                return stay()
            return move(step)

        # TODO(you): closing the raw distance to whichever enemy is nearest is the whole strategy
        # here, and it is deliberately weak. It never falls back to fire at range like an archer
        # should, never circles around for a flank like cavalry, and never holds a line alongside
        # allies like a footman: building those tactical blocks is Season 1's open design problem.
        nearest = min(enemies, key=lambda unit: distance(position, unit["position"]))
        nearest_id = nearest["unit_id"]
        best_path = self._step_toward(observation, nearest["position"])

        if nearest_id in nameable_targets(observation):
            if best_path == 0:
                return stay(target_id=nearest_id, observation=observation)
            return move(best_path, target_id=nearest_id, observation=observation)
        return move(best_path)

    def _step_toward(self, observation: SkirmishObservation, goal: AxialPosition) -> int:
        """Return the single-step path id that most closes the gap to goal, or 0 when none does."""
        # TODO(you): only the six single-step paths are tried, so this agent never plans a longer
        # route and never reacts to terrain. Turning a planned route into legal steps is later work.
        position = observation["observation"]["self"]["position"]
        adjacent = neighbors(position)
        best_path = 0
        best_distance = distance(position, goal)
        for path_id in legal_paths(observation):
            if not 1 <= path_id <= 6:
                continue
            step_distance = distance(adjacent[path_id], goal)
            if step_distance < best_distance:
                best_path, best_distance = path_id, step_distance
        return best_path

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget.
    #
    # def learn(self, observation, action: SkirmishAction, reward: float, terminated: bool) -> None:
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
