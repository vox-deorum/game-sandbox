"""Game Sandbox environments.

Each environment lives in its own subpackage exporting a module-level ``ENTRY`` (an
:class:`~game_sandbox_harness.environment.EnvironmentEntry`), discovered by the harness
through the ``game_sandbox.environments`` entry-point group. This package depends on the
harness for the metadata types; the harness never depends on it, so the import arrow points
one way. The single-agent compatibility wrapper lives here too, in :mod:`single_agent`.
"""
