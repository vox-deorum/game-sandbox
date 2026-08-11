"""Immutable, package-owned tuning for the Three Branches generator."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from importlib import resources
from typing import Any

from ..layout import WORLD_SIZE


@dataclass(frozen=True)
class Range:
    """An inclusive numeric range used for a seeded draw."""

    low: float
    high: float


@dataclass(frozen=True)
class PipelineConfig:
    max_redraws: int


@dataclass(frozen=True)
class WalkerConfig:
    octave_spacings: tuple[float, float, float]
    step: float
    max_steps: int
    sample_spacing: float
    repel_radius: float
    repel_weight: float
    edge_radius: float
    edge_weight: float
    edge_fade: float
    abort_slack: float
    finish_step_factor: float
    arrival_pull_radius: float
    leg_distance_multiplier: int
    leg_base_steps: int
    roughness: Range
    slope: Range


@dataclass(frozen=True)
class TerrainConfig:
    mouth_edge_margin: float
    mouth_gap: Range
    topology_tries: int
    course_tries: int
    reed_moisture: float
    sibling_clearance: float
    entry_x_margin: float
    fork_x: Range
    fork_y: Range
    mouth_center_fork_reach: float
    water_weights: tuple[Range, Range, Range]
    trunk_heading: Range
    trunk_width: Range
    channel_heading: Range
    channel_width: Range
    reed_depth: Range
    terrace_depth: Range
    reed_window_step: int
    terrace_window_step: int
    maximum_bank_features: int
    terrace_y_max: float
    terrace_elevation_max: float
    channel_approach_y: float
    fork_exempt_radius: float
    reed_side_probe_offset: float
    reed_inner_offset: float
    reed_mouth_window_points: int
    bank_scan_start: int
    bank_scan_end: int
    bank_window_points: int
    terrace_side_probe_offset: float
    terrace_inner_offset: float


@dataclass(frozen=True)
class SitesConfig:
    building_gap: float
    water_clearance: float
    boundary_margin: float
    home_cluster_radius: float
    home_cluster_separation: float
    placement_budget: int
    anchor_budget: int
    spot_clearance: float
    spot_budget: int
    market_water_room: float
    landmark_water_room: float
    home_size: tuple[float, float]
    inn_size: tuple[float, float]
    shed_size: tuple[float, float]
    plaza_clearance: float
    tries: int
    wedge_half_opening: float
    cluster_radius_low: float
    cluster_ring_depth: float
    cluster_water_min: float
    cluster_corridor_room: float
    wedge_slide_limit: float
    cluster_grid_start: int
    cluster_grid_stop: int
    cluster_grid_step: int
    corridor_below_fork: Range
    corridor_anchor_offset: Range
    shed_x: Range
    bell_x: Range
    bell_offset: Range
    market_x: Range
    stall_x_offset: Range
    stall_offset: Range
    board_offset: Range
    building_reach: Range
    building_spin: Range
    plaza_reach_offset: float
    plaza_reach_step: float
    cluster_channel_stride: int
    cluster_bank_target: float
    cluster_bank_band: float
    cluster_slope_scale: float
    cluster_score_weights: tuple[float, float, float]
    cluster_count: tuple[int, int]
    inn_x: Range
    placement_prune_slack: float


@dataclass(frozen=True)
class NetworkConfig:
    spawn_clearance: float
    deck_apron: float
    dry_margin: float
    crossing_band: float
    crossing_fork_gap: float
    junction_deck_gap: float
    route_gap: float
    road_tries: int
    network_tries: int
    footpath_tries: int
    footpath_redraws: int
    shrine_clearance: float
    shrine_separation: float
    deck_width: Range
    footpath_weights: tuple[Range, Range, Range]
    footpath_width: Range
    footpath_swing: Range
    shrine_offset: Range
    shrine_path_width: Range
    road_edge_offset: Range
    road_weights: tuple[Range, Range, Range]
    road_heading: Range
    road_width: Range
    crossing_draws: int
    crossing_min_x: float
    crossing_edge_margin: float
    crossing_min_gap: float
    footpath_repel_radius: float
    road_repel_radius: float
    water_reach_limit: float
    water_reach_step: float
    water_reach_refinements: int
    deck_frame_margin: float
    deck_fork_gap: float
    deck_sibling_margin: float
    footpath_deck_vertex_gap: float
    footpath_deck_gap: float
    junction_candidate_limit: int
    shrine_frame_margin: float
    crossing_band_multiplier: float
    crossing_min_normal_x: float


@dataclass(frozen=True)
class PineConfig:
    radius: float
    solid_gap: float
    building_gap: float
    anchor_gap: float
    companion_gap: float
    road_end_margin: float
    road_spacing: float
    path_edge_gap: float
    scatter_cell: float
    scatter_probability: float
    companion_probability: float
    companions: tuple[int, int]
    companion_distance: Range


@dataclass(frozen=True)
class CrateConfig:
    radius: float
    tries: int
    count: tuple[int, int]
    offset: Range
    water_margin: float


@dataclass(frozen=True)
class PostConfig:
    radius: float


@dataclass(frozen=True)
class PropConfig:
    gap: float
    water_margin: float
    path_margin: float
    building_gap: float
    frame_margin: float
    tries: int
    threshold_gap: float
    spawn_slack: float
    protected_gap: float


@dataclass(frozen=True)
class WitnessConfig:
    angles: int
    first_ring: float
    radius_step: float


@dataclass(frozen=True)
class StallConfig:
    dry_stretch: float
    arc_jitter: Range
    edge_gap: Range
    rotation_jitter: Range
    fallback_end_margin: float
    fallback_spacing: float


@dataclass(frozen=True)
class LanternConfig:
    dry_stretch: float
    end_margin: float
    spacing: float
    market_radius: float
    market_spacing: float
    road_edge_gap: float
    path_margin: float


@dataclass(frozen=True)
class BenchConfig:
    plaza_reach: Range
    market_reach: Range
    inn_forward: Range
    inn_side: Range
    fallback_end_margin: float
    fallback_spacing: float
    road_edge_gap: float


@dataclass(frozen=True)
class ShrineConfig:
    tries: int
    jitter: Range
    path_margin: float
    post_size: float
    post_path_margin: float
    post_water_margin: float


@dataclass(frozen=True)
class BoardConfig:
    reach: Range


@dataclass(frozen=True)
class InteriorConfig:
    tries: int
    slide: Range
    door_gap: float


@dataclass(frozen=True)
class PumpConfig:
    reach: Range


@dataclass(frozen=True)
class BellConfig:
    arc_jitter: Range
    edge_gap: Range
    path_margin: float


@dataclass(frozen=True)
class AccessoriesConfig:
    pine: PineConfig
    crate: CrateConfig
    post: PostConfig
    prop: PropConfig
    witness: WitnessConfig
    stall: StallConfig
    lantern: LanternConfig
    bench: BenchConfig
    shrine: ShrineConfig
    board: BoardConfig
    interior: InteriorConfig
    pump: PumpConfig
    bell: BellConfig


@dataclass(frozen=True)
class GenerationConfig:
    pipeline: PipelineConfig
    walker: WalkerConfig
    terrain: TerrainConfig
    sites: SitesConfig
    network: NetworkConfig
    accessories: AccessoriesConfig


def _object(value: Any, owner: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"generation: {owner} must have exactly {sorted(keys)}")
    return value


def _number(value: Any, owner: str, *, positive: bool = False) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or (positive and value <= 0):
        qualifier = "a positive finite number" if positive else "a finite number"
        raise ValueError(f"generation: {owner} must be {qualifier}")
    return float(value)


def _integer(value: Any, owner: str, *, positive: bool = False) -> int:
    if type(value) is not int or (positive and value <= 0):
        qualifier = "a positive integer" if positive else "an integer"
        raise ValueError(f"generation: {owner} must be {qualifier}")
    return value


def _range(value: Any, owner: str, *, positive: bool = False) -> Range:
    values = _array(value, owner, 2)
    low = _number(values[0], f"{owner}[0]", positive=positive)
    high = _number(values[1], f"{owner}[1]", positive=positive)
    if low > high:
        raise ValueError(f"generation: {owner} must be ordered")
    return Range(low, high)


def _int_pair(value: Any, owner: str, *, positive: bool = False) -> tuple[int, int]:
    values = _array(value, owner, 2)
    low = _integer(values[0], f"{owner}[0]", positive=positive)
    high = _integer(values[1], f"{owner}[1]", positive=positive)
    if low > high:
        raise ValueError(f"generation: {owner} must be ordered")
    return low, high


def _array(value: Any, owner: str, length: int) -> list[Any]:
    if not isinstance(value, list) or len(value) != length:
        raise ValueError(f"generation: {owner} must be an array of {length} items")
    return value


def _pair(value: Any, owner: str, *, positive: bool = False) -> tuple[float, float]:
    values = _array(value, owner, 2)
    return (
        _number(values[0], f"{owner}[0]", positive=positive),
        _number(values[1], f"{owner}[1]", positive=positive),
    )


def _triple(value: Any, owner: str, *, positive: bool = False) -> tuple[float, float, float]:
    values = _array(value, owner, 3)
    return (
        _number(values[0], f"{owner}[0]", positive=positive),
        _number(values[1], f"{owner}[1]", positive=positive),
        _number(values[2], f"{owner}[2]", positive=positive),
    )


def _ranges(value: Any, owner: str, length: int, *, positive: bool = False) -> tuple[Range, ...]:
    return tuple(
        _range(item, f"{owner}[{index}]", positive=positive)
        for index, item in enumerate(_array(value, owner, length))
    )


def _probability(value: Any, owner: str) -> float:
    probability = _number(value, owner)
    if not 0.0 <= probability <= 1.0:
        raise ValueError(f"generation: {owner} must be between 0 and 1")
    return probability


def load_generation_config(data: Any) -> GenerationConfig:
    """Validate decoded generation tuning without relying on package global state."""
    root = _object(data, "document", {"pipeline", "walker", "terrain", "sites", "network", "accessories"})
    pipeline = _object(root["pipeline"], "pipeline", {"max_redraws"})
    walker = _object(
        root["walker"],
        "walker",
        {
            "octave_spacings",
            "step",
            "max_steps",
            "sample_spacing",
            "repel_radius",
            "repel_weight",
            "edge_radius",
            "edge_weight",
            "edge_fade",
            "abort_slack",
            "finish_step_factor",
            "arrival_pull_radius",
            "leg_distance_multiplier",
            "leg_base_steps",
            "roughness",
            "slope",
        },
    )
    terrain = _object(
        root["terrain"],
        "terrain",
        {
            "mouth_edge_margin",
            "mouth_gap",
            "topology_tries",
            "course_tries",
            "reed_moisture",
            "sibling_clearance",
            "entry_x_margin",
            "fork_x",
            "fork_y",
            "mouth_center_fork_reach",
            "water_weights",
            "trunk_heading",
            "trunk_width",
            "channel_heading",
            "channel_width",
            "reed_depth",
            "terrace_depth",
            "reed_window_step",
            "terrace_window_step",
            "maximum_bank_features",
            "terrace_y_max",
            "terrace_elevation_max",
            "channel_approach_y",
            "fork_exempt_radius",
            "reed_side_probe_offset",
            "reed_inner_offset",
            "reed_mouth_window_points",
            "bank_scan_start",
            "bank_scan_end",
            "bank_window_points",
            "terrace_side_probe_offset",
            "terrace_inner_offset",
        },
    )
    sites = _object(
        root["sites"],
        "sites",
        {
            "building_gap",
            "water_clearance",
            "boundary_margin",
            "home_cluster_radius",
            "home_cluster_separation",
            "placement_budget",
            "anchor_budget",
            "spot_clearance",
            "spot_budget",
            "market_water_room",
            "landmark_water_room",
            "home_size",
            "inn_size",
            "shed_size",
            "plaza_clearance",
            "tries",
            "wedge_half_opening",
            "cluster_radius_low",
            "cluster_ring_depth",
            "cluster_water_min",
            "cluster_corridor_room",
            "wedge_slide_limit",
            "cluster_grid_start",
            "cluster_grid_stop",
            "cluster_grid_step",
            "corridor_below_fork",
            "corridor_anchor_offset",
            "shed_x",
            "bell_x",
            "bell_offset",
            "market_x",
            "stall_x_offset",
            "stall_offset",
            "board_offset",
            "building_reach",
            "building_spin",
            "plaza_reach_offset",
            "plaza_reach_step",
            "cluster_channel_stride",
            "cluster_bank_target",
            "cluster_bank_band",
            "cluster_slope_scale",
            "cluster_score_weights",
            "cluster_count",
            "inn_x",
            "placement_prune_slack",
        },
    )
    network = _object(
        root["network"],
        "network",
        {
            "spawn_clearance",
            "deck_apron",
            "dry_margin",
            "crossing_band",
            "crossing_fork_gap",
            "junction_deck_gap",
            "route_gap",
            "road_tries",
            "network_tries",
            "footpath_tries",
            "footpath_redraws",
            "shrine_clearance",
            "shrine_separation",
            "deck_width",
            "footpath_weights",
            "footpath_width",
            "footpath_swing",
            "shrine_offset",
            "shrine_path_width",
            "road_edge_offset",
            "road_weights",
            "road_heading",
            "road_width",
            "crossing_draws",
            "crossing_min_x",
            "crossing_edge_margin",
            "crossing_min_gap",
            "footpath_repel_radius",
            "road_repel_radius",
            "water_reach_limit",
            "water_reach_step",
            "water_reach_refinements",
            "deck_frame_margin",
            "deck_fork_gap",
            "deck_sibling_margin",
            "footpath_deck_vertex_gap",
            "footpath_deck_gap",
            "junction_candidate_limit",
            "shrine_frame_margin",
            "crossing_band_multiplier",
            "crossing_min_normal_x",
        },
    )
    accessories = _object(
        root["accessories"],
        "accessories",
        {
            "pine",
            "crate",
            "post",
            "prop",
            "witness",
            "stall",
            "lantern",
            "bench",
            "shrine",
            "board",
            "interior",
            "pump",
            "bell",
        },
    )
    pine = _object(
        accessories["pine"],
        "accessories.pine",
        {
            "radius",
            "solid_gap",
            "building_gap",
            "anchor_gap",
            "companion_gap",
            "road_end_margin",
            "road_spacing",
            "path_edge_gap",
            "scatter_cell",
            "scatter_probability",
            "companion_probability",
            "companions",
            "companion_distance",
        },
    )
    crate = _object(
        accessories["crate"],
        "accessories.crate",
        {"radius", "tries", "count", "offset", "water_margin"},
    )
    post = _object(accessories["post"], "accessories.post", {"radius"})
    prop = _object(
        accessories["prop"],
        "accessories.prop",
        {
            "gap",
            "water_margin",
            "path_margin",
            "building_gap",
            "frame_margin",
            "tries",
            "threshold_gap",
            "spawn_slack",
            "protected_gap",
        },
    )
    witness = _object(accessories["witness"], "accessories.witness", {"angles", "first_ring", "radius_step"})
    stall = _object(
        accessories["stall"],
        "accessories.stall",
        {
            "dry_stretch",
            "arc_jitter",
            "edge_gap",
            "rotation_jitter",
            "fallback_end_margin",
            "fallback_spacing",
        },
    )
    lantern = _object(
        accessories["lantern"],
        "accessories.lantern",
        {
            "dry_stretch",
            "end_margin",
            "spacing",
            "market_radius",
            "market_spacing",
            "road_edge_gap",
            "path_margin",
        },
    )
    bench = _object(
        accessories["bench"],
        "accessories.bench",
        {
            "plaza_reach",
            "market_reach",
            "inn_forward",
            "inn_side",
            "fallback_end_margin",
            "fallback_spacing",
            "road_edge_gap",
        },
    )
    shrine = _object(
        accessories["shrine"],
        "accessories.shrine",
        {"tries", "jitter", "path_margin", "post_size", "post_path_margin", "post_water_margin"},
    )
    board = _object(accessories["board"], "accessories.board", {"reach"})
    interior = _object(accessories["interior"], "accessories.interior", {"tries", "slide", "door_gap"})
    pump = _object(accessories["pump"], "accessories.pump", {"reach"})
    bell = _object(accessories["bell"], "accessories.bell", {"arc_jitter", "edge_gap", "path_margin"})
    octave_spacings = _array(walker["octave_spacings"], "walker.octave_spacings", 3)
    config = GenerationConfig(
        pipeline=PipelineConfig(
            max_redraws=_integer(pipeline["max_redraws"], "pipeline.max_redraws", positive=True)
        ),
        walker=WalkerConfig(
            octave_spacings=tuple(
                _number(value, f"walker.octave_spacings[{index}]", positive=True)
                for index, value in enumerate(octave_spacings)
            ),  # type: ignore[arg-type]
            step=_number(walker["step"], "walker.step", positive=True),
            max_steps=_integer(walker["max_steps"], "walker.max_steps", positive=True),
            sample_spacing=_number(walker["sample_spacing"], "walker.sample_spacing", positive=True),
            repel_radius=_number(walker["repel_radius"], "walker.repel_radius", positive=True),
            repel_weight=_number(walker["repel_weight"], "walker.repel_weight", positive=True),
            edge_radius=_number(walker["edge_radius"], "walker.edge_radius", positive=True),
            edge_weight=_number(walker["edge_weight"], "walker.edge_weight", positive=True),
            edge_fade=_number(walker["edge_fade"], "walker.edge_fade", positive=True),
            abort_slack=_number(walker["abort_slack"], "walker.abort_slack", positive=True),
            finish_step_factor=_number(
                walker["finish_step_factor"], "walker.finish_step_factor", positive=True
            ),
            arrival_pull_radius=_number(
                walker["arrival_pull_radius"], "walker.arrival_pull_radius", positive=True
            ),
            leg_distance_multiplier=_integer(
                walker["leg_distance_multiplier"], "walker.leg_distance_multiplier", positive=True
            ),
            leg_base_steps=_integer(walker["leg_base_steps"], "walker.leg_base_steps", positive=True),
            roughness=_range(walker["roughness"], "walker.roughness", positive=True),
            slope=_range(walker["slope"], "walker.slope", positive=True),
        ),
        terrain=TerrainConfig(
            mouth_edge_margin=_number(
                terrain["mouth_edge_margin"], "terrain.mouth_edge_margin", positive=True
            ),
            mouth_gap=_range(terrain["mouth_gap"], "terrain.mouth_gap", positive=True),
            topology_tries=_integer(terrain["topology_tries"], "terrain.topology_tries", positive=True),
            course_tries=_integer(terrain["course_tries"], "terrain.course_tries", positive=True),
            reed_moisture=_probability(terrain["reed_moisture"], "terrain.reed_moisture"),
            sibling_clearance=_number(
                terrain["sibling_clearance"], "terrain.sibling_clearance", positive=True
            ),
            entry_x_margin=_number(terrain["entry_x_margin"], "terrain.entry_x_margin", positive=True),
            fork_x=_range(terrain["fork_x"], "terrain.fork_x", positive=True),
            fork_y=_range(terrain["fork_y"], "terrain.fork_y", positive=True),
            mouth_center_fork_reach=_number(
                terrain["mouth_center_fork_reach"], "terrain.mouth_center_fork_reach", positive=True
            ),
            water_weights=_ranges(terrain["water_weights"], "terrain.water_weights", 3, positive=True),  # type: ignore[arg-type]
            trunk_heading=_range(terrain["trunk_heading"], "terrain.trunk_heading"),
            trunk_width=_range(terrain["trunk_width"], "terrain.trunk_width", positive=True),
            channel_heading=_range(terrain["channel_heading"], "terrain.channel_heading"),
            channel_width=_range(terrain["channel_width"], "terrain.channel_width", positive=True),
            reed_depth=_range(terrain["reed_depth"], "terrain.reed_depth", positive=True),
            terrace_depth=_range(terrain["terrace_depth"], "terrain.terrace_depth", positive=True),
            reed_window_step=_integer(terrain["reed_window_step"], "terrain.reed_window_step", positive=True),
            terrace_window_step=_integer(
                terrain["terrace_window_step"], "terrain.terrace_window_step", positive=True
            ),
            maximum_bank_features=_integer(
                terrain["maximum_bank_features"], "terrain.maximum_bank_features", positive=True
            ),
            terrace_y_max=_number(terrain["terrace_y_max"], "terrain.terrace_y_max", positive=True),
            terrace_elevation_max=_number(terrain["terrace_elevation_max"], "terrain.terrace_elevation_max"),
            channel_approach_y=_number(
                terrain["channel_approach_y"], "terrain.channel_approach_y", positive=True
            ),
            fork_exempt_radius=_number(
                terrain["fork_exempt_radius"], "terrain.fork_exempt_radius", positive=True
            ),
            reed_side_probe_offset=_number(
                terrain["reed_side_probe_offset"], "terrain.reed_side_probe_offset", positive=True
            ),
            reed_inner_offset=_number(terrain["reed_inner_offset"], "terrain.reed_inner_offset"),
            reed_mouth_window_points=_integer(
                terrain["reed_mouth_window_points"],
                "terrain.reed_mouth_window_points",
                positive=True,
            ),
            bank_scan_start=_integer(terrain["bank_scan_start"], "terrain.bank_scan_start", positive=True),
            bank_scan_end=_integer(terrain["bank_scan_end"], "terrain.bank_scan_end", positive=True),
            bank_window_points=_integer(
                terrain["bank_window_points"], "terrain.bank_window_points", positive=True
            ),
            terrace_side_probe_offset=_number(
                terrain["terrace_side_probe_offset"],
                "terrain.terrace_side_probe_offset",
                positive=True,
            ),
            terrace_inner_offset=_number(
                terrain["terrace_inner_offset"], "terrain.terrace_inner_offset", positive=True
            ),
        ),
        sites=SitesConfig(
            building_gap=_number(sites["building_gap"], "sites.building_gap", positive=True),
            water_clearance=_number(sites["water_clearance"], "sites.water_clearance", positive=True),
            boundary_margin=_number(sites["boundary_margin"], "sites.boundary_margin", positive=True),
            home_cluster_radius=_number(
                sites["home_cluster_radius"], "sites.home_cluster_radius", positive=True
            ),
            home_cluster_separation=_number(
                sites["home_cluster_separation"], "sites.home_cluster_separation", positive=True
            ),
            placement_budget=_integer(sites["placement_budget"], "sites.placement_budget", positive=True),
            anchor_budget=_integer(sites["anchor_budget"], "sites.anchor_budget", positive=True),
            spot_clearance=_number(sites["spot_clearance"], "sites.spot_clearance", positive=True),
            spot_budget=_integer(sites["spot_budget"], "sites.spot_budget", positive=True),
            market_water_room=_number(sites["market_water_room"], "sites.market_water_room", positive=True),
            landmark_water_room=_number(
                sites["landmark_water_room"], "sites.landmark_water_room", positive=True
            ),
            home_size=_pair(sites["home_size"], "sites.home_size", positive=True),
            inn_size=_pair(sites["inn_size"], "sites.inn_size", positive=True),
            shed_size=_pair(sites["shed_size"], "sites.shed_size", positive=True),
            plaza_clearance=_number(sites["plaza_clearance"], "sites.plaza_clearance", positive=True),
            tries=_integer(sites["tries"], "sites.tries", positive=True),
            wedge_half_opening=_number(
                sites["wedge_half_opening"], "sites.wedge_half_opening", positive=True
            ),
            cluster_radius_low=_number(
                sites["cluster_radius_low"], "sites.cluster_radius_low", positive=True
            ),
            cluster_ring_depth=_number(
                sites["cluster_ring_depth"], "sites.cluster_ring_depth", positive=True
            ),
            cluster_water_min=_number(sites["cluster_water_min"], "sites.cluster_water_min", positive=True),
            cluster_corridor_room=_number(
                sites["cluster_corridor_room"], "sites.cluster_corridor_room", positive=True
            ),
            wedge_slide_limit=_number(sites["wedge_slide_limit"], "sites.wedge_slide_limit", positive=True),
            cluster_grid_start=_integer(
                sites["cluster_grid_start"], "sites.cluster_grid_start", positive=True
            ),
            cluster_grid_stop=_integer(sites["cluster_grid_stop"], "sites.cluster_grid_stop", positive=True),
            cluster_grid_step=_integer(sites["cluster_grid_step"], "sites.cluster_grid_step", positive=True),
            corridor_below_fork=_range(
                sites["corridor_below_fork"], "sites.corridor_below_fork", positive=True
            ),
            corridor_anchor_offset=_range(
                sites["corridor_anchor_offset"], "sites.corridor_anchor_offset", positive=True
            ),
            shed_x=_range(sites["shed_x"], "sites.shed_x", positive=True),
            bell_x=_range(sites["bell_x"], "sites.bell_x", positive=True),
            bell_offset=_range(sites["bell_offset"], "sites.bell_offset", positive=True),
            market_x=_range(sites["market_x"], "sites.market_x", positive=True),
            stall_x_offset=_range(sites["stall_x_offset"], "sites.stall_x_offset"),
            stall_offset=_range(sites["stall_offset"], "sites.stall_offset", positive=True),
            board_offset=_range(sites["board_offset"], "sites.board_offset"),
            building_reach=_range(sites["building_reach"], "sites.building_reach"),
            building_spin=_range(sites["building_spin"], "sites.building_spin"),
            plaza_reach_offset=_number(
                sites["plaza_reach_offset"], "sites.plaza_reach_offset", positive=True
            ),
            plaza_reach_step=_number(sites["plaza_reach_step"], "sites.plaza_reach_step", positive=True),
            cluster_channel_stride=_integer(
                sites["cluster_channel_stride"], "sites.cluster_channel_stride", positive=True
            ),
            cluster_bank_target=_number(
                sites["cluster_bank_target"], "sites.cluster_bank_target", positive=True
            ),
            cluster_bank_band=_number(sites["cluster_bank_band"], "sites.cluster_bank_band", positive=True),
            cluster_slope_scale=_number(
                sites["cluster_slope_scale"], "sites.cluster_slope_scale", positive=True
            ),
            cluster_score_weights=_triple(
                sites["cluster_score_weights"], "sites.cluster_score_weights", positive=True
            ),
            cluster_count=_int_pair(sites["cluster_count"], "sites.cluster_count", positive=True),
            inn_x=_range(sites["inn_x"], "sites.inn_x", positive=True),
            placement_prune_slack=_number(
                sites["placement_prune_slack"], "sites.placement_prune_slack", positive=True
            ),
        ),
        network=NetworkConfig(
            spawn_clearance=_number(network["spawn_clearance"], "network.spawn_clearance", positive=True),
            deck_apron=_number(network["deck_apron"], "network.deck_apron", positive=True),
            dry_margin=_number(network["dry_margin"], "network.dry_margin", positive=True),
            crossing_band=_number(network["crossing_band"], "network.crossing_band", positive=True),
            crossing_fork_gap=_number(
                network["crossing_fork_gap"], "network.crossing_fork_gap", positive=True
            ),
            junction_deck_gap=_number(
                network["junction_deck_gap"], "network.junction_deck_gap", positive=True
            ),
            route_gap=_number(network["route_gap"], "network.route_gap", positive=True),
            road_tries=_integer(network["road_tries"], "network.road_tries", positive=True),
            network_tries=_integer(network["network_tries"], "network.network_tries", positive=True),
            footpath_tries=_integer(network["footpath_tries"], "network.footpath_tries", positive=True),
            footpath_redraws=_integer(network["footpath_redraws"], "network.footpath_redraws", positive=True),
            shrine_clearance=_number(network["shrine_clearance"], "network.shrine_clearance", positive=True),
            shrine_separation=_number(
                network["shrine_separation"], "network.shrine_separation", positive=True
            ),
            deck_width=_range(network["deck_width"], "network.deck_width", positive=True),
            footpath_weights=_ranges(
                network["footpath_weights"], "network.footpath_weights", 3, positive=True
            ),  # type: ignore[arg-type]
            footpath_width=_range(network["footpath_width"], "network.footpath_width", positive=True),
            footpath_swing=_range(network["footpath_swing"], "network.footpath_swing"),
            shrine_offset=_range(network["shrine_offset"], "network.shrine_offset", positive=True),
            shrine_path_width=_range(
                network["shrine_path_width"], "network.shrine_path_width", positive=True
            ),
            road_edge_offset=_range(network["road_edge_offset"], "network.road_edge_offset"),
            road_weights=_ranges(network["road_weights"], "network.road_weights", 3, positive=True),  # type: ignore[arg-type]
            road_heading=_range(network["road_heading"], "network.road_heading"),
            road_width=_range(network["road_width"], "network.road_width", positive=True),
            crossing_draws=_integer(network["crossing_draws"], "network.crossing_draws", positive=True),
            crossing_min_x=_number(network["crossing_min_x"], "network.crossing_min_x", positive=True),
            crossing_edge_margin=_number(
                network["crossing_edge_margin"], "network.crossing_edge_margin", positive=True
            ),
            crossing_min_gap=_number(network["crossing_min_gap"], "network.crossing_min_gap", positive=True),
            footpath_repel_radius=_number(
                network["footpath_repel_radius"], "network.footpath_repel_radius", positive=True
            ),
            road_repel_radius=_number(
                network["road_repel_radius"], "network.road_repel_radius", positive=True
            ),
            water_reach_limit=_number(
                network["water_reach_limit"], "network.water_reach_limit", positive=True
            ),
            water_reach_step=_number(network["water_reach_step"], "network.water_reach_step", positive=True),
            water_reach_refinements=_integer(
                network["water_reach_refinements"],
                "network.water_reach_refinements",
                positive=True,
            ),
            deck_frame_margin=_number(
                network["deck_frame_margin"], "network.deck_frame_margin", positive=True
            ),
            deck_fork_gap=_number(network["deck_fork_gap"], "network.deck_fork_gap", positive=True),
            deck_sibling_margin=_number(
                network["deck_sibling_margin"], "network.deck_sibling_margin", positive=True
            ),
            footpath_deck_vertex_gap=_number(
                network["footpath_deck_vertex_gap"],
                "network.footpath_deck_vertex_gap",
                positive=True,
            ),
            footpath_deck_gap=_number(
                network["footpath_deck_gap"], "network.footpath_deck_gap", positive=True
            ),
            junction_candidate_limit=_integer(
                network["junction_candidate_limit"],
                "network.junction_candidate_limit",
                positive=True,
            ),
            shrine_frame_margin=_number(
                network["shrine_frame_margin"], "network.shrine_frame_margin", positive=True
            ),
            crossing_band_multiplier=_number(
                network["crossing_band_multiplier"],
                "network.crossing_band_multiplier",
                positive=True,
            ),
            crossing_min_normal_x=_number(
                network["crossing_min_normal_x"], "network.crossing_min_normal_x", positive=True
            ),
        ),
        accessories=AccessoriesConfig(
            pine=PineConfig(
                radius=_number(pine["radius"], "accessories.pine.radius", positive=True),
                solid_gap=_number(pine["solid_gap"], "accessories.pine.solid_gap", positive=True),
                building_gap=_number(pine["building_gap"], "accessories.pine.building_gap", positive=True),
                anchor_gap=_number(pine["anchor_gap"], "accessories.pine.anchor_gap", positive=True),
                companion_gap=_number(pine["companion_gap"], "accessories.pine.companion_gap"),
                road_end_margin=_number(
                    pine["road_end_margin"], "accessories.pine.road_end_margin", positive=True
                ),
                road_spacing=_number(pine["road_spacing"], "accessories.pine.road_spacing", positive=True),
                path_edge_gap=_number(pine["path_edge_gap"], "accessories.pine.path_edge_gap", positive=True),
                scatter_cell=_number(pine["scatter_cell"], "accessories.pine.scatter_cell", positive=True),
                scatter_probability=_probability(
                    pine["scatter_probability"], "accessories.pine.scatter_probability"
                ),
                companion_probability=_probability(
                    pine["companion_probability"], "accessories.pine.companion_probability"
                ),
                companions=_int_pair(pine["companions"], "accessories.pine.companions", positive=True),
                companion_distance=_range(
                    pine["companion_distance"],
                    "accessories.pine.companion_distance",
                    positive=True,
                ),
            ),
            crate=CrateConfig(
                radius=_number(crate["radius"], "accessories.crate.radius", positive=True),
                tries=_integer(crate["tries"], "accessories.crate.tries", positive=True),
                count=_int_pair(crate["count"], "accessories.crate.count", positive=True),
                offset=_range(crate["offset"], "accessories.crate.offset", positive=True),
                water_margin=_number(crate["water_margin"], "accessories.crate.water_margin", positive=True),
            ),
            post=PostConfig(radius=_number(post["radius"], "accessories.post.radius", positive=True)),
            prop=PropConfig(
                gap=_number(prop["gap"], "accessories.prop.gap", positive=True),
                water_margin=_number(prop["water_margin"], "accessories.prop.water_margin", positive=True),
                path_margin=_number(prop["path_margin"], "accessories.prop.path_margin", positive=True),
                building_gap=_number(prop["building_gap"], "accessories.prop.building_gap", positive=True),
                frame_margin=_number(prop["frame_margin"], "accessories.prop.frame_margin", positive=True),
                tries=_integer(prop["tries"], "accessories.prop.tries", positive=True),
                threshold_gap=_number(prop["threshold_gap"], "accessories.prop.threshold_gap", positive=True),
                spawn_slack=_number(prop["spawn_slack"], "accessories.prop.spawn_slack"),
                protected_gap=_number(prop["protected_gap"], "accessories.prop.protected_gap", positive=True),
            ),
            witness=WitnessConfig(
                angles=_integer(witness["angles"], "accessories.witness.angles", positive=True),
                first_ring=_number(witness["first_ring"], "accessories.witness.first_ring", positive=True),
                radius_step=_number(witness["radius_step"], "accessories.witness.radius_step", positive=True),
            ),
            stall=StallConfig(
                dry_stretch=_number(stall["dry_stretch"], "accessories.stall.dry_stretch", positive=True),
                arc_jitter=_range(stall["arc_jitter"], "accessories.stall.arc_jitter"),
                edge_gap=_range(stall["edge_gap"], "accessories.stall.edge_gap", positive=True),
                rotation_jitter=_range(stall["rotation_jitter"], "accessories.stall.rotation_jitter"),
                fallback_end_margin=_number(
                    stall["fallback_end_margin"],
                    "accessories.stall.fallback_end_margin",
                    positive=True,
                ),
                fallback_spacing=_number(
                    stall["fallback_spacing"], "accessories.stall.fallback_spacing", positive=True
                ),
            ),
            lantern=LanternConfig(
                dry_stretch=_number(lantern["dry_stretch"], "accessories.lantern.dry_stretch", positive=True),
                end_margin=_number(lantern["end_margin"], "accessories.lantern.end_margin", positive=True),
                spacing=_number(lantern["spacing"], "accessories.lantern.spacing", positive=True),
                market_radius=_number(
                    lantern["market_radius"], "accessories.lantern.market_radius", positive=True
                ),
                market_spacing=_number(
                    lantern["market_spacing"], "accessories.lantern.market_spacing", positive=True
                ),
                road_edge_gap=_number(
                    lantern["road_edge_gap"], "accessories.lantern.road_edge_gap", positive=True
                ),
                path_margin=_number(lantern["path_margin"], "accessories.lantern.path_margin", positive=True),
            ),
            bench=BenchConfig(
                plaza_reach=_range(bench["plaza_reach"], "accessories.bench.plaza_reach", positive=True),
                market_reach=_range(bench["market_reach"], "accessories.bench.market_reach", positive=True),
                inn_forward=_range(bench["inn_forward"], "accessories.bench.inn_forward", positive=True),
                inn_side=_range(bench["inn_side"], "accessories.bench.inn_side", positive=True),
                fallback_end_margin=_number(
                    bench["fallback_end_margin"],
                    "accessories.bench.fallback_end_margin",
                    positive=True,
                ),
                fallback_spacing=_number(
                    bench["fallback_spacing"], "accessories.bench.fallback_spacing", positive=True
                ),
                road_edge_gap=_number(
                    bench["road_edge_gap"], "accessories.bench.road_edge_gap", positive=True
                ),
            ),
            shrine=ShrineConfig(
                tries=_integer(shrine["tries"], "accessories.shrine.tries", positive=True),
                jitter=_range(shrine["jitter"], "accessories.shrine.jitter"),
                path_margin=_number(shrine["path_margin"], "accessories.shrine.path_margin", positive=True),
                post_size=_number(shrine["post_size"], "accessories.shrine.post_size", positive=True),
                post_path_margin=_number(
                    shrine["post_path_margin"],
                    "accessories.shrine.post_path_margin",
                    positive=True,
                ),
                post_water_margin=_number(
                    shrine["post_water_margin"],
                    "accessories.shrine.post_water_margin",
                    positive=True,
                ),
            ),
            board=BoardConfig(reach=_range(board["reach"], "accessories.board.reach", positive=True)),
            interior=InteriorConfig(
                tries=_integer(interior["tries"], "accessories.interior.tries", positive=True),
                slide=_range(interior["slide"], "accessories.interior.slide"),
                door_gap=_number(interior["door_gap"], "accessories.interior.door_gap", positive=True),
            ),
            pump=PumpConfig(reach=_range(pump["reach"], "accessories.pump.reach")),
            bell=BellConfig(
                arc_jitter=_range(bell["arc_jitter"], "accessories.bell.arc_jitter"),
                edge_gap=_range(bell["edge_gap"], "accessories.bell.edge_gap", positive=True),
                path_margin=_number(bell["path_margin"], "accessories.bell.path_margin", positive=True),
            ),
        ),
    )
    if config.accessories.pine.companion_gap < 0.0:
        raise ValueError("generation: accessories.pine.companion_gap must be non-negative")
    if config.accessories.prop.spawn_slack < 0.0:
        raise ValueError("generation: accessories.prop.spawn_slack must be non-negative")
    if config.accessories.shrine.jitter.low < 0.0 or config.accessories.pump.reach.low < 0.0:
        raise ValueError("generation: accessory reach and jitter ranges must be non-negative")
    if (
        config.accessories.pine.companion_distance.low
        < 2.0 * config.accessories.pine.radius + config.accessories.pine.companion_gap
    ):
        raise ValueError("generation: accessories.pine.companion_distance must prevent pine overlap")
    if config.sites.cluster_grid_start >= config.sites.cluster_grid_stop:
        raise ValueError("generation: sites cluster grid must have an increasing start and stop")
    if config.terrain.bank_window_points < 2 or config.terrain.reed_mouth_window_points < 3:
        raise ValueError("generation: terrain bank windows must contain enough points")
    if config.terrain.bank_scan_end < config.terrain.bank_window_points:
        raise ValueError("generation: terrain.bank_scan_end must preserve full bank windows")
    if config.terrain.mouth_edge_margin * 2.0 + config.terrain.mouth_gap.low * 2.0 >= WORLD_SIZE:
        raise ValueError("generation: terrain mouth margins and gaps do not fit the world")
    if config.network.crossing_edge_margin * 2.0 >= WORLD_SIZE:
        raise ValueError("generation: network.crossing_edge_margin leaves no crossing candidates")
    if config.network.crossing_min_x >= WORLD_SIZE - config.network.crossing_edge_margin:
        raise ValueError("generation: network crossing bounds leave no crossing candidates")
    if config.network.water_reach_step > config.network.water_reach_limit:
        raise ValueError("generation: network.water_reach_step must not exceed its limit")
    if config.network.crossing_band_multiplier < 1.0:
        raise ValueError("generation: network.crossing_band_multiplier must not narrow its fallback")
    if config.network.crossing_min_normal_x > 1.0:
        raise ValueError("generation: network.crossing_min_normal_x must not exceed 1")
    if config.accessories.lantern.end_margin * 2 >= WORLD_SIZE:
        raise ValueError("generation: accessories.lantern.end_margin leaves no road stations")
    if config.accessories.lantern.market_spacing > config.accessories.lantern.spacing:
        raise ValueError("generation: accessories.lantern.market_spacing must not exceed normal spacing")
    bounded_spacings = (
        config.accessories.lantern.spacing,
        config.accessories.lantern.market_spacing,
        config.accessories.pine.road_spacing,
        config.accessories.stall.fallback_spacing,
        config.accessories.bench.fallback_spacing,
    )
    if min(bounded_spacings) < 1.0 or config.accessories.pine.scatter_cell < 5.0:
        raise ValueError("generation: accessory spacing is too small for bounded candidate work")
    return config


GENERATION_CONFIG = load_generation_config(
    json.loads(resources.files("three_branches").joinpath("generation.json").read_text(encoding="utf-8"))
)
