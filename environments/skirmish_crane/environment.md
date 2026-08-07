# Skirmish at Crane Reach

Skirmish at Crane Reach is a turn-based tactics game on a hex field. Your team wins by defeating the other side, reaching the capture target when capture zones are enabled, or leading when the round limit ends. The shared [agent interface](../../docs/students/agent-interface.md) explains the `reset` and `act` methods used by every environment.

## Seats and units

The default `skirmish` plan has two seats with three units each. The `army` plan has two seats with twenty units each. Game Sandbox creates a separate `Agent()` object for every unit, even when one submission controls a whole seat. Store only that unit's own state in the object, or use the optional messaging interface to coordinate with teammates.

## Your turn

On a unit's turn, `act` receives a dictionary with `observation` and `action_mask` keys. Return a dictionary with a path and a target choice:

```python
def act(self, observation: SkirmishObservation) -> SkirmishAction:
    return {"path": 0, "target": 0}
```

`path: 0` means stay in place. `target: 0` leaves no named target, so the game may automatically strike a nearby enemy. This order is always legal, so the template starts there.

The observation and action shapes above are available as the `SkirmishObservation` and `SkirmishAction` types, importable from `sandbox.observation_types`, for editors and type checkers.

The action mask has matching `path` and `target` arrays. An entry of `1` is legal and an entry of `0` is not. Choose each value only from the matching allowed entries. The two choices are independent, so any allowed path and any allowed target may be returned together.

## What a unit can see

`observation["observation"]` contains your unit under `self`, visible enemy and friendly units under `visible_units`, the current `round`, capture scores, battlefield tiles and zones, team rosters, and the resolved match parameters. Positions use axial hex coordinates with `q` and `r` fields.

Use the visible units to decide whether to approach, retreat, or attack. The action mask is the authority for which paths and targets are legal on this turn.

## Match settings

Seasons may choose the `skirmish` or `army` seat plan and adjust field size, terrain, wasteland, unit abilities, capture zones, capture target, and round cap. Your observation includes the resolved values, so an agent can adapt to the match it is playing.

The start dialog offers Season 1 through Season 6 presets for these settings. In a local student sandbox, pass a preset such as `python -m sandbox play --preset season_4`; a repeated `--parameter` for the same setting wins and the preset replaces the `season.json` gameplay parameters for that command.

When wasteland is on, a unit that enters a wasteland tile takes 2 damage. This damage never reduces the unit below 1 hit point, so wasteland alone can never remove a unit.

## First improvement

Start by reading `visible_units`. When an enemy is visible, choose a legal path that moves your unit closer while keeping `target: 0`. Then compare the legal target entries with the visible unit list and make attacks when a target is allowed.
