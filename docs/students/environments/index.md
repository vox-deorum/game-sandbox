# Environments

An **environment** is a game your agent can play. Each environment has its own actions, observations (the game information your agent receives), and scoring. The code you write in `act` therefore depends on your environment.

Start with your environment page. It explains the working agent in your template, its helper module, scoring, time limits, and every raw action and observation value. Use it with the [agent interface](../agent-interface.md), which covers the parts that are the same in every game.

| Environment | About | Action | Template branch |
| --- | --- | --- | --- |
| [Hearts](hearts.md) | Four-player trick-taking card game | An int `0..51` naming the card to play | `templates/hearts` |
| [Spades](spades.md) | Four-player partnership bidding-and-trick card game | An int: a bid `52..65` while bidding, or a card `0..51` in play | `templates/spades` |
| [Flappy Bird](flappy-bird.md) | Single-player game of flying through pipes | `0` to do nothing or `1` to flap | `templates/flappy_bird` (the default) |

Each environment is published on a `templates/<env>` branch of your student repository. A **branch** is a separate version of a Git repository. Some environments also have worked examples on `examples/<env>/<name>` branches. Flappy Bird is the default template on the main branch.

These branches appear after your instructor publishes a template release. They are not folders in the Game Sandbox source repository. If you do not see them, ask your instructor which repository and branch to use.
