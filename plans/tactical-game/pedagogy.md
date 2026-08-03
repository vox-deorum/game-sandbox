# The Tactical Game: Pedagogy Design

The tactical game is the course's performance track. Students design game AI that wins team battles, judged mainly by the automated leaderboard (the ladder). Grade credit is anchored to beating instructor baseline bots, not peer rank; the ladder itself is for glory.

Game format: the game runs in rounds. Every living unit acts once per round, in an order reshuffled each round. A unit selects its order from its current observation, receives any inbox messages after that selection, and then its selected order resolves immediately. Each submission is code for one individual unit; a team is separately constructed instances of that code running independently, with no shared controller or shared memory. Coordination happens through observations, stable unit IDs, and delayed unit-to-unit messages only.

The arc across the six seasons: Season 1 builds the first tactical blocks (small reusable scripted behaviors). Season 2 makes those blocks move well through terrain. Season 3 scales them into an army and grows the block library. Season 4 opens the strategic view: search assigns each unit a tactical block and a goal. Seasons 5-6 train that same assignment policy, first with imitation learning and then with reinforcement learning. No LLM anywhere in this track.

## Design pillars

- Performance over polish: the ladder decides, and the design skill is building competence that survives contact with classmates' armies
- Tactical blocks as the unit of design: students accumulate a library of small scripted behaviors, then search and learning techniques select and assign them from Season 4 onward
- No centralized commander: every unit instance runs the same strategic assignment policy and tactical blocks from its own local state. Coordination must come from IDs, unit types, observations, and delayed unit-to-unit messages
- Core and optional: each season lists core techniques (the path the season materials assume) and optional techniques (a stretch menu); per the syllabus, no technique is ever required or off-limits

## The six seasons

### Season 1: The Skirmish (Week 1)

- What unlocks: a small open arena, 3v3 with three unit types (one archer, one cavalry, one footman per side); round-based turns with randomized unit order; move, attack, and health profiles per unit type.
- Design issue: building the first tactical blocks: one scripted behavior per unit type that plays to its strengths. The archer falls back and fires in the same activation. The cavalry circles to strike from the flank. The footman holds the line.
- Core techniques: steering behaviors plus an FSM per unit type.
- Optional: behavior-tree priorities; utility target scoring.
- Evaluation: ladder plus instructor baseline bots (bronze/silver/gold anchor the grade credit); light human rating on a declared style.

### Season 2: The March (Week 2)

- What unlocks: terrain on a generated map: water passages, hills, forests, and marshes, with movement priced by terrain.
- Design issue: moving well in battle: kite routes, disengage paths, using terrain, not cornering yourself.
- Core techniques: pathfinding-driven movement inside the tactical blocks (path_to routes that respect terrain costs).
- Optional: formation movement with allies (arrive together, keep spacing).
- Evaluation: ladder plus baselines.

### Season 3: The Army (Week 3)

- What unlocks: the army: about 20 units per side in a mix of the three types; unit-to-unit messages (a unit can send a short message to a specific allied unit, arriving on its next activation); the cavalry charge and the footman shield wall.
- Design issue: what tactical blocks does an army need, and who runs which.
- Core techniques: a small library of reusable tactical blocks; role and block assignment from the agent ID and unit type.
- Optional: a small message protocol (target calls, retreat signals: the same messaging that spreads rumors in the village carries kill calls here); formation steering.
- Evaluation: full-team ladder plus baselines; rating, e.g. "Watch the opening minute: do they look like a unit executing a plan rather than 20 strangers, 1-5?"

### Season 4: The Commander (Week 4)

- What unlocks: the strategic view and a single capture point that scores over time. In the strategic view, each unit instance selects a tactical block and a tactical goal, such as hold this choke or attack this point, from its own observation and local memory.
- Starter template: a small set of predefined tactical blocks provides a working action space for the strategic layer. Students may edit those blocks, replace them, or reuse their own Season 3 blocks.
- Design issue: decentralized strategy as assignment: which units should do what and where, and when should those assignments change as the battle turns, without a shared controller?
- Core techniques: search-based lookahead in each unit's local policy over its own tactical block and goal for the next few rounds. The instances coordinate through their observations, IDs, and delayed messages, while the selected blocks handle moment-to-moment movement and battle.
- Evaluation: capture-point ladder plus baselines.

### Season 5: The General (Week 5)

- What unlocks: the map holds three objectives at once, so the army must split and reconsider assignments as objectives change hands. This is the course's first training season.
- Design issue: replacing repeated local strategic search with a learned assignment policy that can choose a tactical block and goal quickly for each unit instance.
- Core techniques: imitation learning over the Season 4 decentralized strategic interface, using decisions from the student's Season 4 search agent or human play as demonstrations. Human play can control any of the seat's units, so those demonstrations cover the controlled units' decision streams. Agent-generated demonstrations can cover every unit role.
- Optional: an early start on reinforcement learning ahead of Season 6.
- Evaluation: ladder plus baselines. Advise a modest compute cap; scripted submissions remain fully legitimate. Rating, e.g. "Watch one match: could you spot the plan, who was sent where and why, 1-5?"

### Season 6: The Rivals (Week 6)

- What unlocks: nothing new; deliberately light because the design document draft is due the same week. After five seasons, the field of opponents is well known.
- Design issue: robustness and counter-strategy against a known field of named opponents, with each unit policy still acting from separate local state.
- Core techniques: reinforcement learning over the same decentralized strategic assignment interface established in Season 4, with reward design shaping it (what you reward is what you get); self-play plus adversarial training against the strongest available pools. A unit receives no later learning hook after it dies, so training that assigns the eventual team outcome to that unit consumes the completed episode result outside the per-step hook.
- Optional: evolutionary methods to tune block parameters or assignment heuristics.
- Evaluation: ladder standings, as every season.

## How the seasons pair

- Seasons 1-2: Season 1 builds the first blocks; Season 2 teaches them to move through terrain.
- Seasons 3-4: Season 3 grows the blocks into an army library; Season 4 places them under a strategic search layer. The provided blocks offer an on-ramp, while the Season 3 blocks offer continuity.
- Seasons 5-6: Season 5 learns to imitate strategic assignments; Season 6 improves the same assignment policy with reinforcement learning.
