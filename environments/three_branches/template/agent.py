"""A small Days at Three Branches starter built entirely from ``sandbox.village``."""

from sandbox.observation_types import ThreeBranchesAction, ThreeBranchesObservation
from sandbox.village import action, geometry, layout, me, people, props


def _cell_centre(cell: dict[str, int]) -> dict[str, float]:
    """Return the point at the centre of one village cell."""

    return {"x": cell["x"] + 0.5, "y": cell["y"] + 0.5}


class Agent:
    """Walks out of its home, visits the pump, and acknowledges people it sees."""

    def reset(self, seed: int, observation: ThreeBranchesObservation) -> None:
        """Prepare for a day. This deliberately weak starter remembers nothing."""

    def act(self, observation: ThreeBranchesObservation) -> ThreeBranchesAction:
        """Choose one simple order from current sight and standing village knowledge."""

        heading = me.heading(observation)
        usable = props.usable(observation)
        if usable is not None and usable["type"] == "bench":
            return action.stand(heading, "use")

        here = me.position(observation)
        expression = "wave" if people.seen(observation) else "none"
        home = me.home(observation)
        door = layout.doorway(observation, home) if home != "none" else None
        here_cell = layout.cell_at(observation, here)
        if (
            door is not None
            and here_cell is not None
            and layout.ground_at(observation, here_cell) == "interior"
        ):
            return action.walk(geometry.heading_to(here, door), 1.0, expression)

        pump = next((prop for prop in props.all(observation) if prop["type"] == "pump"), None)
        if pump is not None:
            return action.walk(geometry.heading_to(here, _cell_centre(pump["cell"])), 1.0, expression)
        return action.walk(heading, 0.0, expression)
