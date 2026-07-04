"""Game-agnostic pygame renderer base for the local play windows.

:class:`PygameRenderer` owns the parts of a pygame renderer that have nothing to do with any
particular game: the lazy font / offscreen-surface init, the HiDPI device-pixel scale, the
wall-clock ``_pulse`` used for breathing highlights, the small colour-lerp helper, and the
rgb_array-vs-window frame tail (:meth:`_finish_frame`). A concrete renderer subclasses it and
supplies the drawing; :mod:`local_play.render_cards` is the four-seat card-table layer built on it.

Like :mod:`local_play.hidpi`, this module is import-self-contained — it imports only third-party
packages (``pygame``, ``numpy``) and its sibling ``hidpi`` (relatively, ``from . import hidpi``),
never the harness — so ``scripts/generate.py`` syncs it verbatim into the student template (as
``sandbox.render_base``) alongside the other shared helpers. The relative ``hidpi`` import resolves
in both layouts (``local_play.hidpi`` in the monorepo, ``sandbox.hidpi`` in the composed template)
because the two modules are always siblings; this is why the base can import it directly and the
per-game renderers no longer need their own dual-name shim to reach it.
"""

from __future__ import annotations

import math

import numpy as np
import pygame

from . import hidpi


class PygameRenderer:
    """Own the game-agnostic pygame lifecycle: fonts, the offscreen surface, and the window.

    Subclasses set :attr:`WIDTH` / :attr:`HEIGHT` / :attr:`WINDOW_CAPTION` (or keep the defaults)
    and draw into ``self._surface`` inside their ``render``; :meth:`_finish_frame` turns that
    surface into an rgb_array or mirrors it onto the human window. The renderer lazily initializes
    pygame on the first render so the module stays importable without a display, and only opens a
    window in ``"human"`` mode.
    """

    #: Fixed window / frame dimensions in pixels (subclasses may override).
    WIDTH = 960
    HEIGHT = 720
    #: The window title shown in ``"human"`` mode (subclasses override with the game name).
    WINDOW_CAPTION = "Game"

    def __init__(self, render_mode: str) -> None:
        """Store ``render_mode`` (``"human"`` or ``"rgb_array"``); defer pygame init to render."""
        self.render_mode = render_mode
        self._inited = False
        #: Device-pixel scale for HiDPI native rendering; resolved in _ensure_init (1.0 headless).
        self.scale: float = 1.0
        self._screen: pygame.Surface | None = None
        self._surface: pygame.Surface | None = None
        # Fonts are bound in _ensure_init() (run at the top of every render); declared with their
        # concrete type rather than None-initialised so the draw helpers see Font, not Font | None.
        self._font: pygame.font.Font
        self._font_small: pygame.font.Font

    # -- lifecycle -----------------------------------------------------------------------------

    def _ensure_init(self) -> None:
        """Initialize fonts and the offscreen surface once; needs no display for rgb_array."""
        if self._inited:
            return
        # A human window must be DPI-aware before it is created, so a HiDPI display renders it at
        # physical pixels instead of bitmap-stretching it (blurry); we then draw natively at
        # ``self.scale``. The headless rgb_array path stays at logical 1.0 so frames and recordings
        # are byte-identical across machines (and the existing renderer test is unaffected).
        hidpi.enable_hidpi()
        self.scale = hidpi.display_scale() if self.render_mode == "human" else 1.0
        # Only the font module is required for the headless rgb_array path; pygame.init() is
        # heavier and reserved for the human path where a display is wanted anyway.
        if not pygame.font.get_init():
            pygame.font.init()
        if self.render_mode == "human" and not pygame.get_init():
            pygame.init()
        self._surface = pygame.Surface((self._s(self.WIDTH), self._s(self.HEIGHT)))
        self._font = pygame.font.Font(None, self._s(26))
        self._font_small = pygame.font.Font(None, self._s(22))
        self._inited = True

    def _s(self, value: float) -> int:
        """Scale a logical pixel length to device pixels for the current HiDPI render scale."""
        return round(value * self.scale)

    # -- small math helpers --------------------------------------------------------------------

    def _pulse(self, period_ms: float, phase: float = 0.0) -> float:
        """Return a smooth ``0..1`` pulse keyed to the wall clock, for breathing highlights.

        In ``"human"`` mode the value sweeps over ``period_ms`` so a highlight breathes across the
        human-wait re-renders. In ``"rgb_array"`` mode it is a fixed ``1.0`` so headless frames are
        deterministic (no wall-clock dependence).
        """
        if self.render_mode != "human":
            return 1.0
        t = pygame.time.get_ticks()
        return 0.5 + 0.5 * math.sin((t / period_ms) * math.tau + phase)

    @staticmethod
    def _lerp_color(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
        """Linearly interpolate between two RGB colours at fraction ``t``."""
        return (
            round(a[0] + (b[0] - a[0]) * t),
            round(a[1] + (b[1] - a[1]) * t),
            round(a[2] + (b[2] - a[2]) * t),
        )

    # -- frame tail ----------------------------------------------------------------------------

    def _finish_frame(self, surface: pygame.Surface) -> np.ndarray | None:
        """Turn the drawn ``surface`` into the render return value.

        In ``"rgb_array"`` mode return an ``(H, W, 3)`` uint8 array (transposed from pygame's
        ``(W, H)`` surfarray). In ``"human"`` mode open the window lazily, mirror the offscreen
        surface onto it 1:1, pump the event queue, and flip — returning ``None``. Both surfaces are
        sized at the device-pixel scale, so the blit stays crisp on a HiDPI display.
        """
        if self.render_mode == "rgb_array":
            arr = pygame.surfarray.array3d(surface)
            return np.transpose(arr, (1, 0, 2)).astype(np.uint8)

        self._ensure_window()
        assert self._screen is not None
        self._screen.blit(surface, (0, 0))
        pygame.event.pump()
        pygame.display.flip()
        return None

    def _ensure_window(self) -> None:
        """Open the human window once, sized to the device-pixel frame. No-op if already open."""
        if self._screen is None:
            self._screen = pygame.display.set_mode((self._s(self.WIDTH), self._s(self.HEIGHT)))
            pygame.display.set_caption(self.WINDOW_CAPTION)

    # -- teardown ------------------------------------------------------------------------------

    def close(self) -> None:
        """Close the window if one was opened. Idempotent; never global-quits pygame.

        Only :func:`pygame.display.quit` is called — a global :func:`pygame.quit` would de-init
        the font module and break other envs/tests sharing the process.
        """
        if self._screen is not None:
            pygame.display.quit()
            self._screen = None
