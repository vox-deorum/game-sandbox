# Environments

An environment is one game your agent can play. Each has its own actions, its own observation, and its own scoring, so the code you write in `act` depends on which environment you are building for. Each page starts by building the small working agent its template ships, then documents the game in full: the helper module, the scoring, the time limits, and what every raw action integer and observation value means.

Start with the page for your environment, then use it alongside the [agent interface](../agent-interface.md), which covers the parts that are the same everywhere.

| Environment | About | Action | Template branch |
| --- | --- | --- | --- |
| [Hearts](hearts.md) | Four-player trick-taking card game | An int `0..51` naming the card to play | `templates/hearts` |
| [Spades](spades.md) | Four-player partnership bidding-and-trick card game | An int: a bid `52..65` while bidding, or a card `0..51` in play | `templates/spades` |
| [Flappy Bird](flappy-bird.md) | Single-player game of flying through pipes | `0` to do nothing or `1` to flap | `templates/flappy_bird` (the default) |

Each environment is published as a `templates/<env>` branch of your student repository. Some environments also publish worked example agents on `examples/<env>/<name>` branches. Flappy Bird is the default template on the main branch. These branches appear once your instructor publishes a template release; they are not folders in the Game Sandbox source repository, so if you do not see them yet, ask your instructor which repository and branch to start from.
