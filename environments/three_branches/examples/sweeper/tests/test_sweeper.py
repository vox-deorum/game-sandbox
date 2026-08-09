"""Smoke test for the sweeper example overlay."""

from __future__ import annotations

import agent


def test_sweeper_stands_still_with_the_sweep_expression():
    sweeper = agent.Agent()
    observation = {"self": {"heading": 271.5}}

    sweeper.reset(17, observation)

    assert sweeper.act(observation) == {"heading": 271.5, "speed": 0.0, "action": 10}
