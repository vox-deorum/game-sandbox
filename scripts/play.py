"""Play a registered environment locally, with a window, bypassing the backend entirely.

    npm run play -- flappy_bird          # you play; space/up or click flaps
    npm run play -- flappy_bird agent    # watch the bundled example agent
    npm run play -- hearts               # click your legal cards; bots play the rest
    npm run play -- hearts watch         # all seats auto-play the built-in baseline
    npm run play -- <env> --agent-repo ./my-agent   # play your own manifest.json agent

This is the maintainer counterpart to the student template's local play: it resolves any
environment through the entry-point registry (so it works for every installed env), opens it in
``render_mode="human"``, and drives the same agent-environment cycle the server runs — with no
Docker, no session, no network. ``mode`` is ``human`` (default), ``agent``, or ``watch``.

Every mode begins paused on the first frame: a shared, env-agnostic start gate freezes there
until the player presses a key or clicks, so a realtime game is not already falling before they
are ready, and ends on a matching game-over banner that holds the final score until the player
dismisses it. Two loop shapes are then selected by the env's ``pace_interval_ms``: a realtime env
(Flappy Bird) runs at a fixed cadence and samples human input non-blocking each tick, while a
turn-based env (Hearts) blocks for the human's move and gives bot moves a beat so they are
followable. The only per-environment piece is human input (keyboard vs. mouse), discovered by
convention from each env's ``<package>.human`` module (``make_human_controller``); an env without
one simply cannot be played as a human.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import numpy as np
import pygame

from _paths import EXAMPLES_DIR
from game_sandbox_harness.environment import (
    EnvironmentEntry,
    EnvironmentLookupError,
    load_environment,
)
from game_sandbox_harness.manifest import load_agent
from local_play.hidpi import display_scale, enable_hidpi

#: The play modes, in CLI order: human play, watch the example agent, watch the baseline.
MODES = ("human", "agent", "watch")

#: How long a bot move lingers on screen in a turn-based env, so a human can follow it.
_BOT_PAUSE_S = 0.6

#: The banner shown over the frozen first frame until the player begins the episode.
_START_PROMPT = "Press any key or click to start"

#: The dismiss hint shown under the leaderboard on the game-over screen.
_GAME_OVER_FOOTER = "Press any key to exit"

#: The cups awarded to the top three finishers, by rank (0=gold, 1=silver, 2=bronze). RGB. Kept in
#: step with the web's GameOverCard.vue MEDAL_COLOR.
_CUP_COLORS: tuple[tuple[int, int, int], ...] = ((236, 200, 112), (200, 204, 210), (205, 127, 50))

#: env id -> (agent source file, class name) for the example agent ``agent`` mode plays. The
#: shipped examples are compose overlays without a manifest, so they are loaded by file path.
EXAMPLE_AGENTS: dict[str, tuple[Path, str]] = {
    "flappy_bird": (EXAMPLES_DIR / "flappy_bird" / "hello" / "agent.py", "Agent"),
}


def _load_example_agent(env_id: str) -> Any | None:
    """Instantiate the bundled example agent for ``env_id`` by file path, or ``None`` if none."""
    spec_entry = EXAMPLE_AGENTS.get(env_id)
    if spec_entry is None:
        return None
    path, class_name = spec_entry
    spec = importlib.util.spec_from_file_location(f"_example_agent_{env_id}", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, class_name)()


def _human_controller_factory(entry: EnvironmentEntry) -> Callable[[Any], Any] | None:
    """Return the env's ``make_human_controller`` by convention, or ``None`` if it ships none.

    The factory module is the ``human`` submodule of the package that defines the env factory
    (e.g. ``flappy_bird.human`` for a ``flappy_bird.env.make_env``). This keeps local pygame play
    out of the shared registry contract — only envs that want it provide a ``human.py``. We probe
    for the module with ``find_spec`` rather than catching ``ImportError`` around the import, so a
    real import failure *inside* an existing ``human.py`` surfaces instead of masquerading as "no
    human play".
    """
    module_name = f"{entry.make.__module__.split('.')[0]}.human"
    if importlib.util.find_spec(module_name) is None:
        return None
    module = importlib.import_module(module_name)
    return getattr(module, "make_human_controller", None)


def _quit_requested() -> bool:
    """True if the window was closed since the last check (non-human-controlled steps only).

    Filters just ``QUIT`` from the queue so any pending input events stay for the controller.
    """
    if not pygame.get_init():
        return False
    return bool(pygame.event.get(pygame.QUIT))


def _banner_scale(surface: pygame.Surface) -> float:
    """A font scale derived from the window height, so a banner tracks the (HiDPI-upscaled) window.

    Flappy Bird's window is its 512px-tall frame times an integer HiDPI factor; Hearts opens its
    own window. Sizing fonts off the height keeps the banner proportional on both without either
    needing to know the scale factor. Clamped so a tiny or huge window stays legible.
    """
    return max(0.7, min(3.0, surface.get_height() / 512.0))


def _wrap_text(font: pygame.font.Font, text: str, max_width: int) -> list[str]:
    """Greedily wrap ``text`` into lines no wider than ``max_width`` pixels when drawn in ``font``."""
    lines: list[str] = []
    current = ""
    for word in text.split():
        trial = f"{current} {word}".strip()
        if current and font.size(trial)[0] > max_width:
            lines.append(current)
            current = word
        else:
            current = trial
    if current:
        lines.append(current)
    return lines or [text]


def _draw_banner(
    surface: pygame.Surface,
    sections: list[tuple[pygame.font.Font, tuple[int, int, int], str]],
) -> None:
    """Dim ``surface`` and draw centered, word-wrapped ``(font, color, text)`` sections over it.

    Sections stack top-to-bottom as one vertically-centered block, and each section's text wraps to
    the window width (less a margin) so a long prompt or score never clips on a narrow, portrait
    screen like Flappy Bird's. The caller flips after; we leave the frame underneath intact.
    """
    margin = max(12, surface.get_width() // 12)
    max_width = surface.get_width() - 2 * margin
    rendered = [
        font.render(line, True, color)
        for font, color, text in sections
        for line in _wrap_text(font, text, max_width)
    ]
    gap = max(4, surface.get_height() // 64)
    total = sum(label.get_height() for label in rendered) + gap * (len(rendered) - 1)
    overlay = pygame.Surface(surface.get_size(), pygame.SRCALPHA)
    overlay.fill((0, 0, 0, 110))
    centre_x = surface.get_width() // 2
    y = (surface.get_height() - total) // 2
    for label in rendered:
        overlay.blit(label, label.get_rect(midtop=(centre_x, y)))
        y += label.get_height() + gap
    surface.blit(overlay, (0, 0))
    pygame.display.flip()


def _wait_for_dismiss() -> bool:
    """Block until a key/click (returns ``True``) or a window close (returns ``False``)."""
    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False
            if event.type in (pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN):
                return True
        time.sleep(0.02)


def _wait_for_start(prompt: str = _START_PROMPT) -> bool:
    """Block until the player presses a key or clicks; return ``False`` if they quit instead.

    A single env-agnostic start gate for every game: it draws a shared banner over whatever the
    env rendered into the active display surface (so it works for the Flappy Bird window and the
    Hearts renderer alike) and freezes there until an input edge arrives. The banner is wiped by
    the first ``render``/``step`` once play begins. A no-op (returns ``True``) when there is no
    window, so it never blocks a headless run.
    """
    if not pygame.display.get_init():
        return True
    surface = pygame.display.get_surface()
    if surface is None:
        return True
    print(prompt)
    pygame.font.init()
    scale = _banner_scale(surface)
    _draw_banner(surface, [(pygame.font.Font(None, int(34 * scale)), (255, 255, 255), prompt)])
    return _wait_for_dismiss()


def _slot_index(slot: str) -> int | None:
    """``'player_3'`` -> ``3``; ``None`` when the slot id has no trailing integer index."""
    last = slot.rsplit("_", 1)[-1]
    return int(last) if last.isdigit() else None


def _slot_label(slot: str) -> str:
    """``'player_3'`` -> ``'P3'`` (the compact seat label); any other slot id is shown as-is."""
    seat = _slot_index(slot)
    return f"P{seat}" if seat is not None else slot


def _standings(
    entry: EnvironmentEntry, env: Any, scores: dict[str, float]
) -> list[tuple[str, str, int | None]]:
    """Return the final leaderboard rows, best-first, as ``(label, value, cup_rank)``.

    Ranks by the cumulative reward (higher is better at terminal for every env), so the gold cup
    goes to the winner. The displayed ``value`` is each game's natural score, read overlay-first
    (Hearts' per-seat penalties, Flappy Bird's pipes passed), falling back to the rounded reward
    total for an env that ships no overlay score. Cups are awarded by **dense** ranking so ties
    share: seats with equal rewards get the same ``cup_rank`` and the next distinct (lower) reward
    takes the next rank with no gap, so a partnership game's winning pair both show gold and the
    losing pair both silver. ``cup_rank`` is 0/1/2 for the top three dense ranks, else ``None``. The
    Python twin of the web's ``buildStandings`` in frontend/src/lib/standings.ts: same standings,
    but here every seat's reward is in this live ``scores`` tally, whereas a recording stores only
    the acting agent per tick, so the web reconstructs the seats from the overlay instead.
    """
    overlay = entry.overlay(env) if entry.overlay is not None else None
    display = overlay.get("display_scores") if isinstance(overlay, dict) else None
    pipes = overlay.get("pipes_passed") if isinstance(overlay, dict) else None

    rows: list[tuple[str, str, int | None]] = []
    dense_rank = -1
    prev_reward: float | None = None
    for slot, reward in sorted(scores.items(), key=lambda kv: kv[1], reverse=True):
        # Dense ranking: a new (lower) reward advances the rank by one; an equal reward keeps it, so
        # tied seats share a cup. Partners share a leaderboard score by construction, so this is what
        # gives a tied partnership two matching medals instead of splitting them by row position.
        if prev_reward is None or reward != prev_reward:
            dense_rank += 1
            prev_reward = reward
        seat = _slot_index(slot)
        if isinstance(display, (list, tuple)) and seat is not None and seat < len(display):
            value = f"{display[seat]}"
        elif pipes is not None:
            value = f"{pipes}"
        else:
            value = f"{round(reward, 2)}"
        rows.append((_slot_label(slot), value, dense_rank if dense_rank < len(_CUP_COLORS) else None))
    return rows


def _draw_cup(
    surface: pygame.Surface, center: tuple[int, int], size: int, color: tuple[int, int, int]
) -> None:
    """A small trophy cup (bowl + stem + base) centred at ``center``, filled ``color``."""
    cx, cy = center
    top = cy - size // 2
    bowl = [
        (cx - size // 2, top),
        (cx + size // 2, top),
        (cx + size // 5, top + int(size * 0.55)),
        (cx - size // 5, top + int(size * 0.55)),
    ]
    pygame.draw.polygon(surface, color, bowl)
    stem = pygame.Rect(0, 0, max(2, size // 6), int(size * 0.2))
    stem.center = (cx, top + int(size * 0.66))
    pygame.draw.rect(surface, color, stem)
    base = pygame.Rect(0, 0, int(size * 0.5), max(2, size // 8))
    base.midbottom = (cx, top + size)
    pygame.draw.rect(surface, color, base)


def _draw_leaderboard(surface: pygame.Surface, rows: list[tuple[str, str, int | None]], scale: float) -> None:
    """Dim ``surface`` and draw the centred game-over leaderboard, then flip.

    A "Game over" title, then one row per finisher — ``[cup] label … value`` — as a block bounded
    by a top rule and a bottom rule only (no box), then the dismiss hint. The cup is a small trophy
    in gold/silver/bronze for the top three. The Python twin of GameOverCard.vue.
    """
    overlay = pygame.Surface(surface.get_size(), pygame.SRCALPHA)
    overlay.fill((0, 0, 0, 140))  # the dimmed backdrop over the final frame

    title_font = pygame.font.Font(None, int(34 * scale))
    row_font = pygame.font.Font(None, int(26 * scale))
    foot_font = pygame.font.Font(None, int(20 * scale))
    gold, white, muted, rule = (236, 200, 112), (240, 240, 238), (190, 196, 204), (150, 124, 60)

    cx = surface.get_width() // 2
    pad = int(12 * scale)
    half_w = min(int(150 * scale), surface.get_width() // 2 - pad)
    cup = int(20 * scale)
    row_h = int(34 * scale)
    gap = int(12 * scale)

    title = title_font.render("Game over", True, gold)
    foot = foot_font.render(_GAME_OVER_FOOTER, True, muted)
    total = title.get_height() + gap + len(rows) * row_h + gap + foot.get_height()
    y = (surface.get_height() - total) // 2

    overlay.blit(title, title.get_rect(midtop=(cx, y)))
    y += title.get_height() + gap

    left, right = cx - half_w, cx + half_w
    line_w = max(1, int(scale))
    pygame.draw.line(overlay, rule, (left, y), (right, y), line_w)
    for i, (label, value, rank) in enumerate(rows):
        row_cy = y + i * row_h + row_h // 2
        if rank is not None:
            _draw_cup(overlay, (left + pad + cup // 2, row_cy), cup, _CUP_COLORS[rank])
        label_s = row_font.render(label, True, white if rank is not None else muted)
        overlay.blit(label_s, label_s.get_rect(midleft=(left + pad + cup + pad, row_cy)))
        value_s = row_font.render(value, True, white)
        overlay.blit(value_s, value_s.get_rect(midright=(right - pad, row_cy)))
    y += len(rows) * row_h
    pygame.draw.line(overlay, rule, (left, y), (right, y), line_w)
    y += gap

    overlay.blit(foot, foot.get_rect(midtop=(cx, y)))
    surface.blit(overlay, (0, 0))
    pygame.display.flip()


def _show_game_over(entry: EnvironmentEntry, env: Any, scores: dict[str, float]) -> None:
    """Hold on a shared, env-agnostic game-over leaderboard over the final frame until dismissed.

    Dims the final frame, then draws "Game over" and the ranked standings — each game's natural
    score, with gold/silver/bronze cups for the top three, bounded by a top and bottom rule only —
    and blocks until a key/click or window close. A no-op when headless (no display/surface), so it
    never blocks a windowless run or one the player already quit. The web twin is GameOverCard.vue.
    """
    if not pygame.display.get_init():
        return
    surface = pygame.display.get_surface()
    if surface is None:
        return
    pygame.font.init()
    _draw_leaderboard(surface, _standings(entry, env, scores), _banner_scale(surface))
    _wait_for_dismiss()


def _play(
    entry: EnvironmentEntry,
    *,
    mode: str,
    seat: int,
    seed: int,
    max_steps: int | None,
    agent_override: Any | None,
) -> tuple[dict[str, float], int, str]:
    """Run one episode in a window; return ``(per-slot scores, ticks, stop reason)``."""
    make = cast("Callable[..., Any]", entry.make)
    # Turn-based envs (Hearts) render their own DPI-aware "human" window. Realtime envs (Flappy
    # Bird) come from a fixed-resolution third-party library whose window can't be enlarged without
    # breaking game logic, so we drive them in "rgb_array" and upscale each frame into our own
    # DPI-aware window below — the only way to make them crisp on a HiDPI screen. pace_interval_ms
    # is None exactly for turn-based envs.
    turn_based = entry.meta.pace_interval_ms is None
    env = make(render_mode="human" if turn_based else "rgb_array")

    human_slots = entry.meta.human_slots
    human_slot = human_slots[seat] if (mode == "human" and human_slots) else None

    controller = None
    if mode == "human":
        factory = _human_controller_factory(entry)
        if factory is None:
            raise SystemExit(f"environment {entry.meta.env_id!r} does not support human play")
        controller = factory(env)

    example_agent = agent_override
    if example_agent is None and mode == "agent":
        example_agent = _load_example_agent(entry.meta.env_id)
        if example_agent is None:
            print(f"note: {entry.meta.env_id!r} ships no example agent; using the built-in baseline")

    def action_for(agent_id: str, observation: Any) -> Any:
        """The action for a non-human seat: the example agent if present, else the baseline."""
        if example_agent is not None:
            return example_agent.act(observation)
        return entry.default_action(agent_id)

    env.reset(seed=seed)
    # Hearts (and any seat-aware env) shows the chosen seat at the bottom; reveal hands when no
    # one is playing it by hand, so a watcher can see the whole table.
    if hasattr(env, "view_seat"):
        env.view_seat = seat
    if mode != "human" and hasattr(env, "reveal_all"):
        env.reveal_all = True
    if example_agent is not None and hasattr(example_agent, "reset"):
        example_agent.reset(seed)

    scores: dict[str, float] = {}
    tick = 0
    # Realtime presentation state: our own window + a pacing clock. Unused for turn-based envs,
    # which open and pace their own window via render().
    screen: pygame.Surface | None = None
    clock = pygame.time.Clock()
    pace_ms = entry.meta.pace_interval_ms
    pace_fps = round(1000.0 / pace_ms) if pace_ms is not None else 0

    def present_realtime() -> None:
        """Upscale the realtime env's rgb frame by an integer factor into our HiDPI window."""
        nonlocal screen
        frame = env.render()
        if frame is None:
            return
        height, width = int(frame.shape[0]), int(frame.shape[1])
        if screen is None:
            if not pygame.get_init():
                pygame.init()
            factor = max(1, round(display_scale()))
            screen = pygame.display.set_mode((width * factor, height * factor))
            pygame.display.set_caption(entry.meta.display_name)
        # Nearest-neighbour (not smoothscale) keeps the pixel-art sprites crisp at integer scale.
        surf = pygame.surfarray.make_surface(np.transpose(frame, (1, 0, 2)))
        pygame.transform.scale(surf, screen.get_size(), screen)
        pygame.display.flip()

    try:
        # Open the window / build the renderer before the loop touches it.
        if turn_based:
            env.render()
        else:
            present_realtime()
        if not _wait_for_start():  # every game begins on a manual interaction, not on open
            return scores, tick, "quit"
        reason = "terminal"
        while env.agents:
            agent_id = env.agent_selection
            observation, _reward, termination, truncation, _info = env.last()
            if termination or truncation:
                env.step(None)
                continue

            if controller is not None and agent_id == human_slot:
                action = controller.act(agent_id, observation, blocking=turn_based)
                if controller.quit:
                    return scores, tick, "quit"
            else:
                if _quit_requested():
                    return scores, tick, "quit"
                if turn_based:
                    # Let the bot's move sit on screen a beat so it is followable.
                    env.render()
                    time.sleep(_BOT_PAUSE_S)
                action = action_for(agent_id, observation)

            env.step(action)
            for rewarded_slot, reward in env.rewards.items():
                scores[rewarded_slot] = scores.get(rewarded_slot, 0.0) + float(reward)
            # Turn-based: draw the resulting frame. Realtime: upscale it into our window and pace
            # the loop ourselves (the rgb_array env does neither inside step).
            if turn_based:
                env.render()
            else:
                present_realtime()
                clock.tick(pace_fps)

            tick += 1
            if max_steps is not None and tick >= max_steps:
                reason = "max_steps"
                break
        # The episode ended in play (a crash, a finished hand, or the step cap) rather than by the
        # player quitting: hold on the shared game-over banner with the final score until they
        # dismiss it, before the window closes in ``finally``.
        _show_game_over(entry, env, scores)
        return scores, tick, reason
    finally:
        env.close()


def main(argv: list[str] | None = None) -> int:
    # Make the process DPI-aware before any window opens, so HiDPI displays render our windows at
    # physical pixels (crisp) instead of bitmap-stretching them (blurry).
    enable_hidpi()
    parser = argparse.ArgumentParser(
        prog="npm run play --",
        description="Play a registered environment locally, in a window, without the backend.",
    )
    parser.add_argument("env_id", help="environment id, for example flappy_bird or hearts")
    parser.add_argument(
        "mode",
        nargs="?",
        default="human",
        choices=MODES,
        help="human (default), agent (example agent), or watch (built-in baseline)",
    )
    parser.add_argument("--seat", type=int, default=0, help="human seat index for multi-slot envs")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--steps", type=int, help="cap the episode at this many steps")
    parser.add_argument(
        "--agent-repo",
        metavar="PATH",
        help="play a manifest.json agent repo in every seat (implies agent mode)",
    )
    args = parser.parse_args(argv)

    try:
        entry = load_environment(args.env_id)
    except EnvironmentLookupError as error:
        print(error, file=sys.stderr)
        return 2

    mode = "agent" if args.agent_repo else args.mode
    agent_override = load_agent(args.agent_repo) if args.agent_repo else None

    human_slots = entry.meta.human_slots
    if mode == "human" and not human_slots:
        print(f"environment {args.env_id!r} has no human-playable slots", file=sys.stderr)
        return 2
    if human_slots and not 0 <= args.seat < len(human_slots):
        print(
            f"--seat must be in [0, {len(human_slots)}) for {args.env_id!r}",
            file=sys.stderr,
        )
        return 2

    scores, ticks, reason = _play(
        entry,
        mode=mode,
        seat=args.seat,
        seed=args.seed,
        max_steps=args.steps,
        agent_override=agent_override,
    )

    rounded = {slot: round(score, 2) for slot, score in scores.items()}
    print(f"environment : {args.env_id}")
    print(f"mode        : {mode}")
    print(f"seed        : {args.seed}")
    print(f"ticks       : {ticks}")
    print(f"reason      : {reason}")
    print(f"scores      : {rounded}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
