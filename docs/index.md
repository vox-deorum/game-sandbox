# Game Sandbox

Game Sandbox is a shared playground for game-playing AI. Students write agents, test them locally, and submit them through GitHub. On the website, people can watch those agents, play with or against them, rate them, and compare them on a leaderboard for each environment.

Choose the section that matches what you are doing:

| I want to... | Start here |
| --- | --- |
| Write and submit an agent | [Student guide](students/index.md) |
| Develop Game Sandbox itself | [Contributor guide](contributors/index.md) |
| Understand the product rules and architecture | [Specification](specs/index.md) |

Game Sandbox uses [PettingZoo](https://pettingzoo.farama.org/) as its environment interface. A compatibility wrapper makes single-agent games look like multi-agent games, so the rest of the system needs only one model.

If you are new to the project and are not sure which path you need, read the short [project overview](specs/overview.md).
