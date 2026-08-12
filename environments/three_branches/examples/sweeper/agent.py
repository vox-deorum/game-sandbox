"""An internal example that moves forward while showing the sweep emote."""


class Agent:
    """Walks at an easy pace and sweeps."""

    def reset(self, seed, observation) -> None:
        """Start each day with no retained state."""

    def act(self, observation):
        return {"heading": observation["self"]["heading"], "speed": 0.5, "action": 10}
