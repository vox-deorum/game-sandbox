# The RPG Game: Pedagogy Design

The RPG game is the course's believability track. Students design game AI that makes a small village feel alive, and their work is judged mainly by classmates through the human-rating leaderboard. The automated leaderboard serves only as a health/robust check: its rank does not measure believability.

The world is one village throughout. Each season foregrounds one small capability that motivates that week's techniques, introduced explicitly that week. Every season builds directly on the previous one: a small delta, never a rebuild.

## Design pillars

- Believability over performance: the question is always "does this read as alive," not "does this win"
- One village throughout: familiarity compounds, and each season's new capability stands out
- Same code, many characters: when the submission controls multiple NPCs, every copy runs the same code, differentiated only by the ID it reads from its observation; coordination happens through perception and messages
- Core and optional: each season lists core techniques (the path the season materials assume) and optional techniques (a stretch menu); per the syllabus, no technique is ever required or off-limits

## The six seasons

### Season 1: Signs of Life (Week 1)

- What unlocks: the village map and its props. A human player avatar can walk the village (peer reviewers play it during peer play). The scene holds 5 NPCs. Perception is a vision cone and a hearing radius. Actions: move, idle emotes, prop interaction.
- Design issue: characters reading as alive and intentional.
- Core techniques: an FSM for basic behaviors (wander, patrol, pursue, flee, idle); steering.
- Optional: behavior-tree interruptible routines (a startle preempts a chore, then resumes). This becomes core in Season 2.
- Evaluation: health check; human rating, e.g. "Could you tell what my villager wanted at any moment? Rate how alive they felt, 1-5."

### Season 2: The Village (Week 2)

- What unlocks: the full cast. The submission now controls the whole cast of 10 NPCs: same code per NPC, each copy running as its own agent instance.
- Design issue: ensemble storytelling under decentralization.
- Core techniques: role assignment from the NPC ID; interruptible routines (promoted from Season 1).
- Evaluation: health check; human rating, e.g. "Watch for one minute: what mood is this village in? Rate how strongly my declared vibe came through, 1-5."

### Season 3: The Visitor (Week 3)

- What unlocks: nothing new; speech and the visitor are live from Season 1. NPCs start speaking lines, which only nearby characters receive, and build a small set of player-facing reactions (greet, follow, avoid, flee) from ordinary locomotion and expression.
- Design issue: reactivity to an unpredictable human. Characters are defined by simple drives (curiosity, safety, gossip) rather than by enumerating scripts.
- Core techniques: hand-authored drive/utility reactions layered on the Season 2 routines.
- Evaluation: health check; human rating from live play, e.g. "Did the village notice you, in ways that fit who each NPC seemed to be? 1-5."

### Season 4: Village Life (Week 4)

- What unlocks: day and night. The daynight variant turns on, and every character observes the day phase.
- Starter material: a worked example, distributed by course operations when the season opens, provides a routine library (routing between the village's places, day-phase schedules, and the visitor reactions) as the working action space for the season's schedules. Students may copy it, edit or replace the routines, or reuse their own Season 3 behavior.
- Design issue: a village that keeps living around the player. NPCs go about their day while staying reactive, and Season 3 peer feedback shows where intended and perceived behavior diverged.
- Core techniques: day schedules built over the starter routine library, with routing between home, well, and market handled by that example; deepened player reactions revised from Season 3 feedback.
- Optional: per-NPC memory of repeat encounters; rumor about the player spread through messages.
- Evaluation: health check; human rating, e.g. "Walk around for two minutes. Rate how much the village felt like it had a life of its own while still noticing you, 1-5."

### Season 5: The Conversation (Week 5)

- What unlocks: platform-provided LLM access with a per-student budget. The player's freeform chat is live from Season 1; the new capability is answering it in character.
- Design issue: grounded dialogue: staying in character and referring only to true world state.
- Core techniques: persona plus world-state prompting; canned fallbacks when the budget runs out.
- Optional: structured output binding dialogue to action (an NPC that says "follow me" then actually walks); retrieval memory per player.
- Evaluation: health check including budget compliance; human rating, e.g. "Talk to my innkeeper. Rate how in-character and connected to the real village the conversation stayed, 1-5."

### Season 6: The Living Village (Week 6)

- What unlocks: nothing new. Everything from Seasons 1-5 is live at once: routines, reactions, memory, chat.
- Design issue: an open brief. Combine the reactive village (Seasons 3-4) with LLM dialogue (Season 5) to make the world more interactive as a whole. Students declare what "more interactive" means for their village; how they get there is not constrained.
- Leads, not requirements: NPCs whose chat reflects what they saw the player do; conversations that change behavior afterward ("follow me," then actually walking); rumors about the player surfacing in dialogue; a small staged event that reacts to the player.
- Evaluation: health check; human rating, e.g. "Spend five minutes in my village. Rate how much it felt like a world that noticed and responded to you, 1-5."

## How the seasons pair

- Seasons 1-2: the Season 1 character becomes the citizen template for the Season 2 cast.
- Seasons 3-4: Season 3 brings the player in; Season 4 simply extends the reactive village with daily life. Week 4 is a tactical-focus week, so the RPG delta stays small.
- Seasons 5-6: Season 5 builds the dialogue layer; Season 6 opens the brief to combine it all.

## Evaluation stance

- The automated leaderboard ranks by episode score like every environment, but here the score only reflects run health: the agent loads, completes the full episode, and has no crashes or timeouts. That rank does not matter for grading and never measures believability.
- The human-rating leaderboard is this game's real leaderboard. Students author a short observable-behavior rating prompt each season, and classmates rate against the declared design goal.
