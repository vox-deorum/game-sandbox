# Skirmish at Crane Reach

Skirmish at Crane Reach is a turn-based tactics game on a hex field. Two detachments, Red and Blue, fight over ground in Crane Reach. Your team wins by defeating the other side, reaching the capture target when capture zones are enabled, or leading when the round limit ends. The shared [agent interface](../../docs/students/agent-interface.md) explains the `reset` and `act` methods used by every environment. This page covers everything specific to Skirmish at Crane Reach.

One thing to know before anything else: your code does not command an army. It runs separately inside every single unit, and those copies share no memory. Whatever coordination your side manages has to come out of what each unit can see and what its allies tell it.

## Seats and units

A **player** is one unit on the field. A **seat** is the set of players that one submission controls, which here is always a whole side. There are two seat plans:

| Plan                 | What one submission controls                          |
| -------------------- | ----------------------------------------------------- |
| `skirmish` (default) | One side of 3 units: 1 footman, 1 archer, 1 cavalry   |
| `army`               | One side of 20 units: 8 footmen, 6 archers, 6 cavalry |

Red holds the first half of the players and Blue the second. Within a side, the players run the footmen first, then the archers, then the cavalry, in index order. Every unit has a stable id of the form `side_type_index`, such as `red_archer_0`, fixed for the whole match. In the `skirmish` plan `player_0` is `red_footman_0`, `player_1` is `red_archer_0`, `player_2` is `red_cavalry_0`, and `player_3` through `player_5` repeat the order for Blue. Every observation carries both rosters, so you never have to work this mapping out yourself.

Game Sandbox creates a separate `Agent()` object for every unit. They come from the same code but do not share variables, and none of them sees another one's observation. Keep only that unit's own state in the object, and use the optional `chat` method to pass anything else along.

The field is symmetric, but a fixed seed still gives the two seats different spawn halves and different activation draws, so swapping sides changes the match.

> _Never played on a hex map?_ Every tile has six neighbors instead of four, and a position is a pair of axial coordinates `q` and `r` instead of a row and a column. The [Wikipedia article about hex maps](https://en.wikipedia.org/wiki/Hex_map) introduces the idea.

## How a match works

A match is a sequence of **rounds**. In each round every living unit **activates** exactly once, in an order shuffled fresh at the start of that round. You cannot count on moving before any particular enemy, and you cannot count on it twice in a row.

On its activation a unit issues exactly one **order**: a path of up to four steps, possibly empty, and optionally one named enemy target. The unit walks the whole path, then strikes once from the tile it ends on. Walk, then strike, always in that order and always inside the same activation. The result applies immediately, so later activations in the same round see it.

The strike is close to unavoidable:

- If you named a target that is still alive and within your attack range of your final tile, you strike it.
- Otherwise your unit strikes the nearest enemy in range of that tile, drawn at random when several are tied for nearest. A named target that ends up out of range falls back to this same draw.
- If no enemy is in range at all, nothing happens.

So standing still is not a way to stay out of a fight. The only way to avoid one is to end your activation out of range of every enemy, and the only way to pick your fight is to end it in range of the enemy you want. An attack always hits. A unit reduced to 0 hit points leaves the field immediately, which means a unit killed early in a round never gets its activation that round.

## Units and the battlefield

Three unit types, with fixed stats:

| Stat            | Footman | Archer | Cavalry |
| --------------- | ------- | ------ | ------- |
| Hit points      | 12      | 6      | 10      |
| Movement points | 2       | 2      | 4       |
| Attack range    | 1       | 6      | 1       |
| Damage          | 3       | 2      | 3       |
| Vision          | 4       | 6      | 6       |

Damage is the attacker's damage stat after every adjustment below, and it is never reduced below 1.

The field is a hexagon of hex tiles, 15 tiles across in the early seasons and 21 later. It is point-symmetric: rotate it 180 degrees about its center and it maps onto itself, with the two sides' spawn positions mirrored, so neither side gets better ground. Every passable tile is reachable from every other. A tile holds at most one unit.

Each tile has one terrain and at most one feature, and their effects stack. A hill carrying a forest costs 3 to enter and gives both the hill's effects and the forest's cover.

| Terrain or feature | Move cost | Effect |
| --- | --- | --- |
| Grass (terrain) | 1 | None. The whole field when terrain is off. |
| Hill (terrain) | 2 | High ground: an attack from a hill onto lower ground deals 1 extra damage, and an attack from lower ground onto a hill deals 1 less. A unit on a hill also sees 1 tile farther. |
| Water (terrain) | impassable | Shapes the two or three passages between the halves of the field. |
| Forest (feature) | +1 | Cover: a unit in forest takes 1 less damage from attacks made from more than 1 tile away, and no charge bonus applies against it. |
| Marsh (feature) | +2 | Slow ground. |
| Wasteland (feature, `waste` in the observation) | +0 | Magical waste: entering costs 2 hit points, never reduced below 1. Standing on it is free, so only the step in hurts. |

Vision and attacks ignore terrain everywhere. Terrain prices movement and adjusts damage; it never blocks sight or arrows.

A unit begins every activation with its full movement points and pays each tile's cost as it enters. The first step is always allowed onto any empty passable tile, however expensive it is; after that a step needs enough points left to pay for it. Once the balance would go below zero, that tile has to be the end of the path. Entry damage applies once per tile entered, including the last one, so a path that crosses the same wasteland tile twice pays twice.

When a season turns unit abilities on, two more rules apply:

- **Charge.** A cavalry unit that ends its walk at least 3 tiles from where it started strikes with 2 extra damage on that same activation.
- **Shield wall.** A footman standing next to an allied footman takes 1 less damage and is never hit by a charge bonus. A lone footman gets neither.

## Your turn

On a unit's activation, `act` receives a dictionary with two keys:

```text
observation
├── "observation"   your unit, what it can see, the battlefield, and the rosters
└── "action_mask"   which paths and which targets are legal right now
```

Your `act` returns a dictionary with two keys, one for each half of the order:

```python
def act(self, observation: SkirmishObservation) -> SkirmishAction:
    return {"path": 0, "target": 0}
```

`path: 0` means stay in place, and `target: 0` names nobody, so the automatic strike decides. That order is legal in every state, and it is also what the game plays for you if your code ever answers late.

The mask has one array per choice, `observation["action_mask"]["path"]` and `observation["action_mask"]["target"]`. A `1` means that value is allowed on this activation, and a `0` means the environment rejects it. The two choices are independent, so any allowed path combines with any allowed target. The stay bit and the no-target bit are always `1`.

You do not have to read those arrays. `action.legal_paths(observation)` and `action.possible_targets(observation)` read them for you, and `action.move` and `action.stay` build the order dictionary.

Here is a first agent that actually does something: walk one step toward the nearest enemy it can see, and name that enemy. This is the fighting half of your template's `agent.py`. The template adds one more habit on top, covered in [Your first agent](#your-first-agent): marching toward the enemy side while nothing is visible yet.

```python
from sandbox.crane import action, me, tile, visible
from sandbox.observation_types import SkirmishAction, SkirmishObservation


class Agent:
    """Steps toward the nearest enemy this unit can see, and names it as the target."""

    def reset(self, seed: int) -> None:
        # Called once before each match. This agent remembers nothing between
        # turns, so there is nothing to prepare for now.
        pass

    def act(self, observation: SkirmishObservation) -> SkirmishAction:
        # Every unit this one can see, minus its own side.
        enemies = visible.enemies(observation)

        # Nothing to chase, so hold position. Standing still is always legal,
        # and it still attacks whatever walks into range.
        if not enemies:
            return action.stay()

        # Where this unit is standing, as a {"q": ..., "r": ...} position.
        here = me.position(observation)

        # The closest enemy in sight. min hands back the unit, not the distance.
        target = min(enemies, key=lambda unit: tile.distance(here, unit["position"]))

        # The number to beat: a step landing closer than this is progress.
        gap = tile.distance(here, target["position"])

        # legal_steps lists the single steps the mask allows right now, so every
        # step in this loop is one the environment accepts.
        for step in action.legal_steps(observation):
            # Where that step would land us.
            landing = tile.at_path_end(here, step)

            # Take the first step that closes the gap, naming the target on the
            # way so our strike prefers it. Anything we can see we can name.
            if tile.distance(landing, target["position"]) < gap:
                return action.move(step, target["unit_id"], observation)

        # TODO(you): nothing gets closer, so hold and keep the target named.
        # A unit that only ever walks at the nearest enemy arrives alone.
        return action.stay(target["unit_id"], observation)
```

This agent cannot make an illegal move, because every path it returns came out of `action.legal_steps` and every target is an enemy it can see. It is also nowhere near good: [Your first improvement](#your-first-improvement) starts from what goes wrong when you watch it play.

## What a unit can see

Everything meaningful sits under `observation["observation"]`. Four fields change from one activation to the next:

- `self`: your own `unit_id`, `type`, `position`, `hit_points`, remaining `movement_points`, and `direction`, the digit that heads toward the enemy side.
- `visible_units`: every other unit inside your vision radius, friend and enemy alike, with its `unit_id`, `side`, `type`, `position`, and `hit_points`. Units outside your vision are simply absent, and nothing tells you how many are missing.
- `round`: the current round number, counting from 1.
- `capture`: both sides' capture scores and the score that ends the match. All zero when capture play is off.

Three more fields are standing knowledge, identical for every unit and constant for the whole match: `battlefield` holds the tile grid and the capture zones, `rosters` holds both sides' complete starting rosters, and `parameters` holds the settings this match resolved to. Positions everywhere are axial dictionaries shaped like `{"q": 8, "r": 5}`.

Notice what is not there. The observation carries no history, no record of who hit you last round, and nothing at all from beyond your vision. Anything you want to remember, you store on your own instance. Anything you want to know about the far side of the field has to arrive by message.

The observation and action shapes are available as `SkirmishObservation` and `SkirmishAction`, importable from `sandbox.observation_types`, for editors and type checkers. [Under the hood](#under-the-hood) lists every field precisely.

## Your first agent

Your template contains a complete working agent: the strategy from [Your turn](#your-turn), plus one habit for when there is nothing to chase yet. Every unit walks one step toward the nearest enemy it can see and names it as the target. While nothing is visible, it walks one step in `me.direction(observation)`, the digit that heads toward the enemy side.

That second habit matters more than it looks. Spawns sit farther apart than any unit can see, so an agent that waits for a target waits forever. Both sides march the same way, so the two lines walk into each other and the fight starts. The template cannot make an illegal move and never crashes, and the `TODO(you)` comments in `agent.py` mark exactly where it is deliberately weak.

Run it from the template folder:

```console
python -m sandbox play                     # watch your agent run every unit on both sides
python -m sandbox human --player 1         # steer one unit yourself; your agent runs the rest
python -m sandbox human --companion self   # steer every unit on your own side yourself
python -m sandbox eval                     # play several seeded episodes and report the mean score
python -m sandbox eval --vs rivals/v1      # play against a saved copy of your agent
python -m sandbox test                     # run the checks
```

`--player` takes a player index, so `--player 1` in the `skirmish` plan puts you in `red_archer_0`. `eval` reports the higher-is-better team score from [Scoring and rewards](#scoring-and-rewards). It is useful for comparing changes against the same seeds, not for predicting leaderboard results. Add `--preset season_3` to `play` or `human` to try one season's settings; `eval` reads `season.json` and repeated `--parameter` overrides instead.

## Scoring and rewards

Every player on a side receives the identical **team score**, a number from 0 to 100. Any win scores 70 to 100, a draw scores 50, and any loss scores 0 to 30, so how well you lose still counts and how convincingly you win still counts.

How a match ends depends on whether capture zones are on:

- **Elimination**, with capture zones off. The match ends when one side has no living units, or at the round cap. Wiping out the enemy scores 70 plus up to 30 more for the fraction of your hit points still standing, against 0 for the eliminated side. At the round cap the side with more total remaining hit points wins, with the margin measured as the hit point difference against the winner's starting total. Equal totals draw.
- **Capture**, with zones on. After every round, a zone holding living units from exactly one side gives that side 1 point, while a contested or empty zone gives nobody anything. The first side to reach the capture target wins. Eliminating the other side outright scores 100 against 0. Otherwise the higher capture score wins, an equal capture score falls back to remaining hit points, and the margin is the capture score difference measured against the target.

Rewards work differently from the official score, and the difference matters if you train on them. Every step during a match gives a reward of `0.0`. On the final step, every player still alive receives its side's team score as its terminal reward. A unit killed earlier stops at `0.0` and receives nothing later, but the reported match result still assigns it the full team score, so a unit that dies buying a win is not scored as though it lost. If your training needs the eventual team outcome for a unit that died early, read it out of the recording after the session.

A seat that forfeits, by crashing, returning an illegal action, or using up the game limit, scores 0, at or below every honest outcome.

## The helpers

The starting agent uses the template's `sandbox.crane` helpers, six small namespaces. Import the ones you need at the top of `agent.py`, not inside a method:

```python
from sandbox.crane import action, me, tile, visible
```

Every helper reads the observation or the authoritative action mask, so a path or target one of them hands you is one the environment accepts. None of them decides anything for you.

`action` reads what is legal and builds the order your `act` returns.

| Helper | Result |
| --- | --- |
| `action.legal_paths(observation)` | Every path id legal right now, straight from the action mask, `0` (stay) included |
| `action.legal_steps(observation)` | Which of the six tiles around you that you can walk onto. Their path ids are just their direction digits, `1` through `6` |
| `action.possible_targets(observation)` | The enemy unit ids you may name right now, in roster order |
| `action.move(path_id, target_id=None, observation=None)` | Builds the `{"path", "target"}` order; naming a target needs the observation to resolve its roster slot |
| `action.stay(target_id=None, observation=None)` | The stand-still order, optionally naming a target |

`me` reads your own unit, saving you a trip through `observation["observation"]["self"]`.

| Helper | Result |
| --- | --- |
| `me.position(observation)` | The position your unit stands on |
| `me.direction(observation)` | The digit that heads toward the enemy side, `2` for red and `5` for blue, the same all match |
| `me.unit_id(observation)`, `me.side(observation)`, `me.unit_type(observation)` | Who this unit is: its id, `"red"` or `"blue"`, and `"footman"`, `"archer"`, or `"cavalry"` |
| `me.hit_points(observation)`, `me.movement_points(observation)` | What it has left, and what it can spend this activation |

`visible` and `roster` cover the other units, the ones in sight and the ones on the books.

| Helper | Result |
| --- | --- |
| `visible.enemies(observation)` | The units of the other side your unit can see; every one of them is nameable this turn |
| `visible.allies(observation)` | The units of your own side your unit can see; your own unit is never among them |
| `roster.enemies(observation)`, `roster.allies(observation)` | Each side's complete starting roster, alive or not, for addressing a unit you cannot see |

`tile` is hex geometry and the ground itself. Positions are `{"q", "r"}` dictionaries throughout.

| Helper | Result |
| --- | --- |
| `tile.distance(first, second)` | Hex distance between two positions, counted in steps |
| `tile.neighbors(position)` | The six adjacent positions keyed by direction digit; the mask stays the authority on which are legal |
| `tile.at_path_end(position, path_id)` | Where a path would put you, without walking the digits yourself |
| `tile.at_center(observation)` | The middle of the field, the landmark both sides share |
| `tile.at_mirror(position, observation)` | The position opposite a given one. The field is symmetric, so the mirror of your own starting ground is always enemy ground |
| `tile.terrain_at(observation, position)` | The `{"terrain", "feature"}` pair standing on a position; anything off the field reads as void |
| `tile.DIRECTIONS` | Digit to `(dq, dr)`: `1` northeast, `2` east, `3` southeast, `4` southwest, `5` west, `6` northwest |

`paths` is the encoding itself, for when you plan a route longer than one step.

| Helper | Result |
| --- | --- |
| `paths.encode(directions)` | Turns a sequence of direction digits, up to four, into the path id `act` returns; `paths.encode(())` is `0` |
| `paths.decode(path_id)` | Turns a path id back into its direction digits; `paths.decode(0)` is `()` |
| `paths.MAX_ID`, `paths.MAX_STEPS` | `1554` and `4` |

An invalid direction digit or path id raises `ValueError`.

The helpers deliberately ship no pathfinder. Turning a route across the field into a legal four-step order, and replanning it as the battlefield changes under you, is the work this course is about.

## Under the hood

This is optional advanced reference material. The helpers cover everything the starting agent needs, and most agents never read this section.

### Path ids

Path `0` means stay. Paths `1` through `1554` name every sequence of one to four direction digits, because 6 + 36 + 216 + 1296 is 1554. Four steps is the ceiling: the fastest unit has 4 movement points and every step costs at least 1, so no order can hold a fifth.

The ids are ordered first by path length and then lexicographically, with the last digit varying fastest. Path `1` is `[1]` and path `6` is `[6]`. Path `7` is `[1, 1]`, path `8` is `[1, 2]`, and path `42` is `[6, 6]`. Path `43` is `[1, 1, 1]`, path `259` is `[1, 1, 1, 1]`, and path `1554` is `[6, 6, 6, 6]`. `paths.encode` and `paths.decode` do this conversion in both directions. So a one-step path id is just its direction digit. That is why `action.move(me.direction(observation))` takes one step toward the enemy side.

| Digit | Direction | `dq, dr` |
| ----- | --------- | -------- |
| `1`   | northeast | `+1, -1` |
| `2`   | east      | `+1, 0`  |
| `3`   | southeast | `0, +1`  |
| `4`   | southwest | `-1, +1` |
| `5`   | west      | `-1, 0`  |
| `6`   | northwest | `0, -1`  |

The digits run clockwise from northeast, so a direction's opposite is its digit plus 3, wrapping `7`, `8`, and `9` back to `1`, `2`, and `3`. Rotating a path through 180 degrees keeps the digit order and opposes each digit. Retracing a path reverses the digit order and opposes each digit, so `[1, 2]` retraces as `[5, 4]`.

### Target values

Target `0` names nobody. Target `i` names slot `i - 1` of the enemy roster, in the player order that `rosters` already lists them in. Because each side names the other side's roster, the same number means a different unit for Red and for Blue. Pass a unit id to `action.move` or `action.stay` together with the observation and they resolve the slot for you.

### Observation fields

| Field | Content |
| --- | --- |
| `self` | Your unit: `unit_id`, `type`, `position`, `hit_points`, `movement_points`. `movement_points` is always your type's full movement stat, since every activation starts fresh. |
| `visible_units` | Every other unit inside your vision radius, friend and enemy, in player order: `unit_id`, `side`, `type`, `position`, `hit_points`. Your own unit is never in this list. |
| `round` | The current round number, from `1` up to the round cap. |
| `capture` | `red`, `blue`, and `target`. All `0` when capture play is off. |
| `battlefield` | `side`, the width of the square tile array; `tiles`, indexed `tiles[r][q]`, each one a `{"terrain", "feature"}` pair; and `zones`, each a `{"center", "tiles"}` pair covering seven tiles. |
| `rosters` | `red` and `blue`, each a tuple of `{"player", "unit_id", "side", "type"}` in player order, listing every starting unit whether or not it is still alive. |
| `parameters` | The resolved settings: `seat_plan`, `field_extent`, `terrain`, `wasteland`, `unit_abilities`, `capture_zones`, `capture_target`, `round_cap`. The three switches are `0` or `1`. |

Terrain is `grass`, `hill`, `water`, or `void`, and a feature is `none`, `forest`, `marsh`, or `waste`. The tile array is square while the field is a hexagon, so the cells outside the field hold terrain `void`, which is impassable and never appears inside it.

### The action mask

`observation["action_mask"]["path"]` has 1555 entries, one per path id, and `observation["action_mask"]["target"]` has one entry per enemy roster slot plus one for "no target". A `1` allows that value. `env.step` rejects an action whose path or target entry is `0`, and in an official game an illegal action forfeits the seat. The stay bit and the no-target bit are always `1`, so there is always something legal to return.

A `1` in the target array means that unit is alive and visible to you at this moment, so you are allowed to name it. It is not a promise of a hit. Range is checked at resolution, from the tile you actually end on, and a named target out of range falls back to the automatic strike.

## Match settings

Every setting below exists as a gameplay parameter, but you do not pick them. The season your assignment names does, and it decides the seat plan, the field size, whether terrain, unit abilities, and wasteland are on, how many capture zones there are, and whether messaging is available. Your observation carries the resolved values under `parameters`, so an agent can adapt to the match it is actually playing.

| Season | Preset | Seat plan | Field extent | Terrain | Abilities | Capture zones | Wasteland |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1, The Skirmish | `season_1` | `skirmish` | 7 (15 across) | off | off | 0 | off |
| 2, The March | `season_2` | `skirmish` | 7 (15 across) | on | off | 0 | off |
| 3, The Army | `season_3` | `army` | 10 (21 across) | on | on | 0 | off |
| 4, The Commander | `season_4` | `army` | 10 (21 across) | on | on | 1 | off |
| 5, The General | `season_5` | `army` | 10 (21 across) | on | on | 3 | off |
| 6, The Rivals | `season_6` | `army` | 10 (21 across) | on | on | 3 | on |

Field extent is the hex distance from the center tile to the field edge. The capture target stays 200 and the round cap stays 1000 in every season. Messaging is switched by the season itself rather than by these values, so a local run always has it available.

Season 6 scatters wasteland, ground polluted by overuse of magic. Entering one of those tiles costs 2 hit points and never reduces a unit below 1, so wasteland by itself can never kill anything; it just makes a shortcut expensive.

The start dialog offers Season 1 through Season 6 for these settings. In a local student sandbox, pass a preset such as `python -m sandbox play --preset season_4`. A repeated `--parameter` for the same setting wins, and the preset replaces the `season.json` gameplay parameters for that command.

## Time limits

Skirmish at Crane Reach is turn-based, so activations have no fixed delay between them. By default, each call to `act` has a 1-second limit, and your agent may use up to 600 seconds of measured computation during one match. A season may override these limits. If `act` returns late, that unit stands still with `{"path": 0, "target": 0}`, which still strikes when an enemy is in range, so a late unit fights back but takes no ground. By default, a human-controlled unit has 60 seconds to move. See [Time limits](../../docs/students/agent-interface.md#time-limits) for how these limits are measured and enforced.

## Messaging

Messaging is a season setting, on from Season 3 onward. When it is on, your agent may add the optional `chat` method. `agent.py` includes a commented-out one to start from.

The timing is the part that decides what messages are good for. At your activation you are asked for your order first, and only afterwards does `chat` receive everything that arrived since your previous activation. Nothing you read there can change the order you just gave, so the earliest an incoming message can shape your play is your next activation. Store what you hear on your own instance; nothing else remembers it for you.

A direct message goes to one living allied unit, named by its player string such as `"player_2"` rather than by its unit id. A **broadcast**, which is what `None` as the recipient means, is heard by **both sides**, so it warns your enemy at the same time as your ally. A message can hold up to 200 characters, and a season may lower that. A message to a unit that has already been killed is dropped, with a note in the local console. Every message is recorded and readable in replays, so nothing you send is secret.

This complete agent reports its position to its allies on every activation:

```python
from sandbox.crane import action, me, roster
from sandbox.observation_types import SkirmishAction, SkirmishObservation


class Agent:
    def reset(self, seed: int) -> None:
        # Three pieces of memory, cleared before every match: who to write to,
        # what to send them, and what they told us last time.
        self.allies: list[str] = []
        self.report = ""
        self.heard: list[str] = []

    def act(self, observation: SkirmishObservation) -> SkirmishAction:
        # chat never sees the observation, so read here what it will need.
        my_id = me.unit_id(observation)

        # roster.allies is your whole side, so you can write to a unit far out
        # of sight. Address each one by its player string, which is what "to"
        # expects, and leave yourself off the list.
        self.allies = [
            entry["player"] for entry in roster.allies(observation) if entry["unit_id"] != my_id
        ]

        # The text this unit will send once its order is in: who and where.
        here = me.position(observation)
        self.report = f"{my_id} at {here['q']},{here['r']}"

        # Hold position. The order is chosen before chat runs, every activation.
        return action.stay()

    def chat(self, inbox: list[dict]) -> list[dict]:
        # Everything that arrived since this unit's previous activation. Saving
        # it here is the only way the next act call can use it.
        self.heard = [message["text"] for message in inbox]

        # One direct message per ally. Returning [] instead would stay silent.
        return [{"to": ally, "text": self.report} for ally in self.allies]
```

See the [agent interface](../../docs/students/agent-interface.md#chatinbox) for delivery timing, broadcast and targeted messages, replay visibility, and how chat time counts toward your limits.

## Your first improvement

Run `python -m sandbox play` and watch one full match. Every unit walks straight toward the enemy side until something comes into view, then walks straight at the nearest enemy it can see, so the sides collide in the middle and trade blows wherever they meet. Now find your archer. Does it survive, and if it dies, what killed it?

> An archer sees 6 tiles and shoots 6 tiles, which is further than anything else on the field. It also has 6 hit points and a range of 1 is enough to reach it. Something of yours has to be standing between it and whatever is coming.

Now speed your cavalry up. It has 4 movement points and the template only ever takes single steps, so let it take longer paths toward the nearest enemy. It arrives first, and it arrives alone. How many rounds does it last, and what did it cost the other side before it went down?

> Reread the strike rules in [How a match works](#how-a-match-works). Every enemy that ends its own activation with your cavalry as its nearest target in range will strike it, and your cavalry cannot do anything about it between its own turns.

Watch the march itself too. A straight line is a poor plan: two units on rows farther apart than they can see walk right past each other and end up at the far edge of the field. Give them somewhere to aim instead. `tile.at_center(observation)` gathers your side in the middle. `tile.at_mirror(here, observation)` points at the tile opposite your own, which the field's symmetry places in enemy ground, so a side that marches on it sweeps the field rather than crossing it.

That is not the real problem in this game, though, and neither is pathfinding. Your units cannot see each other's intentions. Two units that each walk at the nearest visible enemy are not a formation, they are two units that happen to be moving. What would the footman have to tell the archer, and when, for the archer to know it is about to be covered? Check the timing in [Messaging](#messaging) before you answer, because a message you send now lands in your ally's next activation, after that activation's order is already chosen.

Record the mean score from `python -m sandbox eval` before a change and again afterward, over several seeds. Coordination shows up over whole matches rather than single activations. For a head-to-head comparison, [Getting started, step 4](../../docs/students/getting-started.md#4-play-and-evaluate) explains how to save a rival version and play against it with `--vs`. In Skirmish at Crane Reach your own side keeps running your current agent and the entire enemy side runs the saved one.

When your agent is ready, follow the [submitting guide](../../docs/students/submitting.md) to send it in.
