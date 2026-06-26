"""HiDPI helpers for the local pygame play windows.

A pygame process is DPI-*unaware* by default, so on a Windows display running at 150% / 200%
scaling the OS renders the window at its logical pixel size and then bitmap-stretches it up to the
physical pixels — which looks blurry. ``enable_hidpi`` makes the process DPI-*aware* so the OS
stops stretching, and ``display_scale`` reports the display's scale factor so the play loop can
render (or upscale) at the device-pixel resolution — together they keep the window crisp and a
sensible size on a high-DPI screen.

This module imports only the standard library — no pygame and nothing of the backend — so it is
import-self-contained and is synced verbatim into the student template (as ``sandbox.hidpi``)
alongside the environment modules. Every call is a best-effort no-op off Windows (macOS, Linux) and
on any failure, so callers never need to guard it.
"""

from __future__ import annotations

import contextlib
import sys

#: DPI for an unscaled (100%) display; Windows reports 144 at 150% and 192 at 200%.
_BASE_DPI = 96.0
#: ``PROCESS_PER_MONITOR_DPI_AWARE`` for ``shcore.SetProcessDpiAwareness``.
_PER_MONITOR_DPI_AWARE = 2


def enable_hidpi() -> None:
    """Make the process per-monitor DPI-aware, so Windows does not bitmap-stretch our windows.

    Must run **before any pygame window is created** (before ``pygame.display.set_mode``). Idempotent
    and best-effort: a second call or an unsupported OS simply does nothing. A no-op off Windows.
    """
    if sys.platform != "win32":
        return
    import ctypes

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(_PER_MONITOR_DPI_AWARE)
    except Exception:
        # Older Windows without shcore: fall back to the system-wide (non-per-monitor) call.
        with contextlib.suppress(Exception):
            ctypes.windll.user32.SetProcessDPIAware()


def display_scale() -> float:
    """Return the primary display's scale factor (1.0 at 100%, 1.5 at 150%, 2.0 at 200%).

    Drives native high-resolution rendering: a caller multiplies its logical sizes by this so the
    window is the same physical size as on a 100% display but drawn with that many more pixels.
    Returns ``1.0`` off Windows or on any failure, which keeps standard displays and headless CI on
    the unscaled path with no behaviour change. Floored at ``1.0`` so we never downscale.
    """
    if sys.platform != "win32":
        return 1.0
    import ctypes

    try:
        dpi = ctypes.windll.user32.GetDpiForSystem()
    except Exception:
        return 1.0
    return max(1.0, dpi / _BASE_DPI)
