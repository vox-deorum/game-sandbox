# The RPG Game: Pedagogy Design

Days at Three Branches is the course's believability track. Students make a small village feel alive. Classmates judge that work on the human-rating leaderboard; the automated leaderboard is only a health check.

Every season runs the same village and extends the previous season by one small capability. A submission controls separately running copies of one NPC program, distinguished by player id. NPCs coordinate through [perception and speech](ruleset.md#perception), not shared state.

## Shared evaluation

Every season requires a healthy full episode: the agent loads, completes the day, and avoids crashes and timeouts. This is the automated score and never measures believability or grading.

The human-rating board is the meaningful leaderboard. Each student writes a short prompt about observable behavior, and classmates rate it against the declared design goal from 1 to 5.

## Design pillars

- **Believability over performance:** The question is whether a villager reads as alive, not whether it wins.
- **One familiar village:** Familiarity accumulates and makes each new capability visible.
- **Same code, many characters:** NPC copies share code but not memory. Player id, perception, and messages support coordination.
- **Core and optional techniques:** Core techniques are the material's expected path. Optional techniques are a stretch menu. The syllabus never requires or prohibits a technique.

## The six seasons

### Season 1: Signs of Life (Week 1)

**Unlocks:** The map, props, five NPCs, vision cone, hearing radius, movement, idle emotes, and prop interaction. A human avatar walks the village during peer play. See [ruleset actions](ruleset.md#actions) and [environment visitor input](environment.md#rendering-and-human-input).

**Design issue:** Characters should read as alive and intentional.

**Core:** An FSM for wander, patrol, pursue, flee, and idle; steering.

**Optional:** Behavior-tree interruptible routines, such as a startle that preempts a chore and then resumes it. This becomes core in Season 2.

**Rating prompt:** “Could you tell what my villager wanted at any moment? Rate how alive they felt, 1-5.”

### Season 2: The Village (Week 2)

**Unlocks:** The full cast of 10 NPCs. Each runs a separate instance of the same submission.

**Design issue:** Ensemble storytelling under decentralization.

**Core:** Role assignment from player id; interruptible routines.

**Optional:** None beyond the season's open technique menu.

**Rating prompt:** “Watch for one minute: what mood is this village in? Rate how strongly my declared vibe came through, 1-5.”

### Season 3: The Visitor (Week 3)

**Unlocks:** No new platform capability. Visitor play and [range-limited speech](ruleset.md#speech) were available from Season 1. NPCs now speak and react to a visitor by greeting, following, avoiding, or fleeing with ordinary movement and expression.

**Design issue:** React to an unpredictable human through simple drives such as curiosity, safety, and gossip rather than enumerated scripts.

**Core:** Hand-authored drive or utility reactions layered on Season 2 routines.

**Optional:** None beyond the season's open technique menu.

**Rating prompt:** “Did the village notice you, in ways that fit who each NPC seemed to be? 1-5.”

### Season 4: Village Life (Week 4)

**Unlocks:** The `daynight` variant and visible day phase. See [ruleset phases](ruleset.md#the-daynight-variant-season-4-onward).

**Starter material:** A course-distributed worked example provides routine-library routing among village places, day-phase schedules, and visitor reactions. Students may copy, edit, replace, or ignore it in favor of Season 3 behavior.

**Design issue:** A village that follows a daily life while staying reactive. Season 3 peer feedback identifies gaps between intended and perceived behavior.

**Core:** Day schedules built on the starter routine library, with routes among home, well, and market; revised reactions.

**Optional:** Per-NPC memory of repeat encounters; rumors spreading through messages.

**Rating prompt:** “Walk around for two minutes. Rate how much the village felt like it had a life of its own while still noticing you, 1-5.”

### Season 5: The Conversation (Week 5)

**Unlocks:** Platform LLM access with a per-student budget. Freeform visitor chat already exists; the new capability is an in-character answer.

**Design issue:** Grounded dialogue that stays in character and refers only to true world state.

**Core:** Persona and world-state prompting; canned fallbacks after budget exhaustion. The health check includes budget compliance.

**Optional:** Structured output that binds dialogue to action, such as “follow me” followed by movement; per-player retrieval memory.

**Rating prompt:** “Talk to my innkeeper. Rate how in-character and connected to the real village the conversation stayed, 1-5.”

### Season 6: The Living Village (Week 6)

**Unlocks:** Nothing new. Routines, reactions, memory, and chat operate together.

**Design issue:** An open brief combining the reactive village from Seasons 3 and 4 with Season 5 dialogue. Students define what “more interactive” means for their village.

**Core:** The student's declared interaction goal.

**Optional:** Chat that reflects observed player actions, dialogue that changes later behavior, player rumors surfacing in dialogue, or a small player-reactive staged event.

These are leads, not requirements.

**Rating prompt:** “Spend five minutes in my village. Rate how much it felt like a world that noticed and responded to you, 1-5.”

## Progression

- Seasons 1 and 2 turn one recognizable character into a decentralized citizen template for the full cast.
- Seasons 3 and 4 introduce the visitor, then daily life around the visitor. Week 4 is a tactical-focus week with a small RPG addition.
- Seasons 5 and 6 add dialogue, then open the brief to combine every layer.
