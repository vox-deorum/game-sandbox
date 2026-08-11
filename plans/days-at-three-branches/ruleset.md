# Days at Three Branches: Ruleset

Days at Three Branches is one day in the life of a village in Crane Reach. Every NPC in the cast runs a separately constructed copy of one submitted program, differentiated only by the id it reads from its observation. Coordination happens through perception and speech, never through a shared controller or shared memory.

One more character walks the village: the visitor. The visitor is not part of the submission. A human plays it in live sessions, and a scripted visitor plays it in automated runs, wandering the village, approaching NPCs, and offering a few lines of talk. Everything an NPC does about the visitor, greeting, following, avoiding, or fleeing, is built from ordinary locomotion and expression.

The game is one environment plus one variant: daynight. Seasons switch it on and set the cast size. The season schedule is at the end of this document; the teaching arc behind it lives in [pedagogy.md](pedagogy.md).

## Conventions

- Characters move on a continuous 2D plane measured in metres. The village's static map is a grid of square cells. `rules.json` fixes the shipped frame at 100 by 100 cells of 1 metre. Grid and overlay code read those values rather than copying them. The boundary is impassable.
- A character's state is turtle-style: a position (x, y), a heading, and the metres it moved on the latest tick. Facing is the heading.
- The map has two layers, and they stay separate. The cell grid carries ground: every cell has one class, and the class carries the cell's speed limit, its passability, and whether it blocks sight. Props stand on that grid: interactive props and solid scenery reserve cells and carry their own catalog collision shape, so a well pump is round and a bench is square. The ground under a prop keeps its own class. Two placed props never share a cell.
- Water and building walls are impassable ground. Walls are the only ground that blocks sight, so an unblocked line is one that crosses no wall cell, and a doorway carries sight, hearing, and speech normally.
- A building is a semantic, axis-aligned cell group. Its template paints its site: floor ground inside, wall ground around the perimeter, and a 2-cell doorway run through one side. The building record carries an id, a type, and an origin cell; it has no collision object of its own, never enters use selection or prop-state observations, and does not prevent allowed interior props from standing on its floor.
- Every range is measured position to position except interactive-prop use and prop perception. Those rules measure to the nearest point on the prop's collision shape.
- A character is a circle of radius 0.4 m and stands anywhere.
- Characters have one order: the visitor first, then npc_0 upward. That single order fixes the roster, same-tick prop contention, and the platform's player numbering.
- Time advances in ticks, and a day is 1200 ticks.
- The match seed drives village generation, and the scripted visitor derives its own choices from the same seed. A scripted match with the same seed and actions replays identically on the same platform build. Each season pins one default seed, so its matches all play the same village.

## Ticks

A match is a sequence of ticks. Each tick, every character selects one action from the same pre-tick state: nobody sees anyone else's choice for the current tick. The engine then resolves all actions together:

- Movement: every character moves at once, resolved by the physics engine. A character advances at its commanded speed along its heading; solid contact stops it or deflects it along the surface, and nothing passes through a solid or another character. A character commanding speed 0 is immovable for the tick: it turns in place, stays exactly put, and cannot be pushed.
- Prop use: an interactive prop holds one user at a time. When several characters reach for it in the same tick, the first in character order gets it and the rest resolve to expression none. The visitor leads that order, so a human reaching for a bench is never beaten to it by the cast.

A late or missing action, the default, is speed 0, heading unchanged, expression none: the character stands still. Commanded values degrade rather than fail: a heading of 360 wraps to 0, and an expression that is not available, no usable prop or a prop already held, resolves to none.

## The village

Every match plays in Three Branches, generated from the match seed under fixed guarantees; the full generation rules, districts, and grounds live in [village.md](village.md):

- The stable features are each placed once: the central well with its magic pump, the market beside the raised road, the inn, the repair shed, and the old beacon bell.
- A trunk river forks into three channels that cross the village, with homes and fields spread along them. Water is impassable, each channel carries the road's crossing and at most one footpath crossing, and the walkable cells, crossings and building floors included, form one connected region.
- The village always generates five homes, `home_0` through `home_4`, whatever the cast size, so every season plays the same layout. `npc_i` lives in `home_(i mod 5)`, which puts two villagers in each house when the cast is ten. The visitor spawns on the road at the west edge.
- The generator places the village dressing under [village.md](village.md)'s placement rules. Type data, including every count, lives in the catalog below.

Every cell has a ground class. The classes, their speed limits, their passability, and whether they block sight live in `rules.json`, so a new class is a data entry:

| Ground                                       | Speed limit     | Sight       |
| -------------------------------------------- | --------------- | ----------- |
| Road, footpaths, and crossings               | 1.0 m per tick  | carries     |
| Open ground, building floors, and doorways   | 0.75 m per tick | carries     |
| Fields and reed banks                        | 0.5 m per tick  | carries     |
| Water                                        | impassable      | carries     |
| Building walls                               | impassable      | blocks      |

The full static layout is standing knowledge for every character: the ground grid with its crossings, walls, doorways, and floors, the semantic buildings, the scenery, and every interactive-prop placement. What changes during play, characters and interactive-prop states, must be perceived.

## Canonical catalog

`catalog.json` is the machine-readable source. The following tables are the one canonical human-readable catalog. The placement and art documents link here rather than repeat these values.

### Building templates

| Token | Site cells | Count | Site painting | Interior props |
| --- | --- | --- | --- | --- |
| home | 6 by 5 | 5 | floor inside, wall around the perimeter, a 2-cell doorway run through one side | none |
| inn | 10 by 8 | 1 | the same | the hearth |
| shed | 6 by 6 | 1 | the same | the repair bench |

### Interactive prop types

| Token | Physical cells and collision | Count | Activity | States | Start | Transition |
| --- | --- | --- | --- | --- | --- | --- |
| stall | 2 by 2, solid box filling its rect | 5 | tending the stall | open, closed | closed | toggle |
| lantern | 1 by 1, solid inscribed circle | road stations and clearance | lighting | lit, unlit | unlit | toggle |
| bench | 2 by 1, solid box filling its rect | 5 | sitting | occupied, empty | empty | occupancy |
| shrine | 2 by 2, solid box filling its rect | 2 | tending the shrine | tended, untended | untended | timed, 300 ticks |
| board | 1 by 1, solid box filling its rect | 1 | reading the board | none | none | none |
| plot | 3 by 2, solid box filling its rect | 5 | tending the plot | tended, overgrown | overgrown | timed, 600 ticks |
| hearth | 1 by 1, solid inscribed circle | 1 | tending the hearth | lit, unlit | unlit | toggle |
| repair_bench | 2 by 1, solid box filling its rect | 1 | working the bench | busy, idle | idle | occupancy |
| pump | 1 by 1, solid inscribed circle | 1 | working the pump | flowing, idle | idle | timed, 10 ticks |
| bell | 1 by 1, solid inscribed circle | 1 | ringing the bell | ringing, silent | silent | timed, 40 ticks |

### Scenery types

| Token | Physical cells and collision | Count |
| --- | --- | --- |
| pine | 1 by 1, solid inscribed circle | road stations and seeded scatter candidates |
| crate | 1 by 1, solid box filling its rect | one or two beside each stall |

Props and scenery are solid and never block sight. Only interactive props participate in use selection, holding, transitions, and dynamic prop-state observations; scenery is static layout knowledge.

## Characters

Every character, NPC or visitor, has the same profile:

| Property    | Value                                                          |
| ----------- | -------------------------------------------------------------- |
| Body radius | 0.4 m                                                          |
| Speed       | commanded as a fraction, 0 to 1 of the ground's limit          |
| Running     | above 0.5 m per tick reads as running, at or below as walking  |
| Vision      | 120 degree cone on the heading, out to 12 m                    |
| Hearing     | 6 m, all around, and the range a spoken line carries           |
| Prop reach  | 1.5 m                                                          |

A cast of N runs ids npc_0 through npc_N-1, fixed for the whole match; the visitor's id is visitor. Each NPC starts the day on the floor of its home facing the doorway, housemates spaced at least a body diameter apart, and the visitor starts at the road spawn, facing into the village along the road; everyone starts still, expression none. The engine assigns ids and homes; roles, personalities, and relationships are the submission's to author.

## Actions

Each tick a character issues one composite action with two independent parts, and both resolve every tick, so a character can walk and wave at once:

- Locomotion: a heading and a relative speed from 0 to 1. The character moves at that fraction of the speed limit of the ground under it at the tick's start. Speed 0 turns in place: the new heading applies and the character stays put.
- Expression: none, one emote, or one prop use.

Emotes are engine-defined and all available from Season 1:

| Emote      | Reads as                        |
| ---------- | ------------------------------- |
| wave       | greeting                        |
| nod        | agreement                       |
| shake_head | refusal                         |
| point      | directing attention             |
| laugh      | amusement                       |
| shrug      | uncertainty                     |
| startle    | surprise, a routine interrupted |
| sleep      | off duty                        |
| sweep      | a chore                         |

A prop use engages the nearest interactive prop whose collision shape has its nearest point within reach with an unblocked line to that point, and puts the character into that prop's activity, sitting on a bench or working the pump, visible to observers like an emote. Ties break by canonical prop order. Facing does not enter into it: a prop you are standing beside is always in reach of a use. Selection and reach are judged on the tick's starting pose, and a use needs stillness: commanded speed above 0 resolves the expression to none. A character holds a use by choosing it again each tick, and releases it by choosing anything else, by moving, or by leaving its reach.

Every interactive prop starts the day unheld in its start state, and its state follows its transition rule:

- toggle: the state flips on the tick a use newly begins; holding never retoggles, and the state keeps after release.
- occupancy: the active state holds exactly while a character holds the use.
- timed: beginning a use sets the active state, which holds while the use is held and reverts the table's count of ticks after it was last held.

The interactive-prop table above is `catalog.json`'s content in canonical reading order. A data-only prop type works when it uses an existing transition, placement, and art mechanism.

## Speech

Speech runs beside the tick action, so a character can speak while doing anything else.

- A character may speak one short line per tick, up to 200 code points.
- The line reaches every character within hearing range with an unblocked line, which is exactly the set of characters that can hear the speaker. If you can hear someone, you hear what they say, so there is no separate loudness to choose and no addressee to pick. The village-wide signal is the beacon bell.
- A line spoken on tick T reaches its hearers during tick T+1, after they have chosen that tick's action, so the earliest action it can inform is tick T+2's.
- Every line is public. It appears as a speech bubble over the speaker and in the chat panel of every client, the playing visitor's included, because nothing in this village is hidden from a viewer.

Visitor speech is freeform text typed by a human, or canned lines from the scripted visitor, and NPCs answer with their ordinary speech, so a conversation is two characters standing within hearing range and exchanging lines two ticks apart.

## Perception

Each tick a character receives:

- Itself: id, position, heading, the distance it moved on the latest tick, and current expression.
- Every character it sees, within the vision cone with an unblocked line: id, position, heading, distance moved, and current expression.
- Every character it hears, within hearing range with an unblocked line, whatever the facing: id and position.
- The state of every interactive prop it sees, under the cone and line rules applied to the nearest point of the prop's collision shape. While the beacon bell rings, every character perceives it, whatever the distance and whatever stands between.
- The tick number, and the day phase when the daynight variant is on.

Only wall ground blocks a line, so a doorway lets a villager see and hear into a house while its walls do not, and props and scenery never hide anything.

This observation, plus standing knowledge (the full static layout, the cast roster, and the season's parameter values) and the speech that has reached it, is everything available when the character selects its action. Anything about the past lives in the character's own code.

## The daynight variant (Season 4 onward)

The day gains phases, observed by every character:

| Phase   | Ticks       |
| ------- | ----------- |
| Dawn    | 1 to 120    |
| Morning | 121 to 480  |
| Midday  | 481 to 720  |
| Evening | 721 to 960  |
| Night   | 961 to 1200 |

The phases name the time of day for characters, and set how the village is lit on screen; every movement and perception rule holds around the clock.

## The day and the score

A match is one village day and ends at tick 1200.

The episode score is a health check, identical for every player in the cast: 100 when every NPC instance completes the day without crashing, sending a malformed action, or exhausting its compute budget, and 0 otherwise. A single late action is not a failure: the character simply stands still for that tick. Believability is judged by people rather than by this score; each season's human rating is described in [pedagogy.md](pedagogy.md).

## Seasons

| Season | Cast | daynight |
| ------ | ---- | -------- |
| 1      | 5    | off      |
| 2      | 10   | off      |
| 3      | 10   | off      |
| 4      | 10   | on       |
| 5      | 10   | on       |
| 6      | 10   | on       |

Seasons that share a row differ in the course rather than the game; the arc lives in [pedagogy.md](pedagogy.md).
