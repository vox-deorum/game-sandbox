"""High-signal checks for the Season 4 neighbor example."""

from __future__ import annotations

import copy

import agent
import dialogue
import pytest
from sandbox.env import META, make_env
from sandbox.harness.environment import resolve_parameters
from sandbox.village import action, geometry, layout, me, people, props

SEASON_4 = {"seat_plan": "cast_10", "daynight": True}


@pytest.fixture(scope="module")
def scene():
    env = make_env(resolve_parameters(META, SEASON_4))
    observations, _ = env.reset(seed=9)
    first, second = agent.Agent(), agent.Agent()
    first.reset(9, observations["player_1"])
    second.reset(9, observations["player_2"])
    yield env, observations, first, second
    env.close()


def _example(scene):
    """Return a fresh resident that shares the fixture's route graph, and a copy of its observation."""
    _env, observations, first, _second = scene
    observation = copy.deepcopy(observations["player_1"])
    example = agent.Agent()
    example.memory = dict(first.memory, rng=me.rng(observation, 9), routines={})
    example.dialogue.observe(observation)
    return example, observation


def _visitor_at(position):
    """Return a record of the visitor standing at a position, as seen or heard."""
    return {"id": "player_0", "position": dict(position), "expression": {"type": "none", "target": "none"}}


class _FakeLLM:
    def __init__(self):
        self.requesting = False
        self.error = None
        self.answer = None
        self.requests = []

    def request(self, **kwargs):
        self.requests.append(kwargs)
        self.requesting = True
        return True

    def response(self):
        answer, self.answer = self.answer, None
        if answer is not None:
            self.requesting = False
        return answer


def test_reset_keeps_private_graphs_and_returns_a_legal_first_action(scene):
    env, observations, first, second = scene

    assert first.memory["graph"]
    assert second.memory["graph"]
    assert first.memory["graph"] is not second.memory["graph"]
    assert (first.memory["slot"], second.memory["slot"]) == (0, 1)
    assert env.action_space("player_1").contains(first.act(observations["player_1"]))


def test_residents_find_their_own_work_props_and_follow_the_day(scene, monkeypatch):
    _env, observations, _first, _second = scene
    residents = {player: agent.Agent() for player in observations if player != "player_0"}
    for player, resident in residents.items():
        resident.reset(9, observations[player])
    work_props = [resident.memory["work_prop"] for resident in residents.values()]
    assert len(set(work_props)) == 10
    types = {item["id"]: item["type"] for item in props.all(observations["player_1"])}
    assert [types[prop] for prop in work_props] == [resident.work for resident in agent.RESIDENTS]

    example = residents["player_6"]
    memory = example.memory
    observation = copy.deepcopy(observations["player_6"])
    monkeypatch.setattr(people, "nearby", lambda _observation: ())
    for phase, plan in (
        ("dawn", ("go_to", memory["work_prop"])),
        ("morning", ("tend", memory["work_prop"])),
        ("midday", ("gather_at", "inn")),
        ("evening", ("tend", memory["work_prop"])),
        ("night", ("sleep_at", memory["home"])),
    ):
        observation["phase"] = phase
        assert agent.assign(observation, memory) == plan

    observation["phase"] = "morning"
    monkeypatch.setattr(people, "nearby", lambda _observation: (_visitor_at(me.position(observation)),))
    assert agent.assign(observation, memory) == ("greet", "player_0")


def test_a_resident_moves_on_when_its_work_prop_is_taken(scene):
    example, observation = _example(scene)
    example.memory.update(work_props=["stall_1", "stall_4"], work_prop="stall_1", goal="stall_1")

    # The last use worked, so the resident keeps its stall.
    observation["self"]["expression"] = {"type": "use", "target": "stall_1"}
    example.memory["tried_use"] = True
    example._find_free_work_prop(observation)
    assert example.memory["work_prop"] == "stall_1"

    # The last use did not work, so somebody else holds the stall. The list wraps around.
    observation["self"]["expression"] = {"type": "none", "target": "none"}
    example._find_free_work_prop(observation)
    assert example.memory["work_prop"] == "stall_4"
    example.memory["goal"] = "stall_4"
    example._find_free_work_prop(observation)
    assert example.memory["work_prop"] == "stall_1"


def test_visitor_reaction_lasts_its_window_and_repeats_on_the_next_visit(scene, monkeypatch):
    example, observation = _example(scene)
    observation["phase"] = "morning"
    heard = []
    monkeypatch.setattr(people, "nearby", lambda _observation: tuple(heard))
    monkeypatch.setattr(people, "seen", lambda _observation: tuple(heard))

    def run(tick):
        observation["tick"] = tick
        order = example.act(observation)
        return example.memory["routine"], order["action"]

    wave = action.stand(0.0, "wave")["action"]
    example.memory.update(routine=None, goal=None)
    assert run(100)[0] == "tend"
    for arrival in (101, 200):
        heard[:] = [_visitor_at(me.position(observation))]
        assert run(arrival) == ("greet", wave)
        assert run(arrival + agent.REACTION_TICKS - 1)[0] == "greet"
        assert run(arrival + agent.REACTION_TICKS)[0] == "tend"
        heard[:] = []
        assert run(arrival + agent.REACTION_TICKS + 1)[0] == "tend"


def test_documented_routine_menu_returns_its_expected_orders(scene, monkeypatch):
    env, _observations, _first, _second = scene
    example, observation = _example(scene)
    pump = next(item for item in props.all(observation) if item["type"] == "pump")
    bench = next(item for item in props.all(observation) if item["type"] == "bench")
    here = me.position(observation)
    goal = {"x": float(bench["cell"]["x"]) + 0.5, "y": float(bench["cell"]["y"]) + 0.5}
    visitor = {
        "id": "player_0",
        "position": {"x": float(here["x"]) + 1.0, "y": float(here["y"])},
        "moved": 0.5,
    }

    orders = {
        "go_to": agent.routines.go_to(observation, example.memory, pump["id"]),
        "wander": agent.routines.wander(observation, example.memory, pump["id"]),
    }
    graph = example.memory["graph"]
    example.memory["graph"] = {}
    monkeypatch.setattr(agent.routines.props, "usable", lambda _observation: pump)
    orders["tend"] = agent.routines.tend(observation, example.memory, pump["id"])
    example.memory["graph"] = graph
    monkeypatch.setattr(agent.routines.props, "usable", lambda _observation: None)
    monkeypatch.setattr(
        agent.routines.props,
        "seen",
        lambda _observation: ({"prop": bench["id"], "state": "empty"},),
    )
    orders["rest"] = agent.routines.rest(observation, example.memory, goal)
    companion = dict(visitor, position=dict(goal))
    monkeypatch.setattr(agent.routines.people, "nearby", lambda _observation: (companion,))
    orders["gather_at"] = agent.routines.gather_at(observation, example.memory, goal)
    monkeypatch.setattr(agent.routines.people, "nearby", lambda _observation: (visitor,))
    monkeypatch.setattr(agent.routines.people, "seen", lambda _observation: (visitor,))
    orders["greet"] = agent.routines.greet(observation, example.memory, "player_0")
    orders["follow"] = agent.routines.follow(observation, example.memory, "player_0")
    orders["avoid"] = agent.routines.avoid(observation, example.memory, pump["id"])
    orders["watch"] = agent.routines.watch(observation, example.memory, pump["id"])
    monkeypatch.setattr(agent.routines.layout, "building_at", lambda _observation, _position: "home_0")
    orders["sleep_at"] = agent.routines.sleep_at(observation, example.memory, "home_0")

    assert set(orders) == {
        "go_to",
        "wander",
        "tend",
        "rest",
        "gather_at",
        "greet",
        "follow",
        "avoid",
        "watch",
        "sleep_at",
    }
    assert all(order is not None for order in orders.values())
    assert orders["tend"]["action"] == 1
    assert orders["greet"]["action"] == 2
    assert orders["watch"]["speed"] == 0.0
    assert orders["sleep_at"]["action"] == 9
    assert all(env.action_space("player_1").contains(order) for order in orders.values())


def test_go_to_replans_after_a_stalled_position(scene, monkeypatch):
    example, observation = _example(scene)
    start, east, north, destination = (0, 0), (1, 0), (0, 1), (2, 0)
    example.memory["graph"] = {
        start: ((east, 1.0), (north, 1.0)),
        east: ((start, 1.0), (destination, 1.0)),
        north: ((start, 1.0), ((1, 1), 1.0)),
        (1, 1): ((north, 1.0), ((2, 1), 1.0)),
        (2, 1): (((1, 1), 1.0), (destination, 1.0)),
        destination: ((east, 1.0), ((2, 1), 1.0)),
    }
    monkeypatch.setattr(agent.routines.me, "position", lambda _observation: {"x": 0.5, "y": 0.5})
    monkeypatch.setattr(agent.routines.layout, "cell_at", lambda _observation, _position: {"x": 0, "y": 0})
    monkeypatch.setattr(
        agent.routines.layout, "nearest_walkable", lambda _observation, _position: {"x": 2, "y": 0}
    )
    routes = iter(([start, east, destination], [start, north, (1, 1), (2, 1), destination]))
    calls = []

    def reroute(_graph, route_start, route_destination):
        calls.append((route_start, route_destination))
        return list(next(routes))

    monkeypatch.setattr(agent.routines.routing, "path", reroute)
    goal = {"x": 2.5, "y": 0.5}

    assert agent.routines.go_to(observation, example.memory, goal)["heading"] == 0.0
    assert agent.routines.go_to(observation, example.memory, goal)["heading"] == 90.0
    assert calls == [(start, destination), (start, destination)]


def test_dialogue_keeps_latest_capped_direct_lines_and_falls_back(scene):
    _example_agent, observation = _example(scene)
    nearby = copy.deepcopy(observation)
    nearby["nearby"] = (_visitor_at(me.position(observation)),)
    conversation = dialogue.Dialogue("the baker")
    conversation.llm = fake = _FakeLLM()
    conversation.observe(nearby)
    conversation.receive([{"from": "player_0", "to": None, "text": "current"}])
    assert conversation.messages() == []
    conversation.receive(
        [
            {"from": "player_0", "to": None, "text": "older"},
            {"from": "player_0", "to": None, "text": "  newest line  "},
        ]
    )
    fake.answer = "Current reply."
    assert conversation.messages() == [{"to": "player_0", "text": "Current reply."}]
    assert conversation.messages() == []
    assert fake.requests[-1]["messages"][-1]["content"] == "newest line"
    fake.answer = "x" * 250
    assert conversation.messages() == [{"to": "player_0", "text": "x" * 200}]
    conversation.receive([{"from": "player_0", "to": "player_1", "text": "One more"}])
    assert conversation.messages() == []
    fake.error = RuntimeError("budget exhausted")
    assert conversation.messages() == [{"to": "player_0", "text": dialogue.FALLBACK}]


def test_dialogue_answers_neighbors_with_a_script_and_ends_the_exchange(scene):
    _example_agent, observation = _example(scene)
    here = me.position(observation)
    nearby = copy.deepcopy(observation)
    nearby["nearby"] = (
        {"id": "player_3", "position": dict(here)},
        {"id": "player_4", "position": dict(here)},
    )
    conversation = dialogue.Dialogue("the baker")
    conversation.llm = fake = _FakeLLM()
    conversation.observe(nearby)

    # A neighbor's line to everyone is overheard, and a line to this resident gets the canned answer.
    conversation.receive(
        [
            {"from": "player_4", "to": None, "text": "Lovely weather."},
            {"from": "player_3", "to": "player_1", "text": dialogue.GOOD_DAY},
        ]
    )
    assert conversation.messages() == [{"to": "player_3", "text": dialogue.GOOD_DAY_REPLY}]
    assert conversation.messages() == []
    assert fake.requests == []

    # Opening a conversation: one line per listener per tick, and the answer ends it.
    assert conversation.say("player_4", dialogue.GOOD_DAY)
    assert not conversation.say("player_4", "Again.")
    assert not conversation.say("player_9", "Nobody hears this.")
    assert conversation.messages() == [{"to": "player_4", "text": dialogue.GOOD_DAY}]
    conversation.receive([{"from": "player_4", "to": "player_1", "text": dialogue.GOOD_DAY_REPLY}])
    assert conversation.messages() == []

    # Once the neighbor walks away and comes back, a new conversation can start.
    conversation.observe(dict(nearby, nearby=()))
    conversation.observe(nearby)
    conversation.receive([{"from": "player_4", "to": "player_1", "text": dialogue.GOOD_DAY}])
    assert conversation.messages() == [{"to": "player_4", "text": dialogue.GOOD_DAY_REPLY}]


def test_dialogue_invalidates_for_hearing_loss_and_a_real_wall(scene):
    _example_agent, observation = _example(scene)
    home = next(item for item in layout.buildings(observation) if item["type"] == "home")
    width, height = layout.BUILDING_SIZES["home"]
    origin = home["cell"]
    blocked_pair = None
    for y in range(int(origin["y"]) + 1, int(origin["y"]) + height - 1):
        outside = {"x": float(origin["x"]) - 0.5, "y": y + 0.5}
        inside = {"x": float(origin["x"]) + 1.5, "y": y + 0.5}
        if not layout.line_of_sight(observation, outside, inside):
            blocked_pair = outside, inside
            break
    assert blocked_pair is not None
    wall_observer, wall_visitor = blocked_pair
    assert geometry.distance(wall_observer, wall_visitor) <= geometry.HEARING_RANGE
    assert not layout.line_of_sight(observation, wall_observer, wall_visitor)

    hearing_observer = {"x": 0.0, "y": 0.0}
    hearing_visitor = {"x": geometry.HEARING_RANGE + 1.0, "y": 0.0}
    assert geometry.distance(hearing_observer, hearing_visitor) > geometry.HEARING_RANGE

    for observer_position, visitor_position in (
        (hearing_observer, hearing_visitor),
        (wall_observer, wall_visitor),
    ):
        clear = copy.deepcopy(observation)
        clear["self"]["position"] = observer_position
        clear["nearby"] = (_visitor_at(observer_position),)
        conversation = dialogue.Dialogue("the baker")
        conversation.llm = fake = _FakeLLM()
        conversation.observe(clear)
        conversation.receive([{"from": "player_0", "to": None, "text": "Can you hear me?"}])
        assert conversation.messages() == []

        invalid = copy.deepcopy(observation)
        invalid["self"]["position"] = observer_position
        invalid["nearby"] = ()
        invalid["seen"] = (_visitor_at(visitor_position),)
        conversation.observe(invalid)
        fake.answer = "This reply is stale."
        assert conversation.messages() == []
        assert conversation.waiting == {}


def test_seeded_season_four_day_moves_works_and_sleeps_with_legal_actions():
    env = make_env(resolve_parameters(META, SEASON_4))
    observations, _ = env.reset(seed=0)
    residents = {player: agent.Agent() for player in observations if player != "player_0"}
    for player, resident in residents.items():
        resident.reset(0, observations[player])

    starts = {player: dict(me.position(observations[player])) for player in residents}
    moved = set()
    use_phases = {player: set() for player in residents}
    slept = set()
    sleep_action = action.stand(0.0, "sleep")["action"]
    ticks = 0

    while env.agents:
        phases = {player: observations[player]["phase"] for player in residents}
        orders = {"player_0": action.stand(me.heading(observations["player_0"]))}
        orders.update({player: resident.act(observations[player]) for player, resident in residents.items()})
        assert all(env.action_space(player).contains(order) for player, order in orders.items())
        commanded_use = {player for player in residents if orders[player]["action"] == 1}
        commanded_sleep = {player for player in residents if orders[player]["action"] == sleep_action}
        observations, _rewards, _terminations, _truncations, _infos = env.step(orders)
        ticks += 1

        for player in residents:
            position = me.position(observations[player])
            if (
                abs(float(position["x"]) - float(starts[player]["x"]))
                + abs(float(position["y"]) - float(starts[player]["y"]))
                > 5.0
            ):
                moved.add(player)
        for player in commanded_use:
            assert observations[player]["self"]["expression"]["type"] == "use"
            use_phases[player].add(phases[player])
        for player in commanded_sleep:
            order = agent.routines.sleep_at(
                observations[player], residents[player].memory, residents[player].memory["home"]
            )
            assert order is not None and order["action"] == sleep_action
            slept.add(player)

    expected = set(residents)
    assert ticks == 1200
    assert moved == expected
    assert {"morning", "evening"} <= {phase for phases in use_phases.values() for phase in phases}
    assert slept == expected
    assert all(
        agent.routines.sleep_at(
            observations[player], residents[player].memory, residents[player].memory["home"]
        )["action"]
        == sleep_action
        for player in residents
    )
    env.close()
