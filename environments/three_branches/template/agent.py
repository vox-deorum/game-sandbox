"""A stand-still starter for Days at Three Branches."""


class Agent:
    """Keeps its current heading and watches the village."""

    def reset(self, seed, observation) -> None:
        """Prepare for a new day. This starter does not need episode state."""

    def act(self, observation):
        # TODO(you): begin by changing the speed or heading, then use what you can see and hear.
        return {"heading": observation["self"]["heading"], "speed": 0.0, "action": 0}

    # The optional chat hook runs after act. Direct messages use a player id from the
    # observation's roster, and a recipient of None broadcasts to everyone in hearing range.
    # Return nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
