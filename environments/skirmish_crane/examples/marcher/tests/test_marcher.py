"""Example-specific tests, added on top of the inherited template tests.

Light by design: the marcher is a study of the starter agent, not a ladder rival, so there is no
claim here about beating anybody. Two properties are worth pinning. Every order it returns is
legal against the mask it read, and six separately constructed copies playing both sides finish a
match by elimination well short of the round cap, which is what says the march actually carries
the fight across the field instead of wandering until the clock runs out.
"""

from __future__ import annotations

import agent
from sandbox.env import META, make_env
from sandbox.harness.environment import resolve_parameters
from sandbox.play import play_episode

# The round cap is 1000. Both seeds below finish around round 10, so this is a generous ceiling
# that still fails loudly if the march ever stops meeting the enemy.
ROUND_CEILING = 200


class _Checked:
    """The example agent, with every order it returns checked against the mask it read."""

    def __init__(self) -> None:
        self.inner = agent.Agent()
        self.orders: list[dict[str, int]] = []
        self.illegal: list[dict[str, int]] = []
        self.last_round = 0

    def reset(self, seed, observation) -> None:
        self.inner.reset(seed, observation)

    def act(self, observation):
        order = self.inner.act(observation)
        mask = observation["action_mask"]
        self.orders.append(order)
        self.last_round = max(self.last_round, observation["observation"]["round"])
        if not mask["path"][order["path"]] or not mask["target"][order["target"]]:
            self.illegal.append(order)
        return order


def _self_play(seed: int) -> tuple[float, list[_Checked]]:
    """Play one default skirmish with a separately constructed marcher on all six units."""
    everyone = tuple(f"player_{index}" for index in range(6))
    units = [_Checked() for _ in everyone]
    parameters = resolve_parameters(META)
    env = make_env(parameters)
    try:
        score = play_episode(
            units[0],
            env,
            seed=seed,
            player_id=everyone[0],
            parameters=parameters,
            other_agents=dict(zip(everyone[1:], units[1:], strict=True)),
        )
    finally:
        env.close()
    return score, units


def test_a_match_between_marchers_ends_by_elimination():
    score, units = _self_play(seed=0)

    assert 0.0 <= score <= 100.0
    assert max(unit.last_round for unit in units) < ROUND_CEILING
    orders = [order for unit in units for order in unit.orders]
    assert any(order["path"] != 0 for order in orders)  # it marches
    assert any(order["target"] != 0 for order in orders)  # and names what it fights


def test_every_order_the_marcher_gives_is_mask_legal():
    _, units = _self_play(seed=1)

    assert sum(len(unit.orders) for unit in units) > 0
    assert [order for unit in units for order in unit.illegal] == []
