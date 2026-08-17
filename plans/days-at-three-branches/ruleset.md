# Days at Three Branches: Ruleset

Days at Three Branches follows one village day in Crane Reach. Every NPC runs a separately constructed copy of one submitted program, distinguished only by the player id in its observation. NPCs coordinate through perception and speech, never shared memory or a shared controller.

The visitor is outside the submission. A human plays it live and `scripted_visitor` plays it in automated runs. NPC behavior toward the visitor, including greeting, following, avoiding, and fleeing, uses ordinary locomotion and expression.

There is one environment variant, `daynight`. Seasons select it and cast size. The [pedagogy arc](pedagogy.md) explains the teaching sequence.

## Conventions

- Characters move continuously in metres. `rules.json` fixes the shipped grid at 120 by 120 square 1 metre cells. Grid and overlay code read these values.
- Character state is position, heading, and metres moved on the latest tick. Facing is heading.
- The grid carries ground. Its class sets speed limit, passability, and sight blocking. Interactive props and solid scenery stand on it, reserve cells, and use catalog collision shapes turned to their facing. The ground beneath a prop retains its class. Placed props do not share cells.
- Water and building walls are impassable. Only walls block sight. An unblocked line crosses no wall cell, and doorways carry sight, hearing, and speech.
- A building is a semantic axis-aligned cell group. Its template paints floor inside, wall around the perimeter, and a 2-cell doorway run through one side. Its record has id, type, and origin only; it has no collision object, use selection, or prop-state observation.
- Ranges measure position to position. Interactive-prop use and perception instead measure to the nearest point on the prop collision shape.
- A character is a 0.4 m circle. The frame boundary is impassable.
- Character order is `player_0`, the visitor, then `player_1` upward for NPCs. It sets roster order and same-tick prop contention.
- A day has 1200 ticks. The match seed identifies the layout input. Shipped production builtins use fresh entropy, so two live builtin sessions with the same seed need not make the same choices. A fixed layout and fixed action sequence replay identically on the same platform build.
- Step 4 blesses one course default seed. Later [per-season configuration](../../docs/specs/seasons.md#per-season-configuration) pins that same seed for every season.

## Ticks

Every character chooses one action from the same pre-tick state. The engine then resolves the tick together.

- **Movement:** Characters advance at commanded speed along heading. Physics stops or slides them at solids and other characters. Speed 0 turns in place, holds position exactly, and cannot be pushed.
- **Prop use:** One interactive prop holds one user. Same-tick contenders resolve in character order; the visitor leads, so a human is never beaten to a prop by the cast.

A late or missing action is heading unchanged, speed 0, expression none. In-space commands degrade rather than fail: heading 360 wraps to 0, and unavailable expressions, missing usable props, and held props resolve to none.

## The village

Every match generates Three Branches from the match seed under the [village layout and placement guarantees](village.md#generation-order-and-guarantees). The village always has five homes, `home_0` through `home_4`, regardless of cast size. NPC `player_i` lives in `home_((i - 1) mod 5)`, placing two villagers in each home for cast_10. The visitor spawns on the road, `network.spawn.edge_inset` cells inside the west edge.

Every cell has a ground class. `rules.json` holds its speed limit, passability, and sight behavior.

| Ground                                     | Speed limit     | Sight   |
| ------------------------------------------ | --------------- | ------- |
| Road, footpaths, and crossings             | 1.0 m per tick  | carries |
| Open ground, building floors, and doorways | 0.75 m per tick | carries |
| Fields and reed banks                      | 0.5 m per tick  | carries |
| Water                                      | impassable      | carries |
| Building walls                             | impassable      | blocks  |

The complete static layout is standing knowledge: ground, crossings, walls, doorways, floors, semantic buildings, scenery, and interactive-prop locations. Characters and interactive-prop states must still be perceived.

## Canonical catalog

`catalog.json` is the machine-readable source. These tables are the canonical human-readable catalog. Placement and art documents link here rather than restating values.

### Building templates

| Token | Site cells | Count | Site painting | Interior props |
| --- | --- | --- | --- | --- |
| home | 8 by 7 | 5 | floor inside, wall around the perimeter, a 2-cell doorway run through one side | none |
| inn | 12 by 10 | 1 | the same | the hearth |
| shed | 8 by 8 | 1 | the same | the repair bench |

The wall ring takes a cell off each side, so a site's floor is its cells less two in each direction.

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
| pump | 1 by 1, centered 0.6-cell-diameter solid circle | 1 | working the pump | flowing, idle | idle | timed, 10 ticks |
| bell | 1 by 1, centered 0.6-cell-diameter solid circle | 1 | ringing the bell | ringing, silent | silent | timed, 40 ticks |

### Scenery types

| Token | Physical cells and collision | Count |
| --- | --- | --- |
| pine | 1 by 1, solid inscribed circle | road stations and seeded scatter candidates |
| crate | 1 by 1, solid box filling its rect | one or two beside each stall |

Props and scenery are solid but never block sight. Only interactive props participate in use selection, holding, transitions, and dynamic prop-state observations. Scenery is static layout knowledge.

## Characters

NPCs and the visitor share this profile.

| Property    | Value                                                         |
| ----------- | ------------------------------------------------------------- |
| Body radius | 0.4 m                                                         |
| Speed       | commanded as a fraction, 0 to 1 of the ground's limit         |
| Running     | above 0.5 m per tick reads as running, at or below as walking |
| Vision      | 120 degree cone on the heading, out to 12 m                   |
| Hearing     | 6 m, all around, and the range a spoken line carries          |
| Prop reach  | 1.5 m                                                         |

A cast of N has NPCs `player_1` through `player_N` for the full match. The visitor is `player_0`. Each NPC begins on its home's floor facing the doorway, with housemates at least one body diameter apart. The visitor begins at the road spawn facing along the road into the village. Everyone begins still with expression none. The engine assigns ids and homes; the submission authors roles, personalities, and relationships.

## Actions

Each tick has locomotion and expression, so a character can walk and wave together.

- **Locomotion:** heading and relative speed 0 to 1. The fraction applies to the ground speed limit at the tick's start. Speed 0 turns without moving.
- **Expression:** none, one emote, or one prop use.

All emotes are available from Season 1.

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

A prop use selects the nearest interactive prop whose nearest collision-shape point is within reach and visible by an unblocked line. Ties use canonical prop order. Facing does not matter. Selection uses the tick's starting pose. Commanded speed above 0 resolves use to none. A character holds use by selecting it each tick and releases it by choosing another expression, moving, or leaving reach.

Every interactive prop starts unheld in its start state.

- **toggle:** State flips when use begins. Holding does not retoggle, and release preserves the state.
- **occupancy:** Active state lasts exactly while a character holds use.
- **timed:** Beginning use sets active state. It lasts while held, then reverts after the table's tick count since it was last held.

A prop type can remain data-only when it uses existing transition, placement, and art mechanisms.

## Speech

Speech runs beside the tick action. A message is a broadcast or names one addressee. Broadcast remains available. Both require hearing range and an unblocked line. The beacon bell is the village-wide signal.

On one tick a character may send one broadcast and one direct message to each character it can address at that moment. Each message has at most 200 code points. A message sent on tick T reaches its recipients during T+1 after action choice. The earliest reaction is T+2.

The two kinds check range at different moments. A character's permitted addressees are fixed from the state it spoke in, so a direct line still arrives when its addressee walks out of range or behind a wall during that tick. A broadcast's audience is resolved once everyone has moved, so it reaches whoever is in range at the end of the tick.

Visitor speech is freeform human text or canned scripted-visitor text. NPCs use ordinary speech. [Environment speech](environment.md#speech) defines recipient policy and viewer visibility.

## Perception

Every tick, a character receives itself, other characters it sees, other characters it hears, states of visible interactive props, the global bell state, tick, phase, and static standing knowledge.

Seen characters are inside the vision cone and an unblocked line, with id, position, heading, latest moved distance, and expression. Heard characters are inside hearing range and an unblocked line, with id and position. Visible prop state uses the same cone and line rule measured to its collision shape. A ringing beacon bell is visible to every character at any distance.

Only walls block lines. Doorways carry sight and hearing; props and scenery do not hide anything. This observation, static layout, roster, parameter values, and received speech are all that is available for an action. Past state belongs in the character's code.

## The daynight variant (Season 4 onward)

| Phase   | Ticks       |
| ------- | ----------- |
| Dawn    | 1 to 120    |
| Morning | 121 to 480  |
| Midday  | 481 to 720  |
| Evening | 721 to 960  |
| Night   | 961 to 1200 |

Phases name the time and set screen lighting. Movement and perception rules do not change.

## The day and the score

A match ends at tick 1200. The cast health check is 100 when every NPC instance completes without crashing, malformed action, or exhausted compute budget; otherwise it is 0. A late action only stands still for that tick. Human ratings judge believability, as [pedagogy.md](pedagogy.md) defines.

## Seasons

| Season | Cast | daynight |
| ------ | ---- | -------- |
| 1      | 5    | off      |
| 2      | 10   | off      |
| 3      | 10   | off      |
| 4      | 10   | on       |
| 5      | 10   | on       |
| 6      | 10   | on       |

Seasons sharing a row differ in course design rather than game parameters. See [pedagogy.md](pedagogy.md).
