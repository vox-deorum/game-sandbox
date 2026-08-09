"""The complete deterministic village used until seeded generation arrives."""

from __future__ import annotations

from .layout import Bridge, Building, Doorway, Layout, Polyline, Prop, Scenery
from .prop_types import PROP_TYPE_BY_TOKEN


def _prop(type: str, index: int, position: tuple[float, float], rotation: float = 0.0) -> Prop:
    prop_type = PROP_TYPE_BY_TOKEN[type]
    return Prop(
        f"{type}_{index}", type, position, (prop_type.footprint.width, prop_type.footprint.depth), rotation
    )


FIXTURE_VILLAGE = Layout(
    channels=(
        Polyline(((50.0, 100.0), (50.0, 65.0)), 6.0),
        Polyline(((50.0, 65.0), (28.0, 48.0), (20.0, 0.0)), 5.0),
        Polyline(((50.0, 65.0), (50.0, 0.0)), 5.0),
        Polyline(((50.0, 65.0), (72.0, 48.0), (80.0, 0.0)), 5.0),
    ),
    road=Polyline(((0.0, 25.0), (15.0, 25.0), (70.0, 29.0), (100.0, 25.0)), 4.5),
    footpaths=(
        Polyline(((12.0, 25.0), (12.0, 58.0), (8.0, 65.0)), 2.0),
        Polyline(((18.0, 25.21818181818182), (18.0, 75.0)), 2.0),
        Polyline(((57.0, 28.054545454545455), (62.0, 55.0), (67.0, 75.0)), 2.0),
        Polyline(((88.0, 26.6), (87.0, 65.0)), 2.0),
        Polyline(((92.0, 26.066666666666666), (90.0, 85.0)), 2.0),
        Polyline(((50.0, 27.545454545454547), (47.0, 50.0)), 2.0),
        Polyline(((15.0, 25.0), (15.0, 32.0)), 2.0),
        Polyline(((70.0, 29.0), (70.0, 32.0)), 2.0),
    ),
    bridges=(
        Bridge((24.279141104294478, 25.67484662576687), 4.159642293712642, 3.0, 7.5),
        Bridge((50.0, 27.545454545454547), 4.159642293712642, 3.0, 7.5),
        Bridge((75.2840909090909, 28.295454545454547), 352.40535663140855, 3.0, 7.5),
    ),
    buildings=(
        Building("home_0", "home", (8.0, 65.0), 6.0, 5.0, 0.0, Doorway((8.0, 62.5))),
        Building("home_1", "home", (18.0, 75.0), 6.0, 5.0, 0.0, Doorway((18.0, 72.5))),
        Building("home_2", "home", (67.0, 75.0), 6.0, 5.0, 0.0, Doorway((67.0, 72.5))),
        Building("home_3", "home", (87.0, 65.0), 6.0, 5.0, 0.0, Doorway((87.0, 62.5))),
        Building("home_4", "home", (90.0, 85.0), 6.0, 5.0, 0.0, Doorway((90.0, 82.5))),
        Building("inn", "inn", (88.0, 38.0), 10.0, 8.0, 0.0, Doorway((88.0, 34.0))),
        Building("shed", "shed", (10.0, 38.0), 6.0, 6.0, 0.0, Doorway((10.0, 35.0))),
    ),
    fields=(
        ((4.0, 4.0), (17.0, 4.0), (17.0, 17.0), (4.0, 17.0)),
        ((83.0, 4.0), (96.0, 4.0), (96.0, 17.0), (83.0, 17.0)),
    ),
    reed_banks=(
        ((10.0, 39.0), (18.0, 37.0), (21.0, 47.0), (13.0, 50.0)),
        ((79.0, 39.0), (87.0, 37.0), (90.0, 47.0), (82.0, 50.0)),
    ),
    props=(
        *tuple(
            _prop("stall", index, position)
            for index, position in enumerate(
                ((32.0, 32.0), (36.0, 32.0), (40.0, 32.0), (34.0, 21.0), (40.0, 21.0))
            )
        ),
        *tuple(
            _prop("lantern", index, position)
            for index, position in enumerate(
                (
                    (5.0, 29.0),
                    (15.0, 21.0),
                    (30.0, 21.0),
                    (43.0, 29.0),
                    (47.0, 24.0),
                    (60.0, 29.0),
                    (70.0, 21.0),
                    (83.0, 29.0),
                    (96.0, 21.0),
                )
            )
        ),
        *tuple(
            _prop("bench", index, position, 0.0)
            for index, position in enumerate(
                ((43.0, 48.0), (54.0, 48.0), (32.0, 35.0), (44.0, 35.0), (82.0, 31.0))
            )
        ),
        _prop("shrine", 0, (15.0, 33.0)),
        _prop("shrine", 1, (70.0, 33.0)),
        _prop("board", 0, (37.0, 35.0)),
        _prop("plot", 0, (8.0, 68.5)),
        _prop("plot", 1, (18.0, 78.5)),
        _prop("plot", 2, (67.0, 78.5)),
        _prop("plot", 3, (87.0, 68.5)),
        _prop("plot", 4, (90.0, 88.5)),
        _prop("hearth", 0, (88.0, 41.7)),
        _prop("repair_bench", 0, (10.0, 40.75)),
        _prop("pump", 0, (47.0, 50.0)),
        _prop("bell", 0, (16.0, 29.0)),
    ),
    scenery=(
        Scenery("pine", (4.0, 55.0), 0.8),
        Scenery("pine", (6.0, 57.0), 0.8),
        Scenery("pine", (94.0, 70.0), 0.8),
        Scenery("pine", (96.0, 72.0), 0.8),
        Scenery("crate", (30.65, 33.35), 0.5),
        Scenery("crate", (34.65, 33.35), 0.5),
        Scenery("crate", (41.35, 33.35), 0.5),
        Scenery("crate", (32.65, 19.65), 0.5),
        Scenery("crate", (41.35, 19.65), 0.5),
        *tuple(
            Scenery("post", position, 0.2)
            for position in (
                (14.0, 32.0),
                (16.0, 32.0),
                (14.0, 34.0),
                (16.0, 34.0),
                (69.0, 32.0),
                (71.0, 32.0),
                (69.0, 34.0),
                (71.0, 34.0),
            )
        ),
    ),
    spawn=(1.0, 25.0),
)
