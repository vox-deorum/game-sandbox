"""Seeded village generation: terrain, sites, the road network, and the accessories."""

from __future__ import annotations

from random import Random

from ..layout import Layout
from .accessories import CRATE_RADIUS, PINE_RADIUS, POST_RADIUS, _accessories_layer
from .network import SPAWN_CLEARANCE, _network_layer
from .sites import BOUNDARY_MARGIN, BUILDING_GAP, HOME_CLUSTER_RADIUS, WATER_CLEARANCE, _sites_layer
from .terrain import _terrain_layer, _Water
from .validation import _validated
from .walker import MAX_POLYLINE_POINTS

__all__ = [
    "BOUNDARY_MARGIN",
    "BUILDING_GAP",
    "CRATE_RADIUS",
    "HOME_CLUSTER_RADIUS",
    "MAX_POLYLINE_POINTS",
    "PINE_RADIUS",
    "POST_RADIUS",
    "SPAWN_CLEARANCE",
    "WATER_CLEARANCE",
    "build_village",
]


MAX_REDRAWS = 64


def build_village(seed: int) -> Layout:
    """Build the seeded village, every layer generated and the result validated.

    The layers run in order on one stream, terrain, sites, the road network, and the accessories,
    and any layer that exhausts its local budgets discards the partial village and redraws whole.
    Assembly and the reset validation run inside the loop, so a constructor rejection or a failed
    flood fill redraws too.
    """
    rng = Random(f"{seed}:village")
    for _ in range(MAX_REDRAWS):
        land = _terrain_layer(rng)
        if land is None:
            continue
        terrain, channels, fields, reed_banks = land
        water = _Water.of(channels)
        sites = _sites_layer(rng, terrain, water)
        if sites is None:
            continue
        network = _network_layer(rng, terrain, water, sites)
        if network is None:
            continue
        accessories = _accessories_layer(rng, water, sites, network, fields, reed_banks)
        if accessories is None:
            continue
        try:
            layout = Layout(
                channels=water.channels,
                road=network.road,
                footpaths=network.footpaths,
                bridges=network.bridges,
                buildings=network.buildings,
                fields=fields,
                reed_banks=reed_banks,
                props=accessories.props,
                scenery=accessories.scenery,
                spawn=network.spawn,
            )
        except ValueError:
            continue
        if not _validated(layout, accessories.witnesses):
            continue
        return layout
    raise RuntimeError(f"could not build a village for seed {seed} within {MAX_REDRAWS} redraws")
