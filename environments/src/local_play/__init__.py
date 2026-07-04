"""Shared, import-self-contained helpers for local pygame play.

This is not an environment — it holds standalone support modules reused by the card renderers and
the maintainer launcher ``scripts/play.py``, and copied verbatim by ``scripts/generate.py`` into
``templates/base/sandbox/`` so the student template's local play uses the exact same code (under
the ``sandbox.*`` names). The modules are:

* :mod:`local_play.hidpi` — the HiDPI display shim.
* :mod:`local_play.render_base` — :class:`~local_play.render_base.PygameRenderer`, the
  game-agnostic pygame lifecycle (fonts, offscreen surface, HiDPI scale, frame tail).
* :mod:`local_play.render_cards` — :class:`~local_play.render_cards.CardTableRenderer`, the shared
  four-seat card-table renderer the Hearts and Spades renderers subclass.

Modules here import only the standard library, third-party packages, and one another (relatively) —
never the harness — so they sync cleanly into the template and resolve under both the ``local_play.*``
and ``sandbox.*`` names.
"""

from __future__ import annotations
