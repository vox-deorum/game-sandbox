# Game Sandbox

Game Sandbox is a shared playground for game-playing AI. Students write agents, test them locally, and submit them through GitHub. The website lets people watch those agents, play with or against them, rate them, and compare them on per-environment leaderboards.

Choose the section that matches what you are doing:

| I want to... | Start here |
| --- | --- |
| Write and submit an agent | [Student guide](students/index.md) |
| Develop Game Sandbox itself | [Contributor guide](contributors/index.md) |
| Understand the product rules and architecture | [Specification](specs/index.md) |

Game Sandbox uses [PettingZoo](https://pettingzoo.farama.org/) as its environment interface. A compatibility wrapper gives single-agent games the same shape as multi-agent games, so the rest of the system uses one model.

If you are new to the project and are not sure which path you need, read the short [project overview](specs/overview.md).
