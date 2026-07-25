"""Integration: the chatting Spades examples over the real harness, recording the exchange.

Drives ``run_episode`` on the real Spades ``ENTRY`` with the colocated ``examples`` agents loaded by
path (with a composed base+spades ``sandbox`` package on ``sys.path`` so their ``sandbox.cards``
import — which itself now imports the shared ``sandbox.card_utils`` codec — resolves exactly as it
does in a real composed template). Proves the signaler's targeted exchange and the daredevil's
broadcast land in the recording, and that the daredevil's cover provably depends on the broadcast
arriving.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

from game_sandbox_harness.environment import resolve_parameters
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, run_episode
from spades import ENTRY

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from compose import compose_template  # noqa: E402

# Build the composed sandbox once in a session-scoped temp directory, so the example agents'
# `from sandbox.cards import ...` resolves exactly as it does for a real student template without
# reaching into scripts.compose's shared build/ output directory.
_COMPOSED_ROOT = Path(tempfile.mkdtemp(prefix="spades_chat_compose_"))
compose_template("spades", out_dir=_COMPOSED_ROOT)


def _load_example_agent(name: str) -> type:
    """Load the colocated ``examples/<name>/agent.py`` class with the template's helpers visible.

    Mirrors the harness template-loader recipe: put the composed env template layer on ``sys.path``
    so the example's ``from sandbox.cards import ...`` (and its own ``from sandbox.card_utils
    import ...``) resolves, load under a unique module name, then restore ``sys.path`` and the
    ``sandbox`` modules so nothing leaks into other tests.
    """
    path = REPO_ROOT / "environments" / "spades" / "examples" / name / "agent.py"
    saved_path = list(sys.path)
    saved_sandbox = {k: v for k, v in sys.modules.items() if k == "sandbox" or k.startswith("sandbox.")}
    for key in saved_sandbox:
        del sys.modules[key]
    sys.path.insert(0, str(_COMPOSED_ROOT))
    try:
        spec = importlib.util.spec_from_file_location(f"example_spades_{name}", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.Agent
    finally:
        sys.path[:] = saved_path
        for key in [k for k in sys.modules if k == "sandbox" or k.startswith("sandbox.")]:
            del sys.modules[key]
        sys.modules.update(saved_sandbox)


Signaler = _load_example_agent("signaler")
Daredevil = _load_example_agent("daredevil")
Counter = _load_example_agent("counter")


def _play(players, seed: int, tmp_path: Path, *, messaging=None):
    """Run one episode and return ``(states, result)``. Final scores come from the result: terminal
    rewards are credited to every player but recorded only on the acting player's line, so the recording
    alone cannot report a non-actor's terminal (for example nil) score."""
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        ENTRY,
        players,
        parameters=resolve_parameters(ENTRY.meta),
        seed=seed,
        store=store,
        recording_id="r",
        messaging=messaging,
    )
    return list(store.open("r").steps()), result


def _messages_at(states: list[dict], tick: int) -> list[dict]:
    for state in states:
        if state["tick"] == tick:
            return state.get("messages", [])
    return []


def test_signaler_exchange_replays_in_the_recording(tmp_path: Path):
    # Signalers partner at 0/2, chat-less counters at 1/3. On seed 2 both signalers speak: player 0
    # names hearts to player 2, and player 2 names diamonds to player 0, each on its own bidding tick.
    players = {
        "player_0": AgentPlayer(Signaler()),
        "player_1": AgentPlayer(Counter()),
        "player_2": AgentPlayer(Signaler()),
        "player_3": AgentPlayer(Counter()),
    }
    states, _result = _play(players, seed=2, tmp_path=tmp_path)

    assert _messages_at(states, 0) == [{"from": "player_0", "to": "player_2", "text": "strong:hearts"}]
    assert _messages_at(states, 2) == [{"from": "player_2", "to": "player_0", "text": "strong:diamonds"}]
    # The chatting player is charged chat time on the tick it spoke.
    tick0 = next(s for s in states if s["tick"] == 0)
    assert "chat_ms" in tick0["agents"]["player_0"]["timing"]


def test_daredevil_demo_hand_bids_nil_warns_and_scores(tmp_path: Path):
    # The stage demo hand: on seed 1236 player 0 qualifies for nil, bids it, and broadcasts the warning
    # its partner covers. The made nil lands in the final team score.
    players = {
        "player_0": AgentPlayer(Daredevil()),
        "player_1": AgentPlayer(Counter()),
        "player_2": AgentPlayer(Daredevil()),
        "player_3": AgentPlayer(Counter()),
    }
    states, result = _play(players, seed=1236, tmp_path=tmp_path)

    tick0 = next(s for s in states if s["tick"] == 0)
    assert tick0["agents"]["player_0"]["action"] == 52  # the nil bid (bid_to_action(0))
    assert _messages_at(states, 0) == [{"from": "player_0", "to": None, "text": "nil! cover me"}]

    # The made nil, shared by the partnership: +121 for players 0 and 2.
    assert result.scores == {"player_0": 121.0, "player_1": 46.0, "player_2": 121.0, "player_3": 46.0}


def test_daredevil_cover_provably_depends_on_the_broadcast(tmp_path: Path):
    # Same seed, once with messaging and once without. With the warning, player 2 covers its nil-bidding
    # partner and the play sequence differs; without it, no message is ever recorded and the nil is set.
    def run(messaging, sub: str) -> tuple[list[int], list[dict], dict]:
        players = {
            "player_0": AgentPlayer(Daredevil()),
            "player_1": AgentPlayer(Counter()),
            "player_2": AgentPlayer(Daredevil()),
            "player_3": AgentPlayer(Counter()),
        }
        states, result = _play(players, seed=1236, tmp_path=tmp_path / sub, messaging=messaging)
        player2 = [s["agents"]["player_2"]["action"] for s in states if "player_2" in s["agents"]]
        every_message = [m for s in states for m in s.get("messages", [])]
        return player2, every_message, result.scores

    player2_on, messages_on, finals_on = run(True, "on")
    player2_off, messages_off, finals_off = run(False, "off")

    # The partner's play changed because a message arrived.
    assert player2_on != player2_off
    # Messaging off records no messages at all, and the uncovered nil is set (the team score drops).
    assert messages_off == []
    assert messages_on  # the broadcast (and any signals) are present with messaging on
    assert finals_on["player_0"] > 0 > finals_off["player_0"]
