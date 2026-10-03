# Player Identity

Status: complete and current. Crane Reach, Three Branches, and Spades ship the renderer hook, and the chat panel, the replay thread, and the decision log read it. The seat and attribution strips keep plain compact ids.

## Goal

The host chrome names players by their compact id (`P7`) while each game calls the same players something else. In Crane Reach every unit is its own player, so the board chip says `S0_cavalry_5` while chat says `P7`. In Three Branches the nameplate says `player_3` while chat says `P3`. Nothing connected the two, so a viewer could not tell which unit sent a message or made a decision. A busy chat row also said where a message went but not whose sender it was: one of the viewer's own players, a teammate, or an opponent.

The fix is one general mechanism with a per-game implementation:

- A renderer may describe its players with a profile (an in-game name, a team, or both) and may highlight one when the host asks.
- The host shows each sender's profile name in chat, colors every sender label by whose that player is, badges every message by its recipient, and gives every compact `P#` in chat and decision rows a tooltip and a highlight.
- Crane Reach profiles every unit by name and side, Three Branches names its characters, and Spades declares its partnerships. Flappy Bird and Hearts report nothing: their sender labels stay the shared attribution labels, their compact ids stay plain text, and no sender colors as an ally.

## Mechanism

The chat panel and the replay thread read like this:

```text
Crane Reach, viewer controls P0 (side red)
  P0 S0_footman_0  [to P1]      tick 4    <- mint label: your own player
  P2 S0_archer_1   [broadcast]  tick 5    <- sky blue label: same side as you
  P7 S1_cavalry_0  [to you]     tick 6    <- plain label, accent badge
     hovering P1 inside the badge shows "S0_archer_0" and highlights that unit
Replay of someone else's game, or spectating: no "you", no side, every label plain
```

The badge answers "to whom", and the color answers "whose". The in-game name moves into the sender slot, and `P#` becomes the link back to the game frame: the row's leading id and the badge's id are the same control, each naming its player on hover and highlighting it in the frame. Names follow the environment's `side_type_index` unit ids with the color prefix replaced by the owning seat's compact label, and the mockup seats eight players, four per side (footman, two archers, cavalry), so red's footman and archers read `S0_footman_0`, `S0_archer_0`, and `S0_archer_1`.

### The renderer contract

`RendererInstance` in `frontend/src/renderers/types.ts` takes two optional members:

- `playerProfiles(state)` returns a player id to `PlayerProfile` map as a pure function of one state, for example `player_7` reading `{ name: 'S0_cavalry_5', team: 'red' }`. A profile's `name` is the in-game name, which names a role and never a person. Its `team` is any key shared by players on the same side, such as a Crane Reach side or a Spades partnership, and a player without a team is nobody's ally. Taking the state keeps the hook deterministic, with no timing coupling to animated renders.
- `highlightPlayer(playerId | null)` emphasizes one player's figure in the game frame, or clears the emphasis with `null`. It is view-only: it never sends an action, and it must not reveal anything the frame would otherwise hide.

Purity and the attribution rule apply to both profile fields: neither may identify a person or submission the host's attribution policy hides, because a reported name replaces the host's attribution label and would otherwise bypass blind masking. A renderer that implements neither hook is whole: the host keeps its own labels, plain compact ids, and colors nobody as an ally.

### Host plumbing

`useRendererMount` recomputes the profiles from every relayed state and replaces the map only when some player's name or team changes, so rows that read the profiles do not recompute on every tick of a game whose profiles are fixed. It then provides the profiles, together with the highlight, to the page's chrome through `providePlayerIdentity` (`frontend/src/composables/usePlayerIdentity.ts`). Every page that mounts a renderer (session, replay, local play) gets the support with no page edits. Outside a provider, an isolated component or a jsdom test sees empty profiles and a highlight that does nothing.

`PlayerTag` (`frontend/src/components/PlayerTag.vue`) renders the compact id wherever the chrome names a player: the sender id and the recipient id inside a badge of a `ChatPanel` row, the message, decision, and setup rows of `GameThread`, and the player cells of `DecisionLog`. When the renderer reports a name for that player, the id is a `UiTooltip` trigger showing it, and hovering or focusing the id highlights the player in the game frame. Hover and focus hold the highlight independently, so the pointer leaving a keyboard-focused id keeps it, and it clears only once the id is neither hovered nor focused, or the row unmounts. Without a name it is plain text.

The renderer has one highlight and the page has many tags, so `sharedHighlight` in `usePlayerIdentity.ts` arbitrates between them. Each tag requests a player under its own source, the latest request wins, and withdrawing one falls back to the newest request still standing. Hovering a second id while the first stays focused therefore moves the highlight to the hovered player and back again, and one tag can never clear another's highlight.

### Sender tones

`senderIdentity` in `frontend/src/lib/chat.ts` gives each message's sender a label and a tone. The label is the in-game name when the renderer reports one (`S0_cavalry_5`) and the shared attribution label otherwise, so the blind policy still governs games without names. The tone colors the label, and it applies in every game, profiled or not, so ownership reads the same everywhere:

- own, mint `--color-accent`: a player the viewer controls, or that the recording header attributes to the viewer's user. On the session page this is the viewer's identity in the match rather than live control, so it survives the session ending. Color is what carries ownership, because an in-game name never says "Your agent".
- ally, sky blue `--color-ally`: a player whose reported team matches the team of one of the viewer's own players.
- other, the plain text color: everyone else.

A spectator, or a replay of someone else's game, owns no players, so no sender reads as own, and without own players there is no team to share, so none reads as an ally either. `--color-ally` is a semantic token in `frontend/src/styles/tokens.css`, defined as `var(--palette-sky-400)` and shown on the dev-only `/styleguide` swatch grid.

### Recipient badge

`messageBadge` in the same module badges every message by its recipient alone, never by its sender. A line to everyone takes a neutral `broadcast` badge, a line addressed to one of the viewer's players takes the accent `to you` badge, and any other addressee gets a neutral `to P#` badge whose compact id is itself a `PlayerTag`, with the same tooltip and board highlight as the sender's id. The viewer's own sends are therefore badged by recipient like anybody else's, which keeps two players sharing one agent label distinguishable and lets the badge answer its only question. Own players are decided exactly as for the sender tone, so a replay of the viewer's own game still badges a line to their player `to you`, while a replay of someone else's game badges only `broadcast` or `to P#`. The composer's recipient selector labels a player `P1 · <name>` when a name exists.

### Crane Reach

In `environments/skirmish_crane/renderer/`, the profiles cover every roster slot, alive or dead, since both rosters are standing knowledge. The header's seat plan alone fixes the rosters, so `rosterForHeader` builds them from the static overlay once per game, without decoding any state. Every slot reports `{ name: unitDisplayName, team: side }`, the recorded unit id with its color prefix replaced by the owning seat's compact label, so `red_cavalry_5` of `player_7` reads `S0_cavalry_5` on team `red`. The unit hover chip carries the same pairing, with the compact player id appended: `S0_cavalry_5 · P7`. Because the side doubles as the chat team, a viewer who controls any red unit sees every other red sender in ally blue.

`highlightPlayer` inspects the player's unit exactly as a pointer hover would: the bone ring, the chip, and the range wash. The inspection state ranks this host focus below a board pointer hover and above a roster hover and the pinned target, so a canvas hover and a chat hover never overwrite each other. A unit the perspective cannot see, or one that has died, shows nothing, so the host never reveals what the frame hides. The renderer keeps the requested player rather than its unit, and every scene reconciliation resolves that player against the units it draws, so an enemy whose id stays focused while it is hidden takes the focus on the turn the fog reveals it, and loses it again if the fog closes.

### Three Branches

In `environments/three_branches/renderer/`, the profiles echo the raw player id (`player_3` reads `player_3`), the same text the nameplate prints, so the chat sender and the board always agree. The village is one visitor among neighbors, so it reports no teams and its chat colors no allies.

`highlightPlayer` outlines that character's nameplate with a 2 px gilt stroke and holds it at full opacity at every zoom, so the character can be found even when the camera sits below the nameplate fade band. The expression marker keeps its own zoom gate, so a forced plate never shows a pictogram the camera would hide. A hover that arrives before the renderer has presented its first state waits, and the first annotation redraw outlines the plate.

### Spades

In `environments/spades/renderer/`, the profiles carry teams only: `player_0` and `player_2` share partnership `0`, and `player_1` and `player_3` share partnership `1`, the same pairing the table paints with its two team tints. With no names reported, Spades sender labels stay the shared attribution labels and its compact ids stay plain text, while a partner's messages read in ally blue.

## Tests

- The jsdom player-identity suite covers `PlayerTag` (plain text without a name; the tooltip and the highlight calls on hover and focus, cleared on leave, blur, and unmount; a focused id keeping its highlight when the pointer leaves it), `sharedHighlight` (the latest request wins, withdrawing falls back to the newest one standing, and a tag that holds nothing never clears another's), the `senderIdentity` tone cases (in-game name preferred, attribution label as fallback, own through live control or header attribution and failing closed for an anonymous viewer, ally only beside one of the viewer's own players' teams, and no own or ally senders at all for a spectator or a replay of someone else's game), and the `messageBadge` recipient cases (`broadcast`, `to you`, `to P#`, and `to you` through header attribution on a replay).
- The chatpanel, gamethread, session, and decision-log suites read those helpers on the painted rows: every row badges by recipient, the `to P#` badge's compact id is a `PlayerTag` carrying the same tooltip and highlight as the sender's, decision-row and log player cells stay named tags, and `useRendererMount` replaces profiles only when a name or team changes and forwards the highlight. The session suite keeps the ended-session case where the owner's own senders stay colored and lines addressed to them stay badged `to you` after control drops.
- Renderer tests cover Crane Reach's roster profiles over the whole roster, alive or dead (every slot named by its seat-prefixed unit id and teamed by its side), its focus priority under pointer hover, the fog and dead-unit drop, a held request taking the focus once the fog reveals its unit, dismissal clearing the focus, and the `· P#` chip title; Spades' partnership check (`player_0` paired with `player_2`, `player_1` with `player_3`, and no names reported); and Three Branches' highlighted plate stroke and its full opacity at low zoom. Three Branches' profiles echo the header's expected ids and have no dedicated test, since no test mounts that renderer.
- The browser suite's Crane Reach journey asserts the chip title as `S0_…` or `S1_…` followed by ` · P<n>`. The Spades journey asserts the recipient badges on the human's exchanged lines, on the live panel and in the merged replay thread. The hover-to-highlight wiring needs no new journey because jsdom covers it.

## Files

- `frontend/src/renderers/types.ts` declares the `playerProfiles` and `highlightPlayer` hooks and the `PlayerProfile` shape.
- `frontend/src/composables/useRendererMount.ts` and `frontend/src/composables/usePlayerIdentity.ts` carry the profiles and the highlight from the renderer to the chrome.
- `frontend/src/components/PlayerTag.vue`, `ChatPanel.vue`, `GameThread.vue`, and `DecisionLog.vue` render the surfaces.
- `frontend/src/lib/chat.ts` and `frontend/src/lib/attribution.ts` hold the shared sender label, tone, and recipient badge rules.
- `frontend/src/styles/tokens.css` defines `--color-ally`, and `frontend/src/pages/StyleguidePage.vue` shows the token on `/styleguide`.
- The environment renderers under `environments/` implement the hook: `skirmish_crane/renderer/`, `three_branches/renderer/`, and `spades/renderer/`.
- [Rendering](../docs/contributors/environments/rendering.md) states the contract for environment authors, and [Interaction](../docs/specs/interaction.md#chat) states what a viewer sees.
